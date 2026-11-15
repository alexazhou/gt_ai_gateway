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
// `login` 静默失败后 CLI 按当时存在的「隐式 tauri 回退」连到了本机真实桌面端网关
// 127.0.0.1:6722，于是 `recover-orphans` / `clear-payload` / `clear-all` / `user create`
// 等**真实生效**（服务端日志 6 个写请求全部 2xx，其中 clear-payload 跑了 193.9s）。
//
// 2026-11-15 口径变更（Operator 选 A）：隐式回退整层删除后，本机桌面端只作为一种
// **显式 profile** 存在（`gtgw login --from-tauri`）。闸门判据随之改为
// 「**当前生效 profile 是否带『来自本机桌面端』的持久标记**」：
//   - 是 ⇒ 破坏性命令默认拒绝（退出码 2、零请求），-y 不放行，需 --allow-local-destructive；
//   - 否（--url / GTGW_URL / 远端 profile）⇒ 不干预（保持原行为）。
//
// 判据只看 profile 里的持久标记，**不看 profile 名字**：`login --from-tauri --profile foo`
// 能把桌面端凭据存成任意名字，靠名字识别会被绕过。

// 非幂等写操作超时后的统一提示。客户端超时 ≠ 服务端没执行：
// 事故里三个 DELETE 客户端全部 exit 1，服务端全部 200。
const nonIdempotentTimeoutHint = "服务端可能已执行，请先核对状态再重试（这些接口非幂等，直接重试等于二次执行）"

// localDestructiveFlag 是本机桌面端 profile 下放行破坏性操作的唯一开关。
// 刻意与 -y 分开：-y 只表达「我知道这是删除」，不表达「我知道自己连的是本机桌面端网关」。
const localDestructiveFlag = "allow-local-destructive"

// connectionInfo 返回本次解析出来的连接地址与来源（flag/env/profile）。
func (a *App) connectionInfo() (baseURL, source string, err error) {
	res, err := a.Settings()
	if err != nil {
		return "", "", err
	}
	return res.BaseURL, res.Source("base_url"), nil
}

// isLocalDesktopConnection 判断当前连接是否来自「本机桌面端」profile，
// 命中时返回该 profile 名与目标地址（用于报错文案与确认提示）。
//
// 两条都要满足：
//  1. 生效 profile 带 FromDesktop 持久标记；
//  2. 生效的 base_url 就来自该 profile —— 用户若用 --url / GTGW_URL 覆盖了目标地址，
//     实际操作的不是桌面端网关，不该拦（这也是「其它 profile / 显式地址不拦」的口径）。
func (a *App) isLocalDesktopConnection() (profile, baseURL string, hit bool) {
	res, err := a.Settings()
	if err != nil || !res.ProfileFromDesktop {
		return "", "", false
	}
	if res.Source("base_url") != config.SourceProfile {
		return "", "", false
	}
	return res.ProfileName, res.BaseURL, true
}

// guardDestructive 是破坏性命令的第一道闸门（必须早于任何网络请求与确认提示）。
//
//   - 当前 profile 来自本机桌面端、且未传 --allow-local-destructive ⇒ 退出码 2，不发请求；
//   - 命中且已显式放行 ⇒ 放行，但必须把 profile 名与目标地址打到 stderr（用户得知道自己连的是哪）；
//   - 其它来源 ⇒ 不干预。
func (a *App) guardDestructive(what string) error {
	profile, baseURL, hit := a.isLocalDesktopConnection()
	if !hit {
		return nil
	}
	if !a.flagAllowLocalDestructive {
		return client.Usagef(
			"%s：当前 profile %q 来自本机桌面端（%s）。\n"+
				"破坏性操作在本机桌面端 profile 上默认拒绝：请显式指定 --url 指向测试网关，\n"+
				"或确认这条连接就是你要操作的网关后加 --%s 放行（-y 不参与此判断）",
			what, profile, baseURL, localDestructiveFlag)
	}
	a.Printer().Info("当前 profile %q 来自本机桌面端：%s（已通过 --%s 显式放行）", profile, baseURL, localDestructiveFlag)
	return nil
}

// requireDestructive = guardDestructive + confirmDestructive。
//
// 顺序不能反：本机桌面端 profile 必须在问「确定吗」之前就拒绝，否则用户会以为 -y 能放行。
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

// destructiveLongWithSafety 给破坏性命令的 --help 补一段安全说明（供复用）。
func destructiveLongWithSafety(base string) string {
	return base + `

安全约束：若当前生效 profile 带「来自本机桌面端」标记（由 ` + "`gtgw login --from-tauri`" + ` 写入），
本命令默认拒绝执行（退出码 2），需要 --` + localDestructiveFlag + ` 才放行；
-y 只表示「我知道这是破坏性操作」，不放行本机桌面端 profile。`
}

// requireNoExtraArgs 供无参数命令复用（避免每处重复写 cobra 校验）。
func requireNoExtraArgs(cmd *cobra.Command, args []string) error {
	return noArgs(cmd, args)
}
