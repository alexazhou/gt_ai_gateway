package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// 客户端接入管理（step2 §3.5）。
//
// 后端语义（src/service/clientConfigService/core.ts）：
//   - 这些接口读写的是**网关所在机器**上的客户端配置文件（~/.claude、~/.codex 等），
//     不是 CLI 本机的文件；worker 模式下会直接报「请本地安装后使用」；
//   - 因此 apply / sync-from-local / backup delete 会真实改动文件或丢数据，走破坏性闸门。
//
// 命名以代码为准：ClientName 的真实取值是 `claude-code` / `codex`
// （doc step2 写的 `claude_code` 是文档笔误，不实现软别名——文档偏差以代码为准，
// 见 route-command-map.md 偏差小节 D4）。
const (
	clientConfigStatusPath = "/client-config/status.json"
	clientConfigLocalPath  = "/client-config/local.json"
	clientConfigCreatePath = "/client-config/create.json"
	clientConfigBackupPath = "/client-config/backup.json"
	clientBackupRenamePath = "/client-config/backup/rename.json"
	clientBackupDeletePath = "/client-config/backup/delete.json"
	clientBackupUpdatePath = "/client-config/backup/update.json"
	clientConfigApplyPath  = "/client-config/apply.json"
	clientSyncLocalPath    = "/client-config/sync-from-local.json"
)

// clientNames 是 ClientName 枚举的合法取值（后端 src/constants.ts:80）。
var clientNames = []string{"claude-code", "codex"}

// connectionModes 是 ConnectionMode 枚举的合法取值（后端 src/constants.ts:85）。
var connectionModes = []string{"gateway", "vendor", "official"}

// validateClientName 校验客户端名并给出可操作提示。
func validateClientName(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", client.Usagef("缺少 client：可选值 %s", strings.Join(clientNames, " / "))
	}
	for _, name := range clientNames {
		if v == name {
			return v, nil
		}
	}
	hint := ""
	if strings.Contains(v, "_") {
		hint = "（注意后端枚举用连字符：claude-code 而不是 claude_code）"
	}
	return "", client.Usagef("未知 client %q%s：可选值 %s", raw, hint, strings.Join(clientNames, " / "))
}

// requireFields 校验请求体里的必填字段（缺失或空串都算缺）。
func requireFields(body map[string]any, fields ...string) error {
	missing := make([]string, 0, len(fields))
	for _, f := range fields {
		if v, ok := body[f]; !ok || v == nil || strings.TrimSpace(fmt.Sprint(v)) == "" {
			missing = append(missing, f)
		}
	}
	if len(missing) > 0 {
		return client.Usagef("请求体缺少必填字段：%s", strings.Join(missing, ", "))
	}
	return nil
}

// normalizeClientBody 校验并规范化 client / connectionMode 两个枚举字段。
func normalizeClientBody(body map[string]any) (map[string]any, error) {
	if raw, ok := body["client"]; ok && raw != nil {
		name, err := validateClientName(fmt.Sprint(raw))
		if err != nil {
			return nil, err
		}
		body["client"] = name
	}
	if raw, ok := body["connectionMode"]; ok && raw != nil {
		mode := strings.TrimSpace(fmt.Sprint(raw))
		valid := false
		for _, m := range connectionModes {
			if mode == m {
				valid = true
				break
			}
		}
		if !valid {
			return nil, client.Usagef("connectionMode 只能是 %s，实际为 %q", strings.Join(connectionModes, " / "), mode)
		}
		body["connectionMode"] = mode
	}
	// backupId 既可能是数字也可能被写成字符串，统一成整数发出去（后端按 number 校验）
	if raw, ok := body["backupId"]; ok && raw != nil {
		text := strings.TrimSpace(fmt.Sprint(raw))
		id, err := strconv.Atoi(text)
		if err != nil || id <= 0 {
			return nil, client.Usagef("backupId 必须是正整数，实际为 %q", text)
		}
		body["backupId"] = id
	}
	return body, nil
}

func (a *App) newClientCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "client",
		Short: "客户端接入配置管理（status / local / create / apply / sync-from-local / backup）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		a.newClientStatusCmd(),
		a.newClientLocalCmd(),
		a.newClientCreateCmd(),
		a.newClientApplyCmd(),
		a.newClientSyncCmd(),
		a.newClientBackupCmd(),
	)
	return cmd
}

func (a *App) newClientStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "查看两个客户端（claude-code / codex）的安装、配置与备份状态",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			resp, err := a.apiCall(cmd, "GET", clientConfigStatusPath, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
}

func (a *App) newClientLocalCmd() *cobra.Command {
	var clientName string
	cmd := &cobra.Command{
		Use:   "local --client <claude-code|codex>",
		Short: "读取网关所在机器上该客户端的当前配置（GET /client-config/local.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			name, err := validateClientName(clientName)
			if err != nil {
				return err
			}
			path := clientConfigLocalPath + "?client=" + name
			resp, err := a.apiCall(cmd, "GET", path, nil)
			if err != nil {
				return err
			}
			return a.outObject(resp)
		},
	}
	cmd.Flags().StringVar(&clientName, "client", "", "客户端名：claude-code 或 codex（必填）")
	return cmd
}

