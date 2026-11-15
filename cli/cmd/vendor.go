package cmd

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// vendorColumns 是 vendor 列表的展示列（字段见 vendorController.formatVendor）。
var vendorColumns = []string{"id", "name", "type", "urls", "model_count", "updated_at"}

// vendorModelColumns 对应 vendorModelController.serializeVendorModel。
var vendorModelColumns = []string{"id", "vendor_id", "model_id", "allowed_formats", "created_at"}

func (a *App) newVendorCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "vendor",
		Short: "供应商管理（presets / list / get / create / update / delete / test）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		a.newVendorPresetsCmd(),
		a.newVendorListCmd(),
		a.newVendorGetCmd(),
		a.newVendorCreateCmd(),
		a.newVendorUpdateCmd(),
		a.newVendorDeleteCmd(),
		a.newVendorTestCmd(),
		a.newVendorModelCmd(),
	)
	return cmd
}

func (a *App) newVendorPresetsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "presets",
		Short: "查看预置上游地址（GET /vendor/preset-urls.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			resp, err := a.apiCall(cmd, http.MethodGet, "/vendor/preset-urls.json", nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newVendorListCmd() *cobra.Command {
	q := &listQuery{}
	var vendorType, keyword string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "列出供应商（GET /vendor/list.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			q.set("type", vendorType)
			q.set("keyword", keyword)
			resp, err := a.apiCall(cmd, http.MethodGet, "/vendor/list.json"+q.String(), nil)
			if err != nil {
				return err
			}
			return a.outList(resp, vendorColumns)
		},
	}
	q.addCommonFlags(cmd)
	cmd.Flags().StringVar(&vendorType, "type", "", "按供应商类型筛选（后端 type 参数）")
	cmd.Flags().StringVar(&keyword, "keyword", "", "按名称/地址关键字筛选（后端 keyword 参数）")
	return cmd
}

func (a *App) newVendorGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "查看单个供应商（GET /vendor/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/vendor/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newVendorCreateCmd() *cobra.Command {
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "create",
		Short: "创建供应商（POST /vendor/create.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			payload, err := body.build(a.in)
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/vendor/create.json", payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	return cmd
}

func (a *App) newVendorUpdateCmd() *cobra.Command {
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "update <id>",
		Short: "更新供应商（PUT /vendor/:id，仅提交给出的字段）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			payload, err := body.build(a.in)
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodPut, "/vendor/"+id, payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	return cmd
}

func (a *App) newVendorDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "删除供应商（DELETE /vendor/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			if err := a.requireDestructive("删除供应商 " + id); err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodDelete, "/vendor/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newVendorTestCmd() *cobra.Command {
	var format, modelName string
	var autoConvert bool
	cmd := &cobra.Command{
		Use:   "test <id>",
		Short: "测试供应商连通性（POST /vendor/:id/test.json，超时 120s）",
		Long: `请求体只含后端真实支持的三个字段：format / model / auto_convert
（见 vendorController.testVendor）。step2 文档里的 --content-mode 在后端不存在，未实现。`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			payload := map[string]any{}
			if format != "" {
				payload["format"] = format
			}
			if modelName != "" {
				payload["model"] = modelName
			}
			if cmd.Flags().Changed("auto-convert") {
				payload["auto_convert"] = autoConvert
			}
			resp, err := a.apiCallWithTimeout(cmd, http.MethodPost, "/vendor/"+id+"/test.json", payload, client.InferenceTimeout)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	cmd.Flags().StringVar(&format, "format", "", "测试协议：openai / anthropic / responses")
	cmd.Flags().StringVar(&modelName, "model", "", "测试使用的模型名")
	cmd.Flags().BoolVar(&autoConvert, "auto-convert", false, "是否允许自动协议转换（显式给出才发送该字段）")
	return cmd
}

// ---- vendor model 子命令 ----

func (a *App) newVendorModelCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "model",
		Short: "供应商上游模型管理（list / fetch / sync / add / update / delete）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		a.newVendorModelListCmd(),
		a.newVendorModelFetchCmd(),
		a.newVendorModelSyncCmd(),
		a.newVendorModelAddCmd(),
		a.newVendorModelUpdateCmd(),
		a.newVendorModelDeleteCmd(),
	)
	return cmd
}

func (a *App) newVendorModelListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list <vendorId>",
		Short: "列出供应商已配置的上游模型（GET /vendor/:id/model/list.json）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/vendor/"+id+"/model/list.json", nil)
			if err != nil {
				return err
			}
			return a.outList(resp, vendorModelColumns)
		},
	}
}

func (a *App) newVendorModelFetchCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "fetch <vendorId>",
		Short: "从上游拉取模型列表（GET /vendor/:id/model/fetch.json，不落库）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCallWithTimeout(cmd, http.MethodGet, "/vendor/"+id+"/model/fetch.json", nil, client.InferenceTimeout)
			if err != nil {
				return err
			}
			p := a.Printer()
			if a.flagJSON {
				return p.JSONRaw(resp.Body)
			}
			// 响应结构是 { models: [...] }，这里只需要模型名字列表
			var payload struct {
				Models []any `json:"models"`
			}
			if err := resp.Unmarshal(&payload); err != nil {
				return err
			}
			if a.flagQuiet {
				for _, m := range payload.Models {
					p.Line("%v", m)
				}
				return nil
			}
			rows := make([][]string, 0, len(payload.Models))
			for _, m := range payload.Models {
				rows = append(rows, []string{formatModelEntry(m)})
			}
			if err := p.Table([]string{"MODEL"}, rows); err != nil {
				return err
			}
			p.Info("total: %d", len(payload.Models))
			return nil
		},
	}
}

