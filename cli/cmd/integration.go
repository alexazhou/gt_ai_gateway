package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// integration env：生成可直接 `eval` 的环境变量导出脚本（step2 §3.5）。
//
// Base URL 口径**照抄后端适配器**，不自己发明：
//   - Claude Code 适配器 defaultGatewaySuffix = "/llm"（claudeCodeConfigAdapter.ts:10），
//     写入 ANTHROPIC_BASE_URL，SDK 自己在后面接 /v1/messages；
//   - Codex 适配器 defaultGatewaySuffix = "/llm/v1"（codexConfigAdapter.ts:11），
//     写入 base_url，SDK 自己在后面接 /chat/completions 或 /responses。
//
// 两条都在 tests/integration/service/clientConfigService.node.test.ts:114 有断言
// （ANTHROPIC_BASE_URL 期望 http://127.0.0.1:8720/llm）。
const (
	openAIBaseSuffix    = "/llm/v1"
	anthropicBaseSuffix = "/llm"
)

// shellQuoter 把值转成目标 shell 里安全的双引号字符串。
func shellQuote(shell, value string) string {
	switch shell {
	case "powershell":
		// PowerShell 双引号串：反引号是转义符，$ 会被当变量插值
		r := strings.NewReplacer("`", "``", "\"", "`\"", "$", "`$")
		return `"` + r.Replace(value) + `"`
	default:
		// POSIX 双引号串：转义 \ " $ ` 四个字符即可
		r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", `\$`, "`", "\\`")
		return `"` + r.Replace(value) + `"`
	}
}

// renderIntegrationEnv 生成四个环境变量的导出脚本。
func renderIntegrationEnv(shell, baseURL, apiKey string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return "", client.Usagef("没有可用的网关地址：请先 `gtgw login`，或传 --url / 设置 GTGW_URL")
	}
	openAIBase := base + openAIBaseSuffix
	anthropicBase := base + anthropicBaseSuffix

	vars := []struct{ name, value string }{
		{"OPENAI_BASE_URL", openAIBase},
		{"OPENAI_API_KEY", apiKey},
		{"ANTHROPIC_BASE_URL", anthropicBase},
		{"ANTHROPIC_AUTH_TOKEN", apiKey},
	}

	var b strings.Builder
	for _, v := range vars {
		switch shell {
		case "bash", "zsh":
			fmt.Fprintf(&b, "export %s=%s\n", v.name, shellQuote(shell, v.value))
		case "fish":
			fmt.Fprintf(&b, "set -gx %s %s\n", v.name, shellQuote(shell, v.value))
		case "powershell":
			fmt.Fprintf(&b, "$env:%s = %s\n", v.name, shellQuote(shell, v.value))
		default:
			return "", client.Usagef("未知 shell %q：可选 bash / zsh / fish / powershell", shell)
		}
	}
	return b.String(), nil
}

func (a *App) newIntegrationCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "integration",
		Short: "接入辅助（env：生成 OPENAI_*/ANTHROPIC_* 环境变量导出脚本）",
		Args:  noArgs,
	}
	cmd.AddCommand(a.newIntegrationEnvCmd())
	return cmd
}

func (a *App) newIntegrationEnvCmd() *cobra.Command {
	var (
		shell  string
		apiKey string
	)
	cmd := &cobra.Command{
		Use:   "env [--shell bash|zsh|fish|powershell] [--api-key <key>]",
		Short: "输出可直接 eval 的环境变量导出脚本（本地生成，不访问网关）",
		Long: `生成四个环境变量，指向当前网关：

  OPENAI_BASE_URL     <gateway>/llm/v1
  OPENAI_API_KEY      <token>
  ANTHROPIC_BASE_URL  <gateway>/llm
  ANTHROPIC_AUTH_TOKEN <token>

用法：
  eval "$(gtgw integration env)"
  gtgw integration env --shell fish | source
  gtgw integration env --shell powershell | Invoke-Expression

脚本只含 export/set 语句，不含任何注释或提示，保证 eval 之后环境干净。`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// 只读本地配置：不建客户端、不发请求（离线也能生成）
			res, err := a.Settings()
			if err != nil {
				return err
			}
			key := strings.TrimSpace(apiKey)
			if key == "" {
				key = res.Token
			}
			if key == "" {
				return client.Usagef("没有可用的 Token：请先 `gtgw login`，或传 --api-key / --token / 设置 GTGW_TOKEN")
			}
			script, err := renderIntegrationEnv(strings.ToLower(strings.TrimSpace(shell)), res.BaseURL, key)
			if err != nil {
				return err
			}
			_, werr := fmt.Fprint(a.out, script)
			return werr
		},
	}
	cmd.Flags().StringVar(&shell, "shell", "bash", "目标 shell：bash / zsh / fish / powershell")
	cmd.Flags().StringVar(&apiKey, "api-key", "", "写入 OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN 的 Token（默认用当前登录 Token）")
	return cmd
}