// newClientFileCmd 生成「--file 驱动」的客户端配置命令，统一处理解析与字段校验。
func (a *App) newClientFileCmd(use, short, path string, required []string, destructive string) *cobra.Command {
	var src bodySource
	cmd := &cobra.Command{
		Use:   use,
		Short: short,
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			body, err := src.build(a.in)
			if err != nil {
				return err
			}
			body, err = normalizeClientBody(body)
			if err != nil {
				return err
			}
			if err := requireFields(body, required...); err != nil {
				return err
			}
			// 闸门必须在解析完参数、发请求之前
			if destructive != "" {
				if err := a.requireDestructive(destructive); err != nil {
					return err
				}
			}
			resp, err := a.apiCall(cmd, "POST", path, body)
			if err != nil {
				return err
			}
			if a.flagQuiet {
				return nil
			}
			return a.outObject(resp)
		},
	}
	src.addFlags(cmd)
	return cmd
}

func (a *App) newClientCreateCmd() *cobra.Command {
	cmd := a.newClientFileCmd("create",
		"新建客户端配置（POST /client-config/create.json，请求体需含 client / gatewayUrl / apiKey / model）",
		clientConfigCreatePath, []string{"client", "gatewayUrl", "apiKey", "model"}, "")
	cmd.Long = `新建一份客户端配置（写入网关数据库，不落地文件）。

请求体字段（见 src/service/clientConfigService/types.ts:CreateClientConfigParams）：
  client           claude-code / codex
  connectionMode   gateway / vendor / official（可选）
  gatewayUrl       网关地址
  apiKey           API Key（vendor/official 模式由服务端按 vendorId/userId 反查填充）
  model            模型名
  vendorId         供应商 ID（vendor 模式，可选）
  userId           用户 ID（可选）

用 --file <path>（或 --file - 从 stdin）传 JSON，也可用 --key k=v 逐项给。`
	return cmd
}

func (a *App) newClientApplyCmd() *cobra.Command {
	cmd := a.newClientFileCmd("apply",
		"把某个备份应用到本机客户端配置（POST /client-config/apply.json，会覆盖现有配置文件）",
		clientConfigApplyPath, []string{"client", "backupId"},
		"把备份覆盖写入网关所在机器上的客户端配置文件")
	cmd.Long = destructiveLongWithSafety(`把指定备份应用到客户端的真实配置文件。

请求体：{"client":"claude-code","backupId":12}

注意：这一步会读取并改写网关所在机器上的配置文件（不是 CLI 本机），
成功后该备份会被置为 enabled。`)
	return cmd
}

func (a *App) newClientSyncCmd() *cobra.Command {
	cmd := a.newClientFileCmd("sync-from-local",
		"用本机客户端配置覆盖某个备份（POST /client-config/sync-from-local.json）",
		clientSyncLocalPath, []string{"client", "backupId"},
		"用网关机器上的当前客户端配置覆盖指定备份（备份原内容会被替换）")
	cmd.Long = destructiveLongWithSafety(`把网关所在机器上的客户端配置回读进指定备份，覆盖备份原有内容。

请求体：{"client":"claude-code","backupId":12}

注意：备份原内容不可恢复，属于破坏性操作。`)
	return cmd
}

func (a *App) newClientBackupCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "backup",
		Short: "客户端配置备份（create / rename / update / delete）",
		Args:  noArgs,
	}

	create := a.newClientFileCmd("create",
		"新建备份（POST /client-config/backup.json；不带 configContent 时由服务端回读当前配置）",
		clientConfigBackupPath, []string{"client"}, "")
	create.Long = `新建一份客户端配置备份。

请求体：{"client":"claude-code","name":"可选名字","enabled":false,"configContent":{...}}
configContent 省略时，服务端会读取当前配置文件作为备份内容。`

	rename := a.newClientFileCmd("rename",
		"重命名备份（POST /client-config/backup/rename.json，需 client / backupId / name）",
		clientBackupRenamePath, []string{"client", "backupId", "name"}, "")

	update := a.newClientFileCmd("update",
		"更新备份内容（POST /client-config/backup/update.json，需 client / backupId 与要改的字段）",
		clientBackupUpdatePath, []string{"client", "backupId"}, "")

	del := a.newClientFileCmd("delete",
		"删除备份（POST /client-config/backup/delete.json，需 client / backupId）",
		clientBackupDeletePath, []string{"client", "backupId"},
		"删除指定客户端配置备份")
	del.Long = destructiveLongWithSafety(`删除一份客户端配置备份。

请求体：{"client":"claude-code","backupId":12}

删除不可恢复。`)

	cmd.AddCommand(create, rename, update, del)
	return cmd
}
