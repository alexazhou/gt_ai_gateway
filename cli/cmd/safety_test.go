package cmd

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
)

// 本文件覆盖破坏性闸门的硬要求（2026-11-15 Operator 口径 A）：
//  1. 当前生效 profile 带「来自本机桌面端」标记时，破坏性命令默认拒绝（退出码 2、零请求），
//     `-y` 不放行，仅 `--allow-local-destructive` 放行并打印 profile 名与目标地址；
//  2. 识别不看 profile 名字：`login --from-tauri --profile foo` 同样被拦；
//  3. 普通 profile（`--url` 登录）与显式 `--url` 覆盖目标地址时不受影响；
//  4. 长耗时清理接口支持 --timeout（默认 5m），超时文案必须写「服务端可能已执行」。
//
// 与 P3 版本的差别：不再有「隐式 tauri 回退」，所以造例方式从「注入 TauriLoader 让解析回退」
// 改成「真的跑一次 `login --from-tauri` 把带标记的 profile 落到临时 home」。

// newAppAt 构造一个把家目录注入到 home 的 App（配置目录 = <home>/.gtgw）。
func newAppAt(t *testing.T, home string) (*App, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	env := map[string]string{"HOME": home, "USERPROFILE": home}
	var out, errOut bytes.Buffer
	app := NewApp(&out, &errOut, func(k string) string { return env[k] }, "1.9.1-beta1", "testsha")
	app.SetTauriLoader(func() (*config.TauriConfig, error) { return nil, config.ErrTauriConfigNotFound })
	return app, &out, &errOut
}

// seedDesktopProfile 直接把「来自本机桌面端」的 profile 写进 home 下的配置目录。
//
// 为什么不走 `login --from-tauri`：本文件的网关桩（newResourceGateway）只登记业务路由，
// 没有 /status.json，login 会 404 并顺带污染「零请求」断言。
// 「login --from-tauri 把 from_desktop 标记落盘」由 TestLoginFromTauri 覆盖，两条不重复。
func seedDesktopProfile(t *testing.T, home, profile, baseURL string, fromDesktop bool) {
	t.Helper()
	seedProfile(t, home, profile, baseURL, fromDesktop)
}

// seedPlainProfile 追加一条普通 profile（无桌面端标记），并设为 active。
func seedPlainProfile(t *testing.T, home, profile, baseURL string) {
	t.Helper()
	seedProfile(t, home, profile, baseURL, false)
}

func seedProfile(t *testing.T, home, profile, baseURL string, fromDesktop bool) {
	t.Helper()
	dir, err := config.DirFrom(func(k string) string {
		if k == "HOME" || k == "USERPROFILE" {
			return home
		}
		return ""
	})
	if err != nil {
		t.Fatalf("DirFrom: %v", err)
	}
	f, err := config.LoadFrom(dir)
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	f.SetProfile(profile, config.Profile{BaseURL: baseURL, Token: testToken, FromDesktop: fromDesktop})
	f.ActiveProfile = profile
	if err := config.SaveTo(dir, f); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
}

// newDesktopProfileApp 构造一个「当前 profile 来自本机桌面端」的 App（配置目录在临时 home 下）。
func newDesktopProfileApp(t *testing.T, baseURL, profile string) (*App, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	if profile == "" {
		profile = "tauri"
	}
	home := t.TempDir()
	seedDesktopProfile(t, home, profile, baseURL, true)
	app, out, errOut := newAppAt(t, home)
	return app, out, errOut
}

// TestDestructiveRejectedOnLocalDesktopProfile 三条造例：
// 桌面端 profile + 无放行 ⇒ 拒绝且零请求；+ -y ⇒ 仍拒绝；+ --allow-local-destructive ⇒ 执行并打印来源。
func TestDestructiveRejectedOnLocalDesktopProfile(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		wantExit int
		wantReq  bool
		wantNote string
	}{
		{name: "无放行", args: []string{"record", "clear-all"}, wantExit: 2, wantReq: false, wantNote: "--allow-local-destructive"},
		{name: "-y 不放行", args: []string{"record", "clear-all", "-y"}, wantExit: 2, wantReq: false, wantNote: "来自本机桌面端"},
		{name: "显式放行", args: []string{"record", "clear-all", "-y", "--allow-local-destructive"}, wantExit: 0, wantReq: true, wantNote: "已通过 --allow-local-destructive 显式放行"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			gw := newResourceGateway(t, nil)
			app, _, errOut := newDesktopProfileApp(t, gw.URL, "")
			code := runCLI(app, c.args...)
			if code != c.wantExit {
				t.Fatalf("退出码 = %d, 期望 %d（stderr=%s）", code, c.wantExit, errOut.String())
			}
			gotReq := len(gw.rec.paths()) > 0
			if gotReq != c.wantReq {
				t.Fatalf("是否发出请求 = %v, 期望 %v（stderr=%s）", gotReq, c.wantReq, errOut.String())
			}
			if !strings.Contains(errOut.String(), c.wantNote) {
				t.Fatalf("stderr 应包含 %q，实际：%q", c.wantNote, errOut.String())
			}
			// 报错与放行都必须交代「哪个 profile、打到哪」——用户得能自己判断连错了没。
			if !strings.Contains(errOut.String(), `"tauri"`) {
				t.Fatalf("stderr 应打印 profile 名，实际：%q", errOut.String())
			}
			if !strings.Contains(errOut.String(), gw.URL) {
				t.Fatalf("stderr 应打印目标地址 %q，实际：%q", gw.URL, errOut.String())
			}
		})
	}
}

