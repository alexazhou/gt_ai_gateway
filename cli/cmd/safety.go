package cmd

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
)

// 本文件是「破坏性 / 长耗时」命令的统一安全闸门。
//
// 由来（2026-11-15 #257 验收事故）：验收人把脚本拷到 /tmp 单独跑，mock 没起来，
// `login` 静默失败后 CLI 按 Tauri 回退连到了本机真实桌面端网关 127.0.0.1:6722，
// 于是 `recover-orphans` / `clear-payload` / `clear-all` / `user create` 等**真实生效**
// （服务端日志 6 个写请求全部 2xx，其中 clear-payload 跑了 193.9s）。
// 结论：只要连接来源是「自动回退」，破坏性操作就不能靠 -y 默默执行。

// 非幂等写操作超时后的统一提示。客户端超时 ≠ 服务端没执行：
// 事故里三个 DELETE 客户端全部 exit 1，服务端全部 200。
const nonIdempotentTimeoutHint = "服务端可能已执行，请先核对状态再重试（这些接口非幂等，直接重试等于二次执行）"

// fallbackDestructiveFlag 是回退连接下放行破坏性操作的唯一开关。
// 刻意与 -y 分开：-y 只表达「我知道这是删除」，不表达「我知道自己连的可能不是测试环境」。
const fallbackDestructiveFlag = "allow-fallback-destructive"

// connectionInfo 返回本次解析出来的连接地址与来源（flag/env/profile/tauri）。
func (a *App) connectionInfo() (baseURL, source string, err error) {
	res, err := a.Settings()
	if err != nil {
		return "", "", err
	}
	return res.BaseURL, res.Source("base_url"), nil
}

// isFallbackConnection 判断连接是否来自 Tauri 桌面端自动回退。
func (a *App) isFallbackConnection() bool {
	_, source, err := a.connectionInfo()
	if err != nil {
		return false
	}
	return source == config.SourceTauri
}

// guardDestructive 是破坏性命令的第一道闸门（必须早于任何网络请求与确认提示）。
//
//   - 连接来自 Tauri 自动回退、且未传 --allow-fallback-destructive ⇒ 退出码 2，不发请求；
//   - 回退 + 已显式放行 ⇒ 放行，但必须把来源打到 stderr（用户得知道自己连的是哪）；
//   - 显式 --url / GTGW_URL / profile ⇒ 不干预（原行为）。
func (a *App) guardDestructive(what string) error {
	baseURL, source, err := a.connectionInfo()
	if err != nil {
		return err
	}
	if source != config.SourceTauri {
		return nil
	}
	if !a.flagAllowFallbackDestructive {
		return client.Usagef(
			"%s：当前连接来自桌面端配置 %s（Tauri 自动回退，非 --url/GTGW_URL/profile）。\n"+
				"破坏性操作在回退连接下默认拒绝：请显式指定 --url 指向测试网关，\n"+
				"或确认这条连接就是你要操作的网关后加 --%s 放行（-y 不参与此判断）",
			what, baseURL, fallbackDestructiveFlag)
	}
	a.Printer().Info("当前连接来自桌面端配置：%s（已通过 --%s 显式放行）", baseURL, fallbackDestructiveFlag)
	return nil
}

// requireDestructive = guardDestructive + confirmDestructive。
//
// 顺序不能反：回退连接必须在问「确定吗」之前就拒绝，否则用户会以为 -y 能放行。
func (a *App) requireDestructive(what string) error {
	if err := a.guardDestructive(what); err != nil {
		return err
	}
	return a.confirmDestructive(what)
}

// withNonIdempotentHint 在超时错误上追加「服务端可能已执行」的提示。
// 非超时错误原样返回。
func withNonIdempotentHint(err error) error {
	if err == nil || !client.IsTimeout(err) {
		return err
	}
	return fmt.Errorf("%w\n提示：%s", err, nonIdempotentTimeoutHint)
}

// nonIdempotentTimeout 返回长耗时非幂等接口的默认超时。
//
// 依据：真实库上 clear-payload 实测 193.9s，默认 30s 必然超时（事故里就是这样：
// 客户端 exit 1，服务端 200）。所以这些命令的默认值放宽到 5 分钟，并允许 --timeout 覆盖。
const nonIdempotentTimeout = 5 * time.Minute

// addFallbackDestructiveFlagHint 给 --help 补一句说明（供破坏性命令复用）。
func destructiveLongWithSafety(base string) string {
	return base + `

安全约束：若连接来自 Tauri 桌面端自动回退（未传 --url / 未设 GTGW_URL / 无 profile），
本命令默认拒绝执行（退出码 2），需要 --` + fallbackDestructiveFlag + ` 才放行；
-y 只表示「我知道这是破坏性操作」，不放行回退连接。`
}

// requireNoExtraArgs 供无参数命令复用（避免每处重复写 cobra 校验）。
func requireNoExtraArgs(cmd *cobra.Command, args []string) error {
	return noArgs(cmd, args)
}
