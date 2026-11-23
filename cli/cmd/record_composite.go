package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/output"
)

// 本文件是 record 的两个「复合命令」：clear-orphans（多片游标循环）与 watch（轮询去重）。
// 两者的共同点是：CLI 侧持状态、服务端无状态，所以计数累加与去重都必须在这里做对。

// orphanStats 是 GET /record/clear-orphans/stats.json 的响应（recordController.orphanStats）。
type orphanStats struct {
	PayloadTotal  int `json:"payload_total"`
	ActivityTotal int `json:"activity_total"`
	PageSize      int `json:"page_size"`
	MaxPageSize   int `json:"max_page_size"`
}

// orphanStep 是 POST /record/clear-orphans/step 的响应。
//
// 游标字段是 next_after_key / next_after_activity_id（不是请求里的 after_key），
// 下一片必须原样回传这两个值，否则会重复扫描或漏扫。
type orphanStep struct {
	NextAfterKey        any  `json:"next_after_key"`
	NextAfterActivityID any  `json:"next_after_activity_id"`
	ScannedPayloads     int  `json:"scanned_payloads"`
	DeletedPayloads     int  `json:"deleted_payloads"`
	ScannedActivities   int  `json:"scanned_activities"`
	DeletedActivities   int  `json:"deleted_activities"`
	Done                bool `json:"done"`
}

// orphanSummary 是 clear-orphans 的最终汇总（--json 时打到 stdout）。
type orphanSummary struct {
	PayloadTotal        int    `json:"payload_total"`
	ActivityTotal       int    `json:"activity_total"`
	ScannedPayloads     int    `json:"scanned_payloads"`
	DeletedPayloads     int    `json:"deleted_payloads"`
	ScannedActivities   int    `json:"scanned_activities"`
	DeletedActivities   int    `json:"deleted_activities"`
	Steps               int    `json:"steps"`
	Done                bool   `json:"done"`
	AbortedAtStep       int    `json:"aborted_at_step,omitempty"`
	AbortedErrorMessage string `json:"aborted_error,omitempty"`
}

func (a *App) newRecordClearOrphansCmd() *cobra.Command {
	var limit int
	cmd := &cobra.Command{
		Use:   "clear-orphans",
		Short: "分片清理孤儿 payload / activity（stats + step 游标循环，默认超时 5m/片）",
		Long: destructiveLongWithSafety(`清理「没有对应 record 的 payload / activity」。
流程：先 GET /record/clear-orphans/stats.json 取分母，再按服务端返回的游标
（next_after_key / next_after_activity_id）循环 POST /record/clear-orphans/step 直到 done=true。

服务端不保存任何进度（游标由本命令持有），所以：
  - 中途失败不会假装完成——已完成的计数照实报出，退出码 1；
  - 进度只写 stderr，--json 时 stdout 只输出一份最终汇总。
`),
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := a.requireDestructive("清理全部孤儿 payload / activity"); err != nil {
				return err
			}
			if limit < 0 {
				return client.Usagef("--limit 不能为负数，实际为 %d", limit)
			}
			return a.runClearOrphans(cmd, limit)
		},
	}
	cmd.Flags().IntVar(&limit, "limit", 0, "每片扫描条数（0 = 用服务端 page_size；上限为服务端 max_page_size）")
	return cmd
}