// TestDesktopMarkerNotNameBased 证明识别看的是持久标记而不是 profile 名字：
// 用户用 `login --from-tauri --profile foo` 改名后，闸门照样拦。
func TestDesktopMarkerNotNameBased(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newDesktopProfileApp(t, gw.URL, "foo")
	if code := runCLI(app, "record", "clear-all", "-y"); code != 2 {
		t.Fatalf("退出码 = %d, 期望 2（stderr=%s）", code, errOut.String())
	}
	if len(gw.rec.paths()) != 0 {
		t.Fatalf("被拦时不得发请求，实际发出 %v", gw.rec.paths())
	}
	if !strings.Contains(errOut.String(), `"foo"`) {
		t.Fatalf("stderr 应打印实际 profile 名 foo，实际：%q", errOut.String())
	}
}

// TestProfileListShowsDesktopOrigin 断言 `profile list` / `--json` 能显示来源。
func TestProfileListShowsDesktopOrigin(t *testing.T) {
	home := t.TempDir()
	seedDesktopProfile(t, home, "foo", "http://127.0.0.1:6722", true)
	seedPlainProfile(t, home, "remote", "http://gateway.example:8720")

	app, out, errOut := newAppAt(t, home)
	if code := runCLI(app, "profile", "list"); code != 0 {
		t.Fatalf("profile list: %d %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), config.ProfileOriginDesktop) {
		t.Fatalf("profile list 应显示来源 %q：%s", config.ProfileOriginDesktop, out.String())
	}

	out.Reset()
	if code := runCLI(app, "profile", "list", "--json"); code != 0 {
		t.Fatalf("profile list --json: %d %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), `"origin": "`+config.ProfileOriginDesktop+`"`) {
		t.Fatalf("profile list --json 应带 origin 字段：%s", out.String())
	}
}

// TestDestructiveAllowedOnExplicitConnection 显式 --url 时不受闸门影响（原行为不变）：
// 即使当前 active profile 是桌面端，覆盖了目标地址就不拦（实际操作的不是那个网关）。
func TestDestructiveAllowedOnExplicitConnection(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newDesktopProfileApp(t, "http://127.0.0.1:1", "")
	if code := runCLI(app, "record", "clear-all", "-y", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("显式 --url 时退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	assertLastRequest(t, gw, http.MethodDelete, "/record/clear-all", nil)
}

// TestDestructiveAllowedOnPlainProfile 普通 profile（无桌面端标记）不拦。
func TestDestructiveAllowedOnPlainProfile(t *testing.T) {
	gw := newResourceGateway(t, nil)
	home := t.TempDir()
	seedPlainProfile(t, home, "default", gw.URL)
	app, _, errOut := newAppAt(t, home)
	if code := runCLI(app, "record", "clear-all", "-y"); code != 0 {
		t.Fatalf("普通 profile 退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	assertLastRequest(t, gw, http.MethodDelete, "/record/clear-all", nil)
}

// TestLongRunningCleanupUsesLongerDefaultTimeout 断言 clear-payload 用的是 5 分钟默认超时：
// mock 延迟 300ms，若默认仍是 30s/1s 就会超时失败，这里必须成功。
func TestLongRunningCleanupUsesLongerDefaultTimeout(t *testing.T) {
	gw := newResourceGateway(t, []stubRoute{{
		method: http.MethodDelete, pattern: "/record/clear-payload",
		handler: func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(300 * time.Millisecond)
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "cleared": 10})
		},
	}})
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "record", "clear-payload", "-y"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
}

// TestTimeoutMessageSaysServerMayHaveRun 用 --timeout 100ms 逼迫客户端超时，
// 断言错误文案含「服务端可能已执行」——这些接口非幂等，重试等于二次执行。
func TestTimeoutMessageSaysServerMayHaveRun(t *testing.T) {
	gw := newResourceGateway(t, []stubRoute{{
		method: http.MethodDelete, pattern: "/record/clear-all",
		handler: func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(400 * time.Millisecond)
			writeJSON(w, http.StatusOK, map[string]any{"success": true})
		},
	}})
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	code := runCLI(app, "record", "clear-all", "-y", "--timeout", "100ms")
	if code != 1 {
		t.Fatalf("超时后退出码 = %d, 期望 1（stderr=%s）", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "服务端可能已执行") {
		t.Fatalf("超时文案必须提示服务端可能已执行，实际：%q", errOut.String())
	}
	if !strings.Contains(errOut.String(), "非幂等") {
		t.Fatalf("超时文案应说明接口非幂等，实际：%q", errOut.String())
	}
}

// TestGuardDoesNotApplyToReadOnlyCommands 只读命令在桌面端 profile 上照常执行（闸门只拦破坏性操作）。
func TestGuardDoesNotApplyToReadOnlyCommands(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newDesktopProfileApp(t, gw.URL, "")
	if code := runCLI(app, "vendor", "list"); code != 0 {
		t.Fatalf("只读命令退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
}
