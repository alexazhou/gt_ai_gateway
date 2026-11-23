package cmd

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
)

// userColumns 对应 userController 列表返回的用户字段。
var userColumns = []string{"id", "name", "type", "status", "balance", "tenant_id", "created_at"}

// balanceColumns 对应 rechargeRecordManager 返回的充值记录字段。
var balanceColumns = []string{"id", "user_id", "amount", "type", "remark", "created_at"}

func (a *App) newUserCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "user",
		Short: "用户管理（list / get / create / update / recharge）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		a.newUserListCmd(),
		a.newUserGetCmd(),
		a.newUserCreateCmd(),
		a.newUserUpdateCmd(),
		a.newUserRechargeCmd(),
	)
	return cmd
}

func (a *App) newUserListCmd() *cobra.Command {
	q := &listQuery{}
	var userType, keyword string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "列出用户（GET /user/list.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			q.set("type", userType)
			q.set("keyword", keyword)
			resp, err := a.apiCall(cmd, http.MethodGet, "/user/list.json"+q.String(), nil)
			if err != nil {
				return err
			}
			return a.outList(resp, userColumns)
		},
	}
	q.addCommonFlags(cmd)
	cmd.Flags().StringVar(&userType, "type", "", "按用户类型筛选（后端 type 参数：admin / normal）")
	cmd.Flags().StringVar(&keyword, "keyword", "", "按名称关键字筛选（后端 keyword 参数）")
	return cmd
}

func (a *App) newUserGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "查看单个用户（GET /user/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("用户 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/user/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

// rejectLegacyUserToken 显式拒绝旧的 --token，不做静默兼容。
//
// 原因（#257 裁决）：`gtgw user create --token sk-admin-xxx` 会被理解成
// 「设置这个用户的 Token」，实际却把**管理员 Token 写进用户记录**——静默、且不可逆。
// 所以这个 flag 一出现就报参数错误（退出码 2），并且**不发任何请求**。
// 注意：因为这条命令声明了同名局部 flag，全局 --token（管理员 Token）在这些命令上依然被遮蔽，
// 管理员凭据请用 GTGW_TOKEN 环境变量或 profile。
func rejectLegacyUserToken(cmd *cobra.Command) error {
	if !cmd.Flags().Changed("token") {
		return nil
	}
	return client.Usagef("--token 已改名为 --user-token（该值会写进用户记录，避免误把管理员 Token 写进去）；"+
		"管理员 Token 请用 %s 环境变量或 profile 提供", config.EnvToken)
}

