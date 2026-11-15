package cmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// 本文件覆盖 #258 判据 1/2/3：clear-orphans 的多片游标与中途失败、watch 的去重与 NDJSON。

// orphanStub 模拟「stats + 多片 step」的服务端：
// 记录每片收到的游标，按预定脚本返回，便于断言游标传递与计数累加。
type orphanStub struct {
	mu    sync.Mutex
	calls []map[string]any
	errAt int // 第 N 片返回 500（0 表示不注入错误）
}

func (s *orphanStub) handleStep(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	s.calls = append(s.calls, body)
	call := len(s.calls)
	s.mu.Unlock()

	if s.errAt > 0 && call == s.errAt {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "boom at slice"})
		return
	}
	switch call {
	case 1:
		writeJSON(w, http.StatusOK, map[string]any{
			"next_after_key": "k1", "next_after_activity_id": 10,
			"scanned_payloads": 3, "deleted_payloads": 2,
			"scanned_activities": 2, "deleted_activities": 1, "done": false,
		})
	case 2:
		writeJSON(w, http.StatusOK, map[string]any{
			"next_after_key": "k2", "next_after_activity_id": 20,
			"scanned_payloads": 3, "deleted_payloads": 1,
			"scanned_activities": 2, "deleted_activities": 1, "done": false,
		})
	default:
		writeJSON(w, http.StatusOK, map[string]any{
			"next_after_key": nil, "next_after_activity_id": nil,
			"scanned_payloads": 3, "deleted_payloads": 3,
			"scanned_activities": 2, "deleted_activities": 1, "done": true,
		})
	}
}

func newOrphanGateway(t *testing.T, stub *orphanStub) *resourceGateway {
	t.Helper()
	return newResourceGateway(t, []stubRoute{
		jsonStub(http.MethodGet, "/record/clear-orphans/stats.json", map[string]any{
			"payload_total": 9, "activity_total": 6, "page_size": 3, "max_page_size": 100,
		}),
		{method: http.MethodPost, pattern: "/record/clear-orphans/step", handler: stub.handleStep},
	})
}

// TestClearOrphansMultiSlice 判据 1：≥3 片、游标传递正确、四个计数累加正确、进度只写 stderr、
// --json 下 stdout 是干净的单份汇总 JSON。
func TestClearOrphansMultiSlice(t *testing.T) {
	stub := &orphanStub{}
	gw := newOrphanGateway(t, stub)
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)

	if code := runCLI(app, "record", "clear-orphans", "-y", "--json"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}

	// ① 循环次数与游标传递
	if len(stub.calls) != 3 {
		t.Fatalf("step 调用次数 = %d, 期望 3", len(stub.calls))
	}
	if _, ok := stub.calls[0]["after_key"]; ok {
		t.Fatalf("第一片不应带 after_key：%v", stub.calls[0])
	}
	if stub.calls[1]["after_key"] != "k1" || stub.calls[1]["after_activity_id"] != float64(10) {
		t.Fatalf("第二片游标应等于第一片响应（k1/10），实际：%v", stub.calls[1])
	}
	if stub.calls[2]["after_key"] != "k2" || stub.calls[2]["after_activity_id"] != float64(20) {
		t.Fatalf("第三片游标应等于第二片响应（k2/20），实际：%v", stub.calls[2])
	}
	for i, call := range stub.calls {
		if call["limit"] != float64(3) {
			t.Fatalf("第 %d 片 limit = %v, 期望 3（取自 stats.page_size）", i+1, call["limit"])
		}
	}

	// ② 四个计数累加
	var sum map[string]any
	if err := json.Unmarshal(out.Bytes(), &sum); err != nil {
		t.Fatalf("stdout 不是合法 JSON：%v（%q）", err, out.String())
	}
	want := map[string]float64{
		"payload_total": 9, "activity_total": 6,
		"scanned_payloads": 9, "deleted_payloads": 6,
		"scanned_activities": 6, "deleted_activities": 3,
		"steps": 3,
	}
	for k, v := range want {
		if sum[k] != v {
			t.Fatalf("汇总 %s = %v, 期望 %v（完整：%v）", k, sum[k], v, sum)
		}
	}
	if sum["done"] != true {
		t.Fatalf("汇总 done = %v, 期望 true", sum["done"])
	}

	// ③ 进度只写 stderr
	for _, wantLine := range []string{"第 1 片", "第 2 片", "第 3 片", "孤儿总量"} {
		if !strings.Contains(errOut.String(), wantLine) {
			t.Fatalf("stderr 应含进度 %q，实际：%q", wantLine, errOut.String())
		}
		if strings.Contains(out.String(), wantLine) {
			t.Fatalf("stdout 不应含进度 %q，实际：%q", wantLine, out.String())
		}
	}
}

// TestClearOrphansFailureMidway 判据 2：某片 500 ⇒ 退出码 1、已完成计数如实报出、不静默当完成。
func TestClearOrphansFailureMidway(t *testing.T) {
	stub := &orphanStub{errAt: 2}
	gw := newOrphanGateway(t, stub)
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)

	code := runCLI(app, "record", "clear-orphans", "-y", "--json")
	if code != 1 {
		t.Fatalf("中途失败退出码 = %d, 期望 1（stderr=%s）", code, errOut.String())
	}
	if len(stub.calls) != 2 {
		t.Fatalf("失败后不应继续请求，step 调用次数 = %d, 期望 2", len(stub.calls))
	}
	if !strings.Contains(errOut.String(), "第 2 片失败") {
		t.Fatalf("stderr 应说明失败片数，实际：%q", errOut.String())
	}
	var sum map[string]any
	if err := json.Unmarshal(out.Bytes(), &sum); err != nil {
		t.Fatalf("失败时 stdout 也应是 JSON 汇总：%v（%q）", err, out.String())
	}
	// 第一片真实发生的删除必须如实报出
	if sum["deleted_payloads"] != float64(2) || sum["deleted_activities"] != float64(1) {
		t.Fatalf("已完成计数未如实报出：%v", sum)
	}
	if sum["done"] != false || sum["aborted_at_step"] != float64(2) {
		t.Fatalf("汇总应标未完成且标注失败片：%v", sum)
	}
}