func (a *App) runClearOrphans(cmd *cobra.Command, limit int) error {
	p := a.Printer()

	resp, err := a.apiCallLong(cmd, http.MethodGet, "/record/clear-orphans/stats.json", nil)
	if err != nil {
		return err
	}
	var stats orphanStats
	if err := resp.Unmarshal(&stats); err != nil {
		return err
	}
	if limit == 0 {
		limit = stats.PageSize
	}
	if stats.MaxPageSize > 0 && limit > stats.MaxPageSize {
		p.Info("--limit %d 超过服务端上限，按 %d 处理", limit, stats.MaxPageSize)
		limit = stats.MaxPageSize
	}

	p.Info("孤儿总量：payload %d 条 / activity %d 条，每片 %d", stats.PayloadTotal, stats.ActivityTotal, limit)

	sum := orphanSummary{PayloadTotal: stats.PayloadTotal, ActivityTotal: stats.ActivityTotal}
	var afterKey, afterActivityID any
	for {
		body := map[string]any{"limit": limit}
		if afterKey != nil {
			body["after_key"] = afterKey
		}
		if afterActivityID != nil {
			body["after_activity_id"] = afterActivityID
		}
		var step orphanStep
		resp, err := a.apiCallLong(cmd, http.MethodPost, "/record/clear-orphans/step", body)
		if err != nil {
			// 关键：不静默当成完成，也不吃掉已经发生的删除
			sum.AbortedAtStep = sum.Steps + 1
			sum.AbortedErrorMessage = err.Error()
			a.emitOrphanSummary(sum)
			return fmt.Errorf("第 %d 片失败，已删除 payload %d / activity %d（未完成，服务端可能已部分执行）：%w",
				sum.AbortedAtStep, sum.DeletedPayloads, sum.DeletedActivities, err)
		}
		if err := resp.Unmarshal(&step); err != nil {
			sum.AbortedAtStep = sum.Steps + 1
			sum.AbortedErrorMessage = err.Error()
			a.emitOrphanSummary(sum)
			return fmt.Errorf("第 %d 片响应无法解析（未完成任务）：%w", sum.AbortedAtStep, err)
		}

		sum.Steps++
		sum.ScannedPayloads += step.ScannedPayloads
		sum.DeletedPayloads += step.DeletedPayloads
		sum.ScannedActivities += step.ScannedActivities
		sum.DeletedActivities += step.DeletedActivities
		p.Info("第 %d 片：payload 扫描 %d/删除 %d，activity 扫描 %d/删除 %d",
			sum.Steps, step.ScannedPayloads, step.DeletedPayloads, step.ScannedActivities, step.DeletedActivities)

		afterKey, afterActivityID = step.NextAfterKey, step.NextAfterActivityID
		if step.Done {
			sum.Done = true
			break
		}
		if step.NextAfterKey == nil && step.NextAfterActivityID == nil {
			// 服务端没给游标也没说完成：继续循环只会原地打转，必须停下报错
			sum.AbortedAtStep = sum.Steps + 1
			sum.AbortedErrorMessage = "step 既未完成也未返回游标"
			a.emitOrphanSummary(sum)
			return fmt.Errorf("第 %d 片既未完成也未返回游标，停止以免死循环（已删除 payload %d / activity %d）",
				sum.Steps+1, sum.DeletedPayloads, sum.DeletedActivities)
		}
	}

	a.emitOrphanSummary(sum)
	return nil
}

func (a *App) emitOrphanSummary(sum orphanSummary) {
	p := a.Printer()
	if a.flagJSON {
		_ = p.JSONValue(sum)
		return
	}
	p.Line("清理完成：共 %d 片，扫描 payload %d / 删除 %d，扫描 activity %d / 删除 %d",
		sum.Steps, sum.ScannedPayloads, sum.DeletedPayloads, sum.ScannedActivities, sum.DeletedActivities)
}

// ---------- record watch ----------

// watchState 负责去重：维护已打印过的 record id 集合。
// 用 map + 上限截断，避免长时间运行内存无界增长（真实库里 id 单调递增，截断旧 id 不会误打新记录）。
type watchState struct {
	seen        map[int]struct{}
	order       []int
	maxRemember int
}

func newWatchState(maxRemember int) *watchState {
	if maxRemember <= 0 {
		maxRemember = 5000
	}
	return &watchState{seen: make(map[int]struct{}), maxRemember: maxRemember}
}

// fresh 返回本次未见过的记录，并按 id 升序（旧→新）登记为已见。
func (s *watchState) fresh(records []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(records))
	for _, rec := range records {
		id, ok := recordID(rec)
		if !ok {
			// 没有 id 的记录无法去重：照样打出来，但不登记
			out = append(out, rec)
			continue
		}
		if _, seen := s.seen[id]; seen {
			continue
		}
		s.seen[id] = struct{}{}
		s.order = append(s.order, id)
		out = append(out, rec)
	}
	sort.SliceStable(out, func(i, j int) bool {
		left, lok := recordID(out[i])
		right, rok := recordID(out[j])
		if !lok || !rok {
			return false
		}
		return left < right
	})
	// 截断过老的 id
	if len(s.order) > s.maxRemember {
		drop := s.order[:len(s.order)-s.maxRemember]
		for _, id := range drop {
			delete(s.seen, id)
		}
		s.order = append([]int{}, s.order[len(s.order)-s.maxRemember:]...)
	}
	return out
}