func (a *App) newUserCreateCmd() *cobra.Command {
	body := &bodySource{}
	var name, userToken, userType, legacyToken string
	cmd := &cobra.Command{
		Use:   "create",
		Short: "创建用户（POST /user/create.json）",
		Long: `两种传参：
  --file <path> / --key k=v       完整请求体
  --name / --user-token / --type  常用字段快捷方式（与 --file/--key 同时给出时以 --file/--key 为准）
不传 --user-token 时后端会自动生成一个 UUID。

注意：--user-token 是**用户自己的 Token**（会写进用户记录）。旧的 --token 已废弃并会直接报错，
避免把管理员 Token 误当成用户 Token 写进去；管理员 Token 用 GTGW_TOKEN 环境变量或 profile。`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := rejectLegacyUserToken(cmd); err != nil {
				return err
			}
			payload, err := body.buildOptional(a.in)
			if err != nil {
				return err
			}
			if payload == nil {
				payload = map[string]any{}
			}
			if name != "" {
				payload["name"] = name
			}
			if userToken != "" {
				payload["token"] = userToken
			}
			if userType != "" {
				payload["type"] = userType
			}
			if len(payload) == 0 {
				return client.Usagef("缺少请求体：用 --file/--key 或 --name/--user-token/--type 指定要创建的用户")
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/user/create.json", payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	cmd.Flags().StringVar(&name, "name", "", "用户名称")
	cmd.Flags().StringVar(&userToken, "user-token", "", "用户自己的 Token（不传则服务端生成）")
	cmd.Flags().StringVar(&userType, "type", "", "用户类型：admin / normal（默认 normal）")
	cmd.Flags().StringVar(&legacyToken, "token", "", "已废弃：请改用 --user-token")
	_ = cmd.Flags().MarkHidden("token")
	return cmd
}

func (a *App) newUserUpdateCmd() *cobra.Command {
	body := &bodySource{}
	var name, userToken, status, userType, legacyToken string
	cmd := &cobra.Command{
		Use:   "update <id>",
		Short: "更新用户（PUT /user/:id，仅提交给出的字段）",
		Long: `后端只更新请求体里出现的字段（见 userController.updateUser）。
--user-token "" 表示让服务端重新生成一个 Token（该值写进用户记录，不是管理员凭据）。`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := rejectLegacyUserToken(cmd); err != nil {
				return err
			}
			id, err := idArg("用户 id", args[0])
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
			if cmd.Flags().Changed("user-token") {
				payload["token"] = userToken
			}
			if cmd.Flags().Changed("status") {
				payload["status"] = status
			}
			if cmd.Flags().Changed("type") {
				payload["type"] = userType
			}
			if len(payload) == 0 {
				return client.Usagef("没有要修改的字段：用 --file/--key 或 --name/--user-token/--status/--type 指定")
			}
			resp, err := a.apiCall(cmd, http.MethodPut, "/user/"+id, payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	body.addFlags(cmd)
	cmd.Flags().StringVar(&name, "name", "", "用户名称")
	cmd.Flags().StringVar(&userToken, "user-token", "", "用户自己的 Token（传空串表示重新生成）")
	cmd.Flags().StringVar(&status, "status", "", "用户状态（如 enabled / disabled）")
	cmd.Flags().StringVar(&userType, "type", "", "用户类型：admin / normal")
	cmd.Flags().StringVar(&legacyToken, "token", "", "已废弃：请改用 --user-token")
	_ = cmd.Flags().MarkHidden("token")
	return cmd
}

func (a *App) newUserRechargeCmd() *cobra.Command {
	var amountRaw, remark, adjustType string
	cmd := &cobra.Command{
		Use:   "recharge <id>",
		Short: "给用户充值 / 调整余额（POST /user/:id/balance/adjust.json）",
		Long: `后端要求 body 含 amount（number）与 type（recharge 或 adjustment），remark 可选。
默认 type=recharge；需要做扣减/更正时用 --type adjustment（amount 为负数表示扣减）。`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("用户 id", args[0])
			if err != nil {
				return err
			}
			if strings.TrimSpace(amountRaw) == "" {
				return client.Usagef("缺少 --amount（后端要求 amount 为数字）")
			}
			amount, err := strconv.ParseFloat(strings.TrimSpace(amountRaw), 64)
			if err != nil {
				return client.Usagef("--amount 必须是数字，实际为 %q", amountRaw)
			}
			kind := adjustType
			if kind == "" {
				kind = "recharge"
			}
			if kind != "recharge" && kind != "adjustment" {
				return client.Usagef("--type 只能是 recharge 或 adjustment，实际为 %q", kind)
			}
			payload := map[string]any{"amount": amount, "type": kind}
			if remark != "" {
				payload["remark"] = remark
			}
			resp, err := a.apiCall(cmd, http.MethodPost, "/user/"+id+"/balance/adjust.json", payload)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	cmd.Flags().StringVar(&amountRaw, "amount", "", "金额（数字；调整时可为负数）")
	cmd.Flags().StringVar(&remark, "remark", "", "备注")
	cmd.Flags().StringVar(&adjustType, "type", "recharge", "类型：recharge（充值）或 adjustment（调整）")
	return cmd
}

// ---- balance ----

func (a *App) newBalanceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "balance",
		Short: "余额与充值记录（list / get）",
		Args:  noArgs,
	}
	cmd.AddCommand(a.newBalanceListCmd(), a.newBalanceGetCmd())
	return cmd
}

func (a *App) newBalanceListCmd() *cobra.Command {
	q := &listQuery{}
	var userID, recordType string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "列出充值记录（GET /balance/recharge/list.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			q.set("user_id", userID)
			q.set("type", recordType)
			resp, err := a.apiCall(cmd, http.MethodGet, "/balance/recharge/list.json"+q.String(), nil)
			if err != nil {
				return err
			}
			return a.outList(resp, balanceColumns)
		},
	}
	q.addCommonFlags(cmd)
	cmd.Flags().StringVar(&userID, "user-id", "", "只看某个用户的记录（后端 user_id 参数）")
	cmd.Flags().StringVar(&recordType, "type", "", "按记录类型筛选（后端 type 参数：recharge / adjustment）")
	return cmd
}

func (a *App) newBalanceGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "查看单条充值记录（GET /balance/recharge/:id）",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := idArg("充值记录 id", args[0])
			if err != nil {
				return err
			}
			resp, err := a.apiCall(cmd, http.MethodGet, "/balance/recharge/"+id, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}
