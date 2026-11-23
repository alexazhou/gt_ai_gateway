package cmd

import (
	"net/http"
	"strings"
	"testing"
)

// TestClientStatusAndLocal 覆盖两条读接口的路径与 query。
func TestClientStatusAndLocal(t *testing.T) {
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		clientConfigStatusPath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"available": true, "clients": []map[string]any{
				{"client": "claude-code", "installed": true, "configured": true},
			}})
		},
		clientConfigLocalPath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"gatewayUrl": mockURLFrom(r), "apiKey": "sk-x", "model": "m1"})
		},
	})
	app, out, errOut, _ := newTestApp(t)

	if code := runCLI(app, "--url", mock.URL, "--token", "t", "client", "status", "--json"); code != 0 {
		t.Fatalf("client status 退出码 = %d，stderr=%s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "claude-code") {
		t.Fatalf("status 输出缺少 clients 内容：%s", out.String())
	}
	if got := mock.rec.last().Path; got != clientConfigStatusPath {
		t.Fatalf("status 路径 = %q", got)
	}

	out.Reset()
	if code := runCLI(app, "--url", mock.URL, "--token", "t", "client", "local", "--client", "claude-code", "--json"); code != 0 {
		t.Fatalf("client local 退出码 = %d，stderr=%s", code, errOut.String())
	}
	if got := mock.rec.last().Path; got != clientConfigLocalPath+"?client=claude-code" {
		t.Fatalf("local 路径 = %q，期望 %q", got, clientConfigLocalPath+"?client=claude-code")
	}
}

// mockURLFrom 只是让 handler 有个稳定值可返回（不依赖真实 host）。
func mockURLFrom(r *http.Request) string { return "http://" + r.Host }

// TestClientLocalRejectsDocTypo 文档写的 claude_code 是笔误：必须报错并给出正确写法，不能静默兼容。
func TestClientLocalRejectsDocTypo(t *testing.T) {
	mock := newMockGateway(t, nil)
	app, _, errOut, _ := newTestApp(t)
	code := runCLI(app, "--url", mock.URL, "--token", "t", "client", "local", "--client", "claude_code")
	if code != 2 {
		t.Fatalf("退出码 = %d，期望 2（stderr=%s）", code, errOut.String())
	}
	if len(mock.rec.paths()) != 0 {
		t.Fatalf("参数错误不应发请求")
	}
	if !strings.Contains(errOut.String(), "claude-code") {
		t.Fatalf("错误提示应给出正确取值：%s", errOut.String())
	}
}

// TestClientCreateNormalizesBody 归一化：client 校验、backupId 转整数、connectionMode 校验。
func TestClientCreateNormalizesBody(t *testing.T) {
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		clientConfigCreatePath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"client": "claude-code", "backupCount": 0})
		},
	})
	app, _, errOut, _ := newTestApp(t)
	body := writeTempJSON(t, `{"client":"claude-code","connectionMode":"gateway","gatewayUrl":"http://127.0.0.1:8720","apiKey":"sk-1","model":"m1","backupId":"7"}`)
	if code := runCLI(app, "--url", mock.URL, "--token", "t", "client", "create", "--file", body); code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
	}
	got := string(mock.rec.last().Body)
	if !strings.Contains(got, `"backupId":7`) {
		t.Fatalf("backupId 未转成整数：%s", got)
	}
	if !strings.Contains(got, `"model":"m1"`) {
		t.Fatalf("model 丢失：%s", got)
	}
}

