package cmd

import (
	"net/http"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/output"
)

// recordColumns 对应 recordController.serializeRecord 的主要字段。
var recordColumns = []string{"id", "user_id", "model_id", "status", "created_at", "start_at", "end_at"}

func (a *App) newRecordCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "record",
		Short: "请求记录（list / get / activity / delete / recover-orphans / clear-payload / clear-all / clear-orphans / watch）",
		Long: `筛选参数以后端为准（recordController.listRecords）：status / user_ids / model_ids / start_time / end_time，
其中 user_ids、model_ids 是逗号分隔的 ID 列表。`,
		Args: noArgs,
	}
	cmd.AddCommand(
		a.newRecordListCmd(),
		a.newRecordGetCmd(),
		a.newRecordActivityCmd(),
		a.newRecordDeleteCmd(),
		a.newRecordRecoverOrphansCmd(),
		a.newRecordClearPayloadCmd(),
		a.newRecordClearAllCmd(),
		// 复合命令（P3）：多片游标清理与增量监控
		a.newRecordClearOrphansCmd(),
		a.newRecordWatchCmd(),
	)
	return cmd
}

func (a *App) newRecordListCmd() *cobra.Command {
	q := &listQuery{}
	var status, userIDs, modelIDs, startTime, endTime string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "分页查询请求记录（GET /record/list.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			q.set("status", status)
			q.set("user_ids", userIDs)
			q.set("model_ids", modelIDs)
			q.set("start_time", startTime)
			q.set("end_time", endTime)
			resp, err := a.apiCall(cmd, http.MethodGet, "/record/list.json"+q.String(), nil)
			if err != nil {
				return err
			}
			return a.outList(resp, recordColumns)
		},
	}
	q.addCommonFlags(cmd)
	cmd.Flags().StringVar(&status, "status", "", "按状态筛选（后端 status 参数，如 success / failed）")
	cmd.Flags().StringVar(&userIDs, "user-ids", "", "用户 ID 列表，逗号分隔（后端 user_ids 参数）")
	cmd.Flags().StringVar(&modelIDs, "model-ids", "", "模型 ID 列表，逗号分隔（后端 model_ids 参数）")
	cmd.Flags().StringVar(&startTime, "start-time", "", "起始时间（后端 start_time 参数）")
	cmd.Flags().StringVar(&endTime, "end-time", "", "结束时间（后端 end_time 参数）")
	return cmd
}

func (a *App) newRecordGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "查看单条请求记录（GET /record/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("记录 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/record/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newRecordActivityCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "activity <id>",
		Short: "查看请求活动时间线（GET /record/:id/activity.json）",
		Long: `响应是 {record_id, activities: [{stage, level, message, details?, ts}]}（见 recordActivityController）。
时间线按发生顺序打印；没有活动日志时只在 stderr 给一句提示，退出码仍为 0。`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("记录 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/record/"+id+"/activity.json", nil)
			if err != nil {
				return err
			}
			// --json / --quiet 都原样透传服务端结构，便于脚本二次处理。
			if a.flagJSON || a.flagQuiet {
				return a.Printer().JSONRaw(resp.Body)
			}
			var payload struct {
				RecordID   int              `json:"record_id"`
				Activities []map[string]any `json:"activities"`
			}
			if err := resp.Unmarshal(&payload); err != nil {
				return err
			}
			p := a.Printer()
			if len(payload.Activities) == 0 {
				p.Info("记录 %d 没有活动日志", payload.RecordID)
				return nil
			}
			rows := make([][]string, 0, len(payload.Activities))
			for _, item := range payload.Activities {
				row := make([]string, 0, 4)
				for _, key := range []string{"stage", "level", "message", "ts"} {
					val := output.ValueString(item[key])
					if val == "" {
						val = "-"
					}
					row = append(row, val)
				}
				rows = append(rows, row)
			}
			return p.Table([]string{"STAGE", "LEVEL", "MESSAGE", "TS"}, rows)
		},
	}
}

func (a *App) newRecordDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "删除单条请求记录（DELETE /record/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("记录 id", args[0])
			if err != nil {
				return err
			}
			if err := a.requireDestructive("删除请求记录 " + id); err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodDelete, "/record/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newRecordRecoverOrphansCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "recover-orphans",
		Short: "恢复孤儿请求记录（POST /record/recover-orphans.json）",
		Args:  noArgs,
		Long:  destructiveLongWithSafety("把「孤儿」请求记录重新挂回其用户/模型（POST /record/recover-orphans.json）。"),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := a.requireDestructive("恢复孤儿请求记录"); err != nil {
				return err
			}
			resp, err := a.apiCallLong(cmd, http.MethodPost, "/record/recover-orphans.json", nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newRecordClearPayloadCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "clear-payload",
		Short: "清空全部请求负载（DELETE /record/clear-payload，默认超时 5m）",
		Long: destructiveLongWithSafety("清空所有请求记录的 payload（不可恢复）。\n" +
			"长耗时：真实库实测约 194s，故默认超时 5 分钟；超时不代表服务端没执行。"),
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := a.requireDestructive("清空所有请求记录的负载（payload 不可恢复）"); err != nil {
				return err
			}
			// 长耗时：真实库实测 193.9s，默认 30s 必然超时（客户端失败而服务端仍成功）
			resp, err := a.apiCallLong(cmd, http.MethodDelete, "/record/clear-payload", nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newRecordClearAllCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "clear-all",
		Short: "清空全部请求记录（DELETE /record/clear-all，默认超时 5m）",
		Long:  destructiveLongWithSafety("清空全部请求记录（级联 payload 与 activity，不可恢复）。"),
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := a.requireDestructive("清空所有请求记录（不可恢复）"); err != nil {
				return err
			}
			resp, err := a.apiCallLong(cmd, http.MethodDelete, "/record/clear-all", nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}
