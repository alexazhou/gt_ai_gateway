package cmd

import (
	"net/http"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// modelColumns 对应 modelController.listModels 的返回字段（SgModel 原样）。
var modelColumns = []string{"id", "name", "routing_mode", "status", "tenant_id", "created_at"}

func (a *App) newModelCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "model",
		Short: "模型管理（list / get / create / update / delete / route-test）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		a.newModelListCmd(),
		a.newModelGetCmd(),
		a.newModelCreateCmd(),
		a.newModelUpdateCmd(),
		a.newModelDeleteCmd(),
		a.newModelRouteTestCmd(),
	)
	return cmd
}

func (a *App) newModelListCmd() *cobra.Command {
	q := &listQuery{}
	var vendorID, keyword string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "列出逻辑模型（GET /model/list.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			q.set("vendor_id", vendorID)
			q.set("keyword", keyword)
			resp, err := a.apiCall(cmd, http.MethodGet, "/model/list.json"+q.String(), nil)
			if err != nil {
				return err
			}
			return a.outList(resp, modelColumns)
		},
	}
	q.addCommonFlags(cmd)
	cmd.Flags().StringVar(&vendorID, "vendor-id", "", "只看挂在该供应商下的模型（后端 vendor_id 参数）")
	cmd.Flags().StringVar(&keyword, "keyword", "", "按名称关键字筛选（后端 keyword 参数）")
	return cmd
}

func (a *App) newModelGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "查看单个模型（GET /model/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("模型 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/model/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newModelCreateCmd() *cobra.Command {
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "create",
		Short: "创建逻辑模型（POST /model/create.json，必须含 routing_mode 与 routing_config）",
		Long: `后端要求请求体同时包含 routing_mode 与 routing_config（见 modelController.createModelFromRequest），
缺任一字段会返回 400。用 --file 传完整 JSON，或用 --key 逐项给出。`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			payload, err := body.build(a.in)
			if err != nil {
				return err
			}
			if err := requireModelRoutingFields(payload); err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/model/create.json", payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	return cmd
}

func (a *App) newModelUpdateCmd() *cobra.Command {
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "update <id>",
		Short: "更新逻辑模型（PUT /model/:id）",
		Long: `后端 PUT 会整体重建模型对象且强制要求 routing_mode / routing_config（缺则 400），
因此 CLI 采用「GET 当前对象 → 合并你给的字段 → PUT」的读改写，避免只改一个字段就把路由配置清空。
--json 输出的是 PUT 之后服务端返回的完整对象。`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("模型 id", args[0])
			if err != nil {
				return err
			}
			patch, err := body.build(a.in)
			if err != nil {
				return err
			}
			current, err := a.apiCall(cmd, http.MethodGet, "/model/"+id, nil)
			if err != nil {
				return err
			}
			base, err := jsonBodyFromResponse(current)
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodPut, "/model/"+id, mergeBody(base, patch))
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	return cmd
}

func (a *App) newModelDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "删除逻辑模型（DELETE /model/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("模型 id", args[0])
			if err != nil {
				return err
			}
			if err := a.requireDestructive("删除模型 " + id); err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodDelete, "/model/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newModelRouteTestCmd() *cobra.Command {
	var modelName, format string
	cmd := &cobra.Command{
		Use:   "route-test",
		Short: "测试模型路由可用性（POST /model/route-test.json，超时 120s）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if modelName == "" {
				return client.Usagef("缺少 --model：该接口要求 body.model（见 modelController.testModelRoute）")
			}
			payload := map[string]any{"model": modelName}
			if format != "" {
				payload["format"] = format
			}
			resp, err := a.apiCallWithTimeout(cmd, http.MethodPost, "/model/route-test.json", payload, client.InferenceTimeout)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	cmd.Flags().StringVar(&modelName, "model", "", "模型名（必填，对应 body.model）")
	cmd.Flags().StringVar(&format, "format", "", "测试协议：openai / anthropic / responses（默认 openai）")
	return cmd
}

// requireModelRoutingFields 在客户端先拦一次明显会 400 的请求，省一次往返。
func requireModelRoutingFields(payload map[string]any) error {
	for _, key := range []string{"routing_mode", "routing_config"} {
		if _, ok := payload[key]; !ok {
			return client.Usagef("请求体缺少 %s 字段：后端创建/更新模型要求 routing_mode 与 routing_config 同时存在", key)
		}
	}
	return nil
}