// TestClientCreateMissingFields 缺必填字段 ⇒ 退出码 2 且零请求。
func TestClientCreateMissingFields(t *testing.T) {
	mock := newMockGateway(t, nil)
	app, _, errOut, _ := newTestApp(t)
	body := writeTempJSON(t, `{"client":"codex","gatewayUrl":"http://x","apiKey":"sk-1"}`) // 缺 model
	code := runCLI(app, "--url", mock.URL, "--token", "t", "client", "create", "--file", body)
	if code != 2 {
		t.Fatalf("退出码 = %d，期望 2（stderr=%s）", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "model") {
		t.Fatalf("错误应指出缺 model：%s", errOut.String())
	}
	if len(mock.rec.paths()) != 0 {
		t.Fatalf("参数错误不应发请求")
	}
}

// TestClientBackupDeleteNeedsConfirmation 破坏性命令：无 -y ⇒ 2 且零请求；有 -y ⇒ 发请求。
func TestClientBackupDeleteNeedsConfirmation(t *testing.T) {
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		clientBackupDeletePath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"client": "claude-code"})
		},
	})
	body := writeTempJSON(t, `{"client":"claude-code","backupId":12}`)

	app, _, errOut, _ := newTestApp(t)
	if code := runCLI(app, "--url", mock.URL, "--token", "t", "client", "backup", "delete", "--file", body); code != 2 {
		t.Fatalf("无 -y 退出码 = %d，期望 2（stderr=%s）", code, errOut.String())
	}
	if len(mock.rec.paths()) != 0 {
		t.Fatalf("未确认时不应发请求")
	}

	if code := runCLI(app, "--url", mock.URL, "--token", "t", "-y", "client", "backup", "delete", "--file", body); code != 0 {
		t.Fatalf("带 -y 退出码 = %d，stderr=%s", code, errOut.String())
	}
	if got := mock.rec.last().Path; got != clientBackupDeletePath {
		t.Fatalf("路径 = %q", got)
	}
}

// TestClientApplyBlockedOnLocalDesktopProfile 本机桌面端 profile 下 apply 必须拒绝（-y 不够）。
func TestClientApplyBlockedOnLocalDesktopProfile(t *testing.T) {
	mock := newMockGateway(t, nil)
	// 造出「来自本机桌面端」的 profile（login --from-tauri），再跑破坏性命令
	app, _, errOut := newDesktopProfileApp(t, mock.URL, "")
	body := writeTempJSON(t, `{"client":"claude-code","backupId":1}`)
	code := runCLI(app, "-y", "client", "apply", "--file", body)
	if code != 2 {
		t.Fatalf("本机桌面端 profile 下 apply 退出码 = %d，期望 2（stderr=%s）", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "来自本机桌面端") {
		t.Fatalf("错误应说明连接来源：%s", errOut.String())
	}
	if len(mock.rec.paths()) != 0 {
		t.Fatalf("拒绝时不应发请求")
	}
}

// TestClientBackupAllRoutes 九条路由一条不落：其余五条只校验路径。
func TestClientBackupAllRoutes(t *testing.T) {
	cases := []struct {
		args []string
		path string
		body string
	}{
		{[]string{"client", "apply", "--file"}, clientConfigApplyPath, `{"client":"claude-code","backupId":1}`},
		{[]string{"client", "sync-from-local", "--file"}, clientSyncLocalPath, `{"client":"claude-code","backupId":1}`},
		{[]string{"client", "backup", "create", "--file"}, clientConfigBackupPath, `{"client":"claude-code","name":"n1"}`},
		{[]string{"client", "backup", "rename", "--file"}, clientBackupRenamePath, `{"client":"claude-code","backupId":1,"name":"n2"}`},
		{[]string{"client", "backup", "update", "--file"}, clientBackupUpdatePath, `{"client":"claude-code","backupId":1,"model":"m2"}`},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			mock := newMockGateway(t, map[string]http.HandlerFunc{
				tc.path: func(w http.ResponseWriter, r *http.Request) {
					writeJSON(w, 200, map[string]any{"ok": true})
				},
			})
			app, _, errOut, _ := newTestApp(t)
			body := writeTempJSON(t, tc.body)
			args := append([]string{"--url", mock.URL, "--token", "t", "-y"}, append(tc.args, body)...)
			if code := runCLI(app, args...); code != 0 {
				t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
			}
			if got := mock.rec.last().Path; got != tc.path {
				t.Fatalf("路径 = %q，期望 %q", got, tc.path)
			}
		})
	}
}