// TestClearOrphansRequiresConfirm 破坏性命令在非 TTY 且未 -y 时退出码 2 且零请求。
func TestClearOrphansRequiresConfirm(t *testing.T) {
	stub := &orphanStub{}
	gw := newOrphanGateway(t, stub)
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	writeTempStdin(t, app, "y\n")
	if code := runCLI(app, "record", "clear-orphans"); code != 2 {
		t.Fatalf("退出码 = %d, 期望 2（stderr=%s）", code, errOut.String())
	}
	if paths := gw.rec.paths(); len(paths) != 0 {
		t.Fatalf("未确认却发出了请求：%v", paths)
	}
}

// watchStub 按轮次返回不同的最新记录列表（含重复 id），用于验证去重与增量。
type watchStub struct {
	mu    sync.Mutex
	round int
}

func (s *watchStub) handleLatest(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	s.round++
	round := s.round
	s.mu.Unlock()

	rec := func(id int, model string) map[string]any {
		return map[string]any{
			"id": id, "user_id": 41, "model": model, "status": "success",
			"created_at": fmt.Sprintf("2026-11-15 10:00:%02d", id),
		}
	}
	switch round {
	case 1:
		// 同一批里就有重复 id（服务端可能返回重复）
		writeJSON(w, http.StatusOK, []map[string]any{rec(3, "gpt-4o"), rec(2, "gpt-4o"), rec(2, "gpt-4o")})
	case 2:
		// 2、3 是旧的，4 是新的
		writeJSON(w, http.StatusOK, []map[string]any{rec(3, "gpt-4o"), rec(4, "claude")})
	default:
		// 只剩旧的
		writeJSON(w, http.StatusOK, []map[string]any{rec(4, "claude"), rec(3, "gpt-4o")})
	}
}

func newWatchGateway(t *testing.T, stub *watchStub) *resourceGateway {
	t.Helper()
	return newResourceGateway(t, []stubRoute{
		{method: http.MethodGet, pattern: "/record/latest.json", handler: stub.handleLatest},
	})
}

// TestWatchDedupAndNDJSON 判据 3：每条记录只打印一次、只有新记录才打印、--json 是 NDJSON。
func TestWatchDedupAndNDJSON(t *testing.T) {
	stub := &watchStub{}
	gw := newWatchGateway(t, stub)
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)

	if code := runCLI(app, "record", "watch", "--iterations", "3", "--interval", "50ms", "--json"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	if stub.round != 3 {
		t.Fatalf("轮询次数 = %d, 期望 3", stub.round)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("NDJSON 行数 = %d, 期望 3（id 2/3/4 各一次）：%q", len(lines), out.String())
	}
	var ids []int
	for _, line := range lines {
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("NDJSON 每行必须可单独解析，失败行：%q（%v）", line, err)
		}
		id, ok := recordID(rec)
		if !ok {
			t.Fatalf("行里没有 id：%q", line)
		}
		ids = append(ids, id)
	}
	if fmt.Sprint(ids) != "[2 3 4]" {
		t.Fatalf("打印顺序 = %v, 期望 [2 3 4]（旧→新，且不重复）", ids)
	}
	if errOut.Len() != 0 {
		t.Fatalf("--json 时 stderr 应为空，实际：%q", errOut.String())
	}
}

// TestWatchHumanOutput 人类模式：一行一条，含 id/状态，且同样去重。
func TestWatchHumanOutput(t *testing.T) {
	stub := &watchStub{}
	gw := newWatchGateway(t, stub)
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)

	if code := runCLI(app, "record", "watch", "--iterations", "3", "--interval", "50ms"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("输出行数 = %d, 期望 3：%q", len(lines), out.String())
	}
	for i, want := range []string{"#2", "#3", "#4"} {
		if !strings.Contains(lines[i], want) {
			t.Fatalf("第 %d 行应含 %q，实际：%q", i+1, want, lines[i])
		}
	}
}

// TestWatchRejectsTooSmallInterval 防止把网关打爆的边界。
func TestWatchRejectsTooSmallInterval(t *testing.T) {
	gw := newWatchGateway(t, &watchStub{})
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "record", "watch", "--interval", "10ms"); code != 2 {
		t.Fatalf("退出码 = %d, 期望 2（stderr=%s）", code, errOut.String())
	}
	if paths := gw.rec.paths(); len(paths) != 0 {
		t.Fatalf("参数错误却发了请求：%v", paths)
	}
}

// TestWatchStateTrimsOldIDs 单测 watchState 的滑动窗口：超过上限时丢弃最老的 id，
// 但不会把已经在窗口内的 id 重新当成新记录。
func TestWatchStateTrimsOldIDs(t *testing.T) {
	state := newWatchState(2)
	if got := state.fresh([]map[string]any{{"id": float64(1)}, {"id": float64(2)}, {"id": float64(3)}}); len(got) != 3 {
		t.Fatalf("首轮应全部是新的，实际 %d 条", len(got))
	}
	// 上限 2 ⇒ 只记住 2、3；再看到 2 应该是旧的，看到 1 会重新当作新记录（窗口外的取舍）
	if got := state.fresh([]map[string]any{{"id": float64(2)}, {"id": float64(3)}}); len(got) != 0 {
		t.Fatalf("窗口内的 id 不应重复打印，实际 %d 条", len(got))
	}
}