// formatModelEntry 兼容上游返回 "model-name" 或 {id: "model-name"} 两种形态。
func formatModelEntry(entry any) string {
	switch typed := entry.(type) {
	case string:
		return typed
	case map[string]any:
		for _, key := range []string{"id", "name", "model"} {
			if val, ok := typed[key].(string); ok && val != "" {
				return val
			}
		}
		raw, _ := json.Marshal(typed)
		return string(raw)
	default:
		return strings.TrimSpace(strings.Trim(fmtAny(typed), `"`))
	}
}

func fmtAny(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(raw)
}

func (a *App) newVendorModelSyncCmd() *cobra.Command {
	var modelIDs string
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "sync <vendorId>",
		Short: "用给定模型名同步供应商模型（POST /vendor/:id/model/sync.json）",
		Long: `请求体是 {"model_ids": ["..."]}。两种传参：
  --model-ids a,b,c
  --file <path>（JSON，形如 {"model_ids":["a","b"]}，"-" 从 stdin 读）`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			payload, err := buildModelIDsPayload(body, modelIDs, a.in)
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/vendor/"+id+"/model/sync.json", payload)
			if err != nil {
				return err
			}
			return a.outList(resp, vendorModelColumns)
		},
	}
	cmd.Flags().StringVar(&modelIDs, "model-ids", "", "逗号分隔的模型名列表")
	body.addFlags(cmd)
	return cmd
}

func (a *App) newVendorModelAddCmd() *cobra.Command {
	var modelID string
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "add <vendorId>",
		Short: "为供应商添加一个上游模型（POST /vendor/:id/model/add.json）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			var payload map[string]any
			if strings.TrimSpace(modelID) != "" {
				payload = map[string]any{"model_id": strings.TrimSpace(modelID)}
			} else {
				payload, err = body.build(a.in)
				if err != nil {
					return err
				}
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/vendor/"+id+"/model/add.json", payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	cmd.Flags().StringVar(&modelID, "model-id", "", "上游模型名（等价于 --key model_id=...）")
	body.addFlags(cmd)
	return cmd
}

func (a *App) newVendorModelUpdateCmd() *cobra.Command {
	var allowedFormats string
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "update <vendorId> <modelId>",
		Short: "更新供应商模型（PUT /vendor/:id/model/:modelId，仅支持 allowed_formats）",
		Args:  exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			vendorID, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			modelRecordID, err := idArg("供应商模型记录 id", args[1])
			if err != nil {
				return err
			}
			var payload map[string]any
			if strings.TrimSpace(allowedFormats) != "" {
				formats := []string{}
				for _, f := range strings.Split(allowedFormats, ",") {
					if trimmed := strings.TrimSpace(f); trimmed != "" {
						formats = append(formats, trimmed)
					}
				}
				payload = map[string]any{"allowed_formats": formats}
			} else {
				payload, err = body.build(a.in)
				if err != nil {
					return err
				}
			}
			resp, err := a.apiCall(cmd, http.MethodPut, "/vendor/"+vendorID+"/model/"+modelRecordID, payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	cmd.Flags().StringVar(&allowedFormats, "allowed-formats", "", "逗号分隔的允许协议列表（openai,anthropic,responses）")
	body.addFlags(cmd)
	return cmd
}

func (a *App) newVendorModelDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <vendorId> <modelId>",
		Short: "删除供应商模型（DELETE /vendor/:id/model/:modelId）",
		Args:  exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			vendorID, err := idArg("供应商 id", args[0])
			if err != nil {
				return err
			}
			modelRecordID, err := idArg("供应商模型记录 id", args[1])
			if err != nil {
				return err
			}
			if err := a.requireDestructive("删除供应商 " + vendorID + " 的模型记录 " + modelRecordID); err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodDelete, "/vendor/"+vendorID+"/model/"+modelRecordID, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

// buildModelIDsPayload 组装 {"model_ids": [...]}：
// --model-ids 优先；否则用 --file / --key（并校验 model_ids 存在且是数组）。
func buildModelIDsPayload(body *bodySource, modelIDs string, stdin *os.File) (map[string]any, error) {
	if strings.TrimSpace(modelIDs) != "" {
		ids := []string{}
		for _, raw := range strings.Split(modelIDs, ",") {
			if trimmed := strings.TrimSpace(raw); trimmed != "" {
				ids = append(ids, trimmed)
			}
		}
		if len(ids) == 0 {
			return nil, client.Usagef("--model-ids 不能为空")
		}
		return map[string]any{"model_ids": ids}, nil
	}
	payload, err := body.build(stdin)
	if err != nil {
		return nil, err
	}
	raw, ok := payload["model_ids"]
	if !ok {
		return nil, client.Usagef("请求体缺少 model_ids 字段（可用 --model-ids a,b 或 --file 指定）")
	}
	if _, isArray := raw.([]any); !isArray {
		return nil, client.Usagef("model_ids 必须是数组，实际为 %T", raw)
	}
	return payload, nil
}
