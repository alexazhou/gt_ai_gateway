package cmd

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
)

// 本文件覆盖 #258 的三条安全硬要求：
//  1. 连接来源是 Tauri 自动回退时，破坏性命令默认拒绝（-y 不放行），仅 --allow-fallback-destructive 放行；
//  2. 长耗时清理接口支持 --timeout（默认 5m）；
//  3. 任何超时的文案必须写「服务端可能已执行，请先核对状态再重试」。

// newFallbackTestApp 构造一个「只有桌面端配置可用」的 App：没有 --url、没有 GTGW_URL、没有 profile，
// 于是配置解析会走 Tauri 回退（Source = tauri），模拟 #257 事故的现场。
func newFallbackTestApp(t *testing.T, baseURL string) (*App, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	dir := t.TempDir()
	env := map[string]string{config.EnvXDGConfigHome: dir}
	var out, errOut bytes.Buffer
	app := NewApp(&out, &errOut, func(k string) string { return env[k] }, "1.9.1-beta1", "testsha")
	app.SetTauriLoader(func() (*config.TauriConfig, error) {
		return &config.TauriConfig{BaseURL: baseURL, Token: testToken, Host: "127.0.0.1", Port: 6722, Path: "/fixture/tauri.json"}, nil
	})
	return app, &out, &errOut
}

// TestDestructiveRejectedOnFallbackConnection 三条造例：
// 回退 + 无放行 ⇒ 拒绝且零请求；回退 + -y ⇒ 仍拒绝；回退 + --allow-fallback-destructive ⇒ 执行并打印来源。
func TestDestructiveRejectedOnFallbackConnection(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		wantExit int
		wantReq  bool
		wantNote string
	}{
		{name: "回退+无放行", args: []string{"record", "clear-all"}, wantExit: 2, wantReq: false, wantNote: "--allow-fallback-destructive"},
		{name: "回退+-y（不放行）", args: []string{"record", "clear-all", "-y"}, wantExit: 2, wantReq: false, wantNote: "破坏性操作在回退连接下默认拒绝"},
		{name: "回退+显式放行", args: []string{"record", "clear-all", "-y", "--allow-fallback-destructive"}, wantExit: 0, wantReq: true, wantNote: "当前连接来自桌面端配置"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			gw := newResourceGateway(t, nil)
			app, _, errOut := newFallbackTestApp(t, gw.URL)
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
			if c.wantReq && !strings.Contains(errOut.String(), gw.URL) {
				t.Fatalf("放行时 stderr 应打印实际连接地址 %q，实际：%q", gw.URL, errOut.String())
			}
		})
	}
}

// TestDestructiveAllowedOnExplicitConnection 显式 --url 时不受回退闸门影响（原行为不变）。
func TestDestructiveAllowedOnExplicitConnection(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newFallbackTestApp(t, "http://127.0.0.1:1") // 回退地址故意不可用
	if code := runCLI(app, "record", "clear-all", "-y", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("显式 --url 时退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
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

// TestGuardDoesNotApplyToReadOnlyCommands 只读命令在回退连接上照常执行（闸门只拦破坏性操作）。
func TestGuardDoesNotApplyToReadOnlyCommands(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newFallbackTestApp(t, gw.URL)
	if code := runCLI(app, "vendor", "list"); code != 0 {
		t.Fatalf("只读命令退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
}