func recordID(rec map[string]any) (int, bool) {
	switch v := rec["id"].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, false
		}
		return int(n), true
	}
	return 0, false
}

func (a *App) newRecordWatchCmd() *cobra.Command {
	var interval time.Duration
	var pageSize, iterations int
	cmd := &cobra.Command{
		Use:   "watch",
		Short: "增量监控最新请求记录（轮询 GET /record/latest.json，去重后只打印新记录）",
		Long: `按 --interval 轮询 GET /record/latest.json?pageSize=N，维护已打印 id 的滑动集合，
只输出新出现的记录（旧→新顺序）。--json 时每条记录一行 NDJSON，可直接 ` + "`gtgw record watch --json | jq .model`" + `。

Ctrl-C 退出；--iterations 用于「只轮询 N 次就退出」的脚本场景。`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if interval < 50*time.Millisecond {
				return client.Usagef("--interval 至少 50ms（避免把网关打爆），实际为 %s", interval)
			}
			if pageSize <= 0 {
				return client.Usagef("--page-size 必须为正整数，实际为 %d", pageSize)
			}
			if iterations < 0 {
				return client.Usagef("--iterations 不能为负数，实际为 %d", iterations)
			}
			return a.runWatch(cmd, interval, pageSize, iterations)
		},
	}
	cmd.Flags().DurationVar(&interval, "interval", 2*time.Second, "轮询间隔（最小 50ms）")
	cmd.Flags().IntVar(&pageSize, "page-size", 10, "每次拉取的记录条数（服务端上限 100）")
	cmd.Flags().IntVar(&iterations, "iterations", 0, "只轮询 N 次后退出（0 = 持续运行直到 Ctrl-C）")
	return cmd
}

func (a *App) runWatch(cmd *cobra.Command, interval time.Duration, pageSize, iterations int) error {
	p := a.Printer()
	state := newWatchState(0)

	ctx := cmd.Context()
	if ctx == nil {
		ctx = cmd.Context()
	}
	// Ctrl-C 时优雅退出（返回 nil，不算错误）
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	emit := func(records []map[string]any) error {
		for _, rec := range records {
			if a.flagJSON {
				raw, err := json.Marshal(rec)
				if err != nil {
					return fmt.Errorf("序列化记录失败：%w", err)
				}
				if _, err := fmt.Fprintln(p.Out, string(raw)); err != nil {
					return err
				}
				continue
			}
			p.Line("%s  %s", formatWatchLine(rec), "")
		}
		return nil
	}

	poll := func() error {
		resp, err := a.apiCall(cmd, http.MethodGet, "/record/latest.json?pageSize="+strconv.Itoa(pageSize), nil)
		if err != nil {
			return err
		}
		var records []map[string]any
		if err := resp.Unmarshal(&records); err != nil {
			return err
		}
		return emit(state.fresh(records))
	}

	rounds := 0
	for {
		if err := poll(); err != nil {
			return err
		}
		rounds++
		if iterations > 0 && rounds >= iterations {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}
	}
}

// formatWatchLine 把一条记录压成一行人类可读摘要。
func formatWatchLine(rec map[string]any) string {
	id := output.ValueString(rec["id"])
	ts := output.ValueString(rec["created_at"])
	if ts == "" {
		ts = output.ValueString(rec["start_at"])
	}
	status := output.ValueString(rec["status"])
	user := output.ValueString(rec["user_id"])
	model := output.ValueString(rec["model"])
	if model == "" {
		model = output.ValueString(rec["model_id"])
	}
	parts := []string{fmt.Sprintf("#%s", id)}
	if ts != "" {
		parts = append(parts, ts)
	}
	parts = append(parts, fmt.Sprintf("user=%s", user), fmt.Sprintf("model=%s", model), fmt.Sprintf("status=%s", status))
	return strings.Join(parts, "  ")
}

// 编译期断言：这些类型只在 --json 汇总里出现，供 route-command-map 与报告引用。
var _ = []any{orphanStats{}, orphanStep{}, orphanSummary{}}

// unused 引用保证 io 不会被 goimports 删掉（watch 的人类输出走 Printer，这里保留扩展点）。
var _ io.Writer = (io.Writer)(nil)
