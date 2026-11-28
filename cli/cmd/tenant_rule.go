package cmd

import (
	"net/http"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// tenantColumns 对应 tenantController.listTenants 的返回字段。
var tenantColumns = []string{"id", "name", "description", "created_at"}

// ruleColumns 对应 ruleController.listRules 的返回字段（generic-plugin v3 起含 priority / source / biz_id）。
var ruleColumns = []string{"id", "name", "type", "priority", "source", "scope", "enabled", "cross_tenant", "created_at"}

// pluginColumns 对应 ruleController.listPlugins（= 后端插件注册表 describe()）的返回字段。
var pluginColumns = []string{"name", "description", "hooks"}

// ruleSourceValues 是 rule list 的 --source 合法取值：user = 用户规则，system = 系统预置规则。
var ruleSourceValues = []string{"user", "system"}

func (a *App) newTenantCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tenant",
		Short: "多租户管理（list / get / create / update / delete，系统管理员专用）",
		Long: `租户接口的写操作要求系统管理员身份且多租户功能开关已开启（服务端校验，见 tenantController）。
CLI 只透传 Token 与 --tenant，权限判定完全以服务端返回为准。`,
		Args: noArgs,
	}
	cmd.AddCommand(
		a.newTenantListCmd(),
		a.newTenantGetCmd(),
		a.newTenantCreateCmd(),
		a.newTenantUpdateCmd(),
		a.newTenantDeleteCmd(),
	)
	return cmd
}

func (a *App) newTenantListCmd() *cobra.Command {
	q := &listQuery{}
	var keyword string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "列出租户（GET /tenant.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			q.set("keyword", keyword)
			resp, err := a.apiCall(cmd, http.MethodGet, "/tenant.json"+q.String(), nil)
			if err != nil {
				return err
			}
			return a.outList(resp, tenantColumns)
		},
	}
	q.addCommonFlags(cmd)
	cmd.Flags().StringVar(&keyword, "keyword", "", "按名称关键字筛选（后端 keyword 参数）")
	return cmd
}

func (a *App) newTenantGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "查看单个租户（GET /tenant/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("租户 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/tenant/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newTenantCreateCmd() *cobra.Command {
	body := &bodySource{}
	var name, description string
	cmd := &cobra.Command{
		Use:   "create",
		Short: "创建租户（POST /tenant.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			payload, err := body.buildOptional(a.in)
			if err != nil {
				return err
			}
			if payload == nil {
				payload = map[string]any{}
			}
			if cmd.Flags().Changed("name") {
				payload["name"] = name
			}
			if cmd.Flags().Changed("description") {
				payload["description"] = description
			}
			if _, ok := payload["name"]; !ok {
				return client.Usagef("缺少租户名称：用 --name 或 --file/--key 指定")
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/tenant.json", payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	cmd.Flags().StringVar(&name, "name", "", "租户名称")
	cmd.Flags().StringVar(&description, "description", "", "租户描述")
	return cmd
}

func (a *App) newTenantUpdateCmd() *cobra.Command {
	body := &bodySource{}
	var name, description string
	cmd := &cobra.Command{
		Use:   "update <id>",
		Short: "更新租户（PUT /tenant/:id，仅提交给出的字段）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("租户 id", args[0])
			if err != nil {
				return err
			}
			payload, err := body.buildOptional(a.in)
			if err != nil {
				return err
			}
			if payload == nil {
				payload = map[string]any{}
			}
			if cmd.Flags().Changed("name") {
				payload["name"] = name
			}
			if cmd.Flags().Changed("description") {
				payload["description"] = description
			}
			if len(payload) == 0 {
				return client.Usagef("没有要修改的字段：用 --name/--description 或 --file/--key 指定")
			}
			resp, err := a.apiCall(cmd, http.MethodPut, "/tenant/"+id, payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	cmd.Flags().StringVar(&name, "name", "", "租户名称")
	cmd.Flags().StringVar(&description, "description", "", "租户描述")
	return cmd
}

func (a *App) newTenantDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "删除租户（DELETE /tenant/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("租户 id", args[0])
			if err != nil {
				return err
			}
			if err := a.requireDestructive("删除租户 " + id); err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodDelete, "/tenant/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

// ---- rule ----

func (a *App) newRuleCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "rule",
		Short: "规则管理（list / get / create / update / delete）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		a.newRuleListCmd(),
		a.newRulePluginsCmd(),
		a.newRuleGetCmd(),
		a.newRuleCreateCmd(),
		a.newRuleUpdateCmd(),
		a.newRuleDeleteCmd(),
	)
	return cmd
}

func (a *App) newRuleListCmd() *cobra.Command {
	q := &listQuery{}
	var keyword, source string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "列出规则（GET /rule/list.json）",
		Long: `按来源列出规则：--source user 只列用户规则（服务端默认口径），
--source system 只列系统预置规则（名称 / 条件 / 参数不可改，仅开关可由高级设置调整）。`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(source) != "" {
				if !slices.Contains(ruleSourceValues, source) {
					return client.Usagef("--source 只支持 %s，实际为 %q",
						strings.Join(ruleSourceValues, " / "), source)
				}
			}
			q.set("keyword", keyword)
			q.set("source", source)
			resp, err := a.apiCall(cmd, http.MethodGet, "/rule/list.json"+q.String(), nil)
			if err != nil {
				return err
			}
			return a.outList(resp, ruleColumns)
		},
	}
	q.addCommonFlags(cmd)
	cmd.Flags().StringVar(&keyword, "keyword", "", "按名称关键字筛选（后端 keyword 参数）")
	cmd.Flags().StringVar(&source, "source", "", "按来源筛选（user / system；不传 = 服务端默认只返回用户规则）")
	return cmd
}

// newRulePluginsCmd 列可用请求插件：数据来自后端插件注册表 describe()，按插件名升序。
// 建 plugin 规则时用它确认插件名与参数样例（config_example 只在 --json 里可见）。
func (a *App) newRulePluginsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "plugins",
		Short: "列出可用请求插件（GET /rule/plugins.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			resp, err := a.apiCall(cmd, http.MethodGet, "/rule/plugins.json", nil)
			if err != nil {
				return err
			}
			return a.outList(resp, pluginColumns)
		},
	}
}

func (a *App) newRuleGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "查看单条规则（GET /rule/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("规则 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/rule/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newRuleCreateCmd() *cobra.Command {
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "create",
		Short: "创建规则（POST /rule/create.json，需含 type/name/config）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			payload, err := body.build(a.in)
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/rule/create.json", payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	return cmd
}

func (a *App) newRuleUpdateCmd() *cobra.Command {
	body := &bodySource{}
	cmd := &cobra.Command{
		Use:   "update <id>",
		Short: "更新规则（PUT /rule/:id，仅提交给出的字段）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("规则 id", args[0])
			if err != nil {
				return err
			}
			payload, err := body.build(a.in)
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodPut, "/rule/"+id, payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	return cmd
}

func (a *App) newRuleDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "删除规则（DELETE /rule/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("规则 id", args[0])
			if err != nil {
				return err
			}
			if err := a.requireDestructive("删除规则 " + id); err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodDelete, "/rule/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}
