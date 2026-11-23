// Package cmd 组装 gtgw 的命令树。
//
// 约定：
//   - 所有命令都通过 App 拿输出流、环境变量与全局 Flag，便于集成测试注入；
//   - RunE 返回的错误携带退出码语义（见 internal/client），由 App.Execute 统一映射；
//   - 人类提示一律写 stderr，stdout 只放数据（保证 --json 纯净）。
package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/output"
)

// App 承载一次 CLI 执行所需的全部可变状态。
type App struct {
	out     io.Writer
	errOut  io.Writer
	in      *os.File
	getenv  func(string) string
	version string
	commit  string
	// tauriLoader 让测试注入 Tauri 配置来源；nil 表示读本机真实桌面端配置。
	tauriLoader func() (*config.TauriConfig, error)

	// 全局 Flag
	flagURL     string
	flagToken   string
	flagTenant  string
	flagProfile string
	flagJSON    bool
	flagQuiet   bool
	flagYes     bool
	flagTimeout time.Duration
	// flagAllowLocalDestructive 允许在「本机桌面端 profile」连接上执行破坏性命令。
	// 与 -y 分开：-y 只表达「我知道这是删除」，不表达「我知道可能连错了网关」。
	flagAllowLocalDestructive bool

	// 解析结果缓存（一次执行内只解析一次）
	resolved    *config.Resolved
	file        *config.File
	fileLoaded  bool
	settingsErr error
}

// NewApp 构造一个 App。out / errOut 为 nil 时分别退化为 os.Stdout / os.Stderr；
// getenv 为 nil 时使用 os.Getenv。
func NewApp(out, errOut io.Writer, getenv func(string) string, version, commit string) *App {
	if out == nil {
		out = os.Stdout
	}
	if errOut == nil {
		errOut = os.Stderr
	}
	if getenv == nil {
		getenv = os.Getenv
	}
	return &App{
		out:     out,
		errOut:  errOut,
		in:      os.Stdin,
		getenv:  getenv,
		version: version,
		commit:  commit,
	}
}

// SetStdin 允许测试注入 stdin。
func (a *App) SetStdin(f *os.File) { a.in = f }

// SetTauriLoader 允许测试注入 Tauri 配置来源（默认读本机桌面端配置文件）。
func (a *App) SetTauriLoader(f func() (*config.TauriConfig, error)) { a.tauriLoader = f }

// loadTauri 读取 Tauri 桌面端配置。
func (a *App) loadTauri() (*config.TauriConfig, error) {
	if a.tauriLoader != nil {
		return a.tauriLoader()
	}
	return config.LoadTauriConfigFrom(a.getenv)
}

// Printer 返回按全局 Flag 构造的输出器。
func (a *App) Printer() *output.Printer {
	return output.New(a.out, a.errOut, a.flagJSON, a.flagQuiet)
}

// versionString 返回 `--version` 的展示文本。
func (a *App) versionString() string {
	v := a.version
	if v == "" {
		v = "dev"
	}
	if a.commit != "" {
		return fmt.Sprintf("gtgw version %s (commit %s)", v, a.commit)
	}
	return fmt.Sprintf("gtgw version %s", v)
}

// NewRootCmd 构造全新的命令树。每次执行都重建，避免测试之间 Flag 状态互相污染。
func (a *App) NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "gtgw",
		Short: "Serverless AI Gateway 命令行工具",
		Long: `gtgw 通过网关的 REST API 管理供应商、模型、用户、租户、规则与请求记录，
支持多环境 Profile、JSON 管道输出与实时请求流监控。`,
		Version:       a.versionString(),
		SilenceUsage:  true,
		SilenceErrors: true,
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return client.Usagef("未知子命令 %q，可用 `gtgw --help` 查看命令列表", args[0])
			}
			return nil
		},
	}
	root.SetOut(a.out)
	root.SetErr(a.errOut)
	root.SetVersionTemplate("{{.Version}}\n")

	pf := root.PersistentFlags()
	pf.StringVar(&a.flagURL, "url", "", "网关地址（覆盖 GTGW_URL 与 profile 中的 base_url）")
	pf.StringVar(&a.flagToken, "token", "", "管理员 Token（覆盖 GTGW_TOKEN 与 profile 中的 token）")
	pf.StringVar(&a.flagTenant, "tenant", "", "租户视角（id 或名称，覆盖 GTGW_TENANT 与 profile 默认租户）")
	pf.StringVar(&a.flagProfile, "profile", "", "使用指定 profile（默认用 active_profile）")
	pf.BoolVar(&a.flagJSON, "json", false, "以 JSON 输出到 stdout（提示与错误仍走 stderr）")
	pf.BoolVarP(&a.flagQuiet, "quiet", "q", false, "精简输出：仅打印关键标识")
	pf.BoolVarP(&a.flagYes, "yes", "y", false, "跳过危险操作的二次确认")
	pf.DurationVar(&a.flagTimeout, "timeout", 0, "请求超时（如 30s / 2m），0 表示使用命令默认值")
	pf.BoolVar(&a.flagAllowLocalDestructive, localDestructiveFlag, false,
		"允许在当前 profile 是本机桌面端（login --from-tauri）时执行破坏性命令（默认拒绝；-y 不放行）")

	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return client.Usagef("%v", err)
	})

	root.AddCommand(
		// 会话与系统（P1）
		a.newLoginCmd(),
		a.newLogoutCmd(),
		a.newProfileCmd(),
		a.newStatusCmd(),
		a.newUpdateCmd(),
		a.newDashboardCmd(),
		a.newConfigCmd(),
		// 资源域（P2）
		a.newVendorCmd(),
		a.newModelCmd(),
		a.newUserCmd(),
		a.newBalanceCmd(),
		a.newTenantCmd(),
		a.newRuleCmd(),
		a.newRecordCmd(),
		// 客户端接入与自测（P3）
		a.newClientCmd(),
		a.newTestCmd(),
		a.newIntegrationCmd(),
	)
	return root
}

// Execute 执行一次命令并返回进程退出码。
func (a *App) Execute(ctx context.Context, args []string) int {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt)
	defer stop()

	root := a.NewRootCmd()
	root.SetArgs(args)
	if err := root.ExecuteContext(ctx); err != nil {
		a.printError(err)
		return client.ExitCodeOf(err)
	}
	return client.ExitOK
}

// errorBodyPreviewLimit 是「未知错误形态」时暴露原文的最大字节数（rune 截断）。
const errorBodyPreviewLimit = 512

// printError 把错误写到 stderr：--json 模式下输出结构化 JSON，否则输出人类可读文本。
//
// 不允许吞掉原始响应体：后端错误体有三种已知形态（业务错 {error,code?}、500 带 request_id、
// 401/403 只有 {error}），但网关前面可能挂着反向代理/网关自身的 502 HTML 页。
// 一旦解析不出结构化字段，必须把 body 截断后暴露出来，否则运维只会看到一句没有信息的错误。
func (a *App) printError(err error) {
	p := a.Printer()
	apiErr, isAPI := err.(*client.APIError)

	if !p.JSON {
		fmt.Fprintf(a.errOut, "Error: %s\n", err.Error())
		if isAPI && !apiErr.HasStructuredMessage() {
			if preview := apiErr.BodyPreview(errorBodyPreviewLimit); preview != "" {
				fmt.Fprintf(a.errOut, "原始响应体（前 %d 字节）：%s\n", errorBodyPreviewLimit, preview)
			}
		}
		return
	}

	extra := map[string]any{}
	if isAPI {
		extra["status"] = apiErr.StatusCode
		if apiErr.Code != "" {
			extra["code"] = apiErr.Code
		}
		if apiErr.RequestID != "" {
			extra["request_id"] = apiErr.RequestID
		}
		if preview := apiErr.BodyPreview(errorBodyPreviewLimit); preview != "" {
			extra["body"] = preview
		}
	}
	p.JSONError(err, extra)
}

// ---- 配置与客户端装配 ----

// loadFile 读取本地配置文件（一次执行内只读一次）。
func (a *App) loadFile() (*config.File, error) {
	if a.fileLoaded {
		return a.file, nil
	}
	dir, err := config.DirFrom(a.getenv)
	if err != nil {
		return nil, err
	}
	f, err := config.LoadFrom(dir)
	if err != nil {
		return nil, err
	}
	a.file, a.fileLoaded = f, true
	return f, nil
}

// saveFile 原子写回本地配置文件。
func (a *App) saveFile(f *config.File) error {
	dir, err := config.DirFrom(a.getenv)
	if err != nil {
		return err
	}
	return config.SaveTo(dir, f)
}

// Settings 返回合并后的生效配置（缓存）。
func (a *App) Settings() (config.Resolved, error) {
	if a.resolved != nil {
		return *a.resolved, nil
	}
	if a.settingsErr != nil {
		return config.Resolved{}, a.settingsErr
	}
	f, err := a.loadFile()
	if err != nil {
		a.settingsErr = err
		return config.Resolved{}, err
	}
	res, err := config.Resolve(config.ResolveOptions{
		URL:         a.flagURL,
		Token:       a.flagToken,
		Tenant:      a.flagTenant,
		ProfileName: a.flagProfile,
		Getenv:      a.getenv,
		File:        f,
	})
	if err != nil {
		a.settingsErr = err
		return config.Resolved{}, err
	}
	a.resolved = &res
	return res, nil
}

// NewClient 按生效配置构造 HTTP 客户端。
func (a *App) NewClient(timeout time.Duration) (*client.Client, config.Resolved, error) {
	res, err := a.Settings()
	if err != nil {
		return nil, res, err
	}
	if res.BaseURL == "" {
		return nil, res, client.Usagef("没有可用的网关地址：请先 `gtgw login`，或传 --url / 设置 GTGW_URL")
	}
	if res.Token == "" {
		return nil, res, &client.UsageError{Msg: "没有可用的 Token：请先 `gtgw login`，或传 --token / 设置 GTGW_TOKEN"}
	}
	effTimeout := timeout
	if a.flagTimeout > 0 {
		effTimeout = a.flagTimeout
	}
	c, err := client.New(client.Options{
		BaseURL: res.BaseURL,
		Token:   res.Token,
		Tenant:  res.Tenant,
		Timeout: effTimeout,
	})
	if err != nil {
		return nil, res, err
	}
	return c, res, nil
}

// noArgs 校验「不接受位置参数」，失败时归为参数错误（退出码 2）。
func noArgs(cmd *cobra.Command, args []string) error {
	if len(args) > 0 {
		return client.Usagef("%s 不接受位置参数，实际收到：%s", cmd.CommandPath(), strings.Join(args, " "))
	}
	return nil
}

// exactArgs 校验位置参数个数，失败时归为参数错误（退出码 2）。
func exactArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) != n {
			return client.Usagef("%s 需要 %d 个参数，实际收到 %d 个", cmd.CommandPath(), n, len(args))
		}
		return nil
	}
}
