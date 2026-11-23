package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
)

// recorder 记录 mock server 收到的请求，便于断言请求头与请求体。
type recorder struct {
	mu       sync.Mutex
	requests []recordedRequest
}

type recordedRequest struct {
	Method string
	Path   string
	Header http.Header
	Body   []byte
}

func (r *recorder) add(req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	body, _ := io.ReadAll(req.Body)
	// 记录完把 body 放回去：后面的 handler 还要按请求体做断言（否则它读到空 body）
	req.Body = io.NopCloser(bytes.NewReader(body))
	r.requests = append(r.requests, recordedRequest{
		Method: req.Method,
		Path:   req.URL.RequestURI(),
		Header: req.Header.Clone(),
		Body:   body,
	})
}

func (r *recorder) last() recordedRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.requests) == 0 {
		return recordedRequest{}
	}
	return r.requests[len(r.requests)-1]
}

func (r *recorder) paths() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.requests))
	for _, req := range r.requests {
		out = append(out, req.Path)
	}
	return out
}

// mockGateway 是一个最小的网关 mock：各路径返回固定 JSON，可注入状态码。
type mockGateway struct {
	*httptest.Server
	rec *recorder
}

func newMockGateway(t *testing.T, override map[string]http.HandlerFunc) *mockGateway {
	t.Helper()
	rec := &recorder{}
	handlers := map[string]http.HandlerFunc{
		"/status.json": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"status":    "ok",
				"mode":      "node",
				"user_type": "root",
				"user_id":   1,
				"user_name": "Root",
				"tenant": map[string]any{
					"id": 1, "main_id": 1, "multi_tenant_enabled": false,
				},
				"statistics": map[string]any{"users": 2, "vendors": 3, "models": 4, "records": 5},
				"system": map[string]any{
					"environment": "Node",
					"version":     "1.9.1-beta1",
					"apiAddress":  "http://127.0.0.1:8720",
					"uptime":      "1h",
				},
			})
		},
		"/update.json": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true, "has_update": false,
				"current_version": "1.9.1-beta1", "latest_version": "1.9.1-beta1",
			})
		},
		"/stats/dashboard.json": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"total_requests": 10, "success_count": 8, "failed_count": 2,
				"success_rate": 0.8, "active_users": 1, "active_models": 2, "today_requests": 3,
			})
		},
		"/stats/recent.json": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, []map[string]any{
				{"id": 7, "user_id": 1, "model_id": 2, "status": "success", "created_at": "2026-11-15 10:00:00"},
			})
		},
		"/config.json": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"site_name": "gateway", "theme": "light"})
		},
	}
	// override 覆盖同名默认 handler（ServeMux 对同一 pattern 重复注册会 panic）
	for path, handler := range override {
		handlers[path] = handler
	}
	mux := http.NewServeMux()
	for path, handler := range handlers {
		mux.HandleFunc(path, handler)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.add(r)
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return &mockGateway{Server: srv, rec: rec}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// newTestApp 构造注入了临时配置目录的 App。
func newTestApp(t *testing.T) (*App, *bytes.Buffer, *bytes.Buffer, string) {
	t.Helper()
	// 用 HOME 注入隔离真实家目录：DirFrom 只读家目录（`<home>/.gtgw`），
	// 注入 HOME 后整个用例与真实 `~/.gtgw` 完全无关（Windows 同时给 USERPROFILE）。
	dir := t.TempDir()
	env := map[string]string{
		"HOME":        dir,
		"USERPROFILE": dir,
	}
	var out, errOut bytes.Buffer
	app := NewApp(&out, &errOut, func(k string) string { return env[k] }, "1.9.1-beta1", "testsha")
	// 默认禁用 Tauri 回退：本机若装过桌面端，零配置会真实回退到 http://127.0.0.1:6722，
	// 那会让用例依赖开发机环境而不 hermetic。需要验证回退的用例显式注入 loader。
	app.SetTauriLoader(func() (*config.TauriConfig, error) { return nil, config.ErrTauriConfigNotFound })
	return app, &out, &errOut, dir
}

func runCLI(app *App, args ...string) int {
	return app.Execute(nil, args)
}

// readConfigFile 读取注入 home 下的 `~/.gtgw/config.json`。
func readConfigFile(t *testing.T, home string) config.File {
	t.Helper()
	f, err := config.LoadFrom(filepath.Join(home, ".gtgw"))
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	return *f
}

const testToken = "sk-abcdefghijkl"

func TestLoginSavesProfileAndMasksToken(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, dir := newTestApp(t)

	code := runCLI(app, "login", "--url", gw.URL, "--token", testToken)
	if code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	if strings.Contains(out.String(), testToken) {
		t.Fatalf("stdout 泄露完整 token：%s", out.String())
	}
	if !strings.Contains(out.String(), "sk-a****ijkl") {
		t.Fatalf("stdout 缺少脱敏 token：%s", out.String())
	}
	f := readConfigFile(t, dir)
	if f.ActiveProfile != "default" {
		t.Fatalf("active_profile = %q, 期望 default", f.ActiveProfile)
	}
	prof, ok := f.Profile("default")
	if !ok {
		t.Fatal("profile default 未保存")
	}
	if prof.BaseURL != gw.URL || prof.Token != testToken || prof.DefaultTenant != "1" {
		t.Fatalf("profile = %+v", prof)
	}
	if runtime.GOOS != "windows" {
		dirInfo, err := os.Stat(filepath.Join(dir, ".gtgw"))
		if err != nil {
			t.Fatalf("stat dir: %v", err)
		}
		if perm := dirInfo.Mode().Perm(); perm != 0o700 {
			t.Fatalf("配置目录权限 = %#o, 期望 0700", perm)
		}
		info, err := os.Stat(filepath.Join(dir, ".gtgw", "config.json"))
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("配置文件权限 = %#o, 期望 0600", perm)
		}
	}
}

func TestLoginFromTauri(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, dir := newTestApp(t)
	app.SetTauriLoader(func() (*config.TauriConfig, error) {
		return &config.TauriConfig{BaseURL: gw.URL, Token: testToken, Host: "127.0.0.1", Port: 6722, Path: "/tmp/tauri/config.json"}, nil
	})

	code := runCLI(app, "login", "--from-tauri")
	if code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	f := readConfigFile(t, dir)
	if f.ActiveProfile != "tauri" {
		t.Fatalf("active_profile = %q, 期望 tauri", f.ActiveProfile)
	}
	prof, ok := f.Profile("tauri")
	if !ok || prof.BaseURL != gw.URL || prof.Token != testToken {
		t.Fatalf("profile tauri = %+v", prof)
	}
	// 标记必须落盘：闸门靠它识别「本机桌面端」，不靠 profile 名字。
	if !prof.FromDesktop || prof.Origin() != config.ProfileOriginDesktop {
		t.Fatalf("profile tauri = %+v, 期望带 from_desktop 标记", prof)
	}
	if !strings.Contains(out.String(), config.ProfileOriginDesktop) {
		t.Fatalf("login --from-tauri 输出应标出来源：%s", out.String())
	}
	if strings.Contains(out.String(), testToken) {
		t.Fatalf("stdout 泄露完整 token：%s", out.String())
	}
}

func TestStatusJSONPurity(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, _ := newTestApp(t)
	if code := runCLI(app, "login", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("login 失败：%d %s", code, errOut.String())
	}
	out.Reset()
	errOut.Reset()

	code := runCLI(app, "status", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	if !json.Valid(out.Bytes()) {
		t.Fatalf("stdout 不是合法 JSON：%q", out.String())
	}
	var decoded map[string]any
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	system, _ := decoded["system"].(map[string]any)
	if system["version"] != "1.9.1-beta1" {
		t.Fatalf("system.version = %v", system["version"])
	}
	if errOut.Len() != 0 {
		t.Fatalf("--json 模式 stderr 应为空，实际：%q", errOut.String())
	}
	// 请求头必须带上 Bearer token
	if auth := gw.rec.last().Header.Get("Authorization"); auth != "Bearer "+testToken {
		t.Fatalf("Authorization = %q", auth)
	}
}

func TestStatusHumanOutputMasksToken(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, _ := newTestApp(t)
	if code := runCLI(app, "login", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("login: %d %s", code, errOut.String())
	}
	out.Reset()
	code := runCLI(app, "status")
	if code != 0 {
		t.Fatalf("退出码 = %d", code)
	}
	if strings.Contains(out.String(), testToken) {
		t.Fatalf("status 输出泄露完整 token：%s", out.String())
	}
	for _, want := range []string{"status", "ok", "1.9.1-beta1", "root"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("status 输出缺少 %q：%s", want, out.String())
		}
	}
}

// TestExitCodes 覆盖 0/1/2/3 四态（判据 §4）。
// 每个用例都用 mock server 造出对应的 HTTP 状态，断言退出码。
func TestExitCodes(t *testing.T) {
	cases := []struct {
		name   string
		status int
		args   []string
		expect int
	}{
		{name: "成功", status: 200, args: []string{"status"}, expect: 0},
		{name: "401 鉴权", status: 401, args: []string{"status"}, expect: 3},
		{name: "403 权限", status: 403, args: []string{"status"}, expect: 3},
		{name: "400 业务", status: 400, args: []string{"status"}, expect: 1},
		{name: "500 服务端", status: 500, args: []string{"status"}, expect: 1},
		{name: "参数错（未知 flag）", status: 200, args: []string{"status", "--no-such-flag"}, expect: 2},
		{name: "参数错（多余位置参数）", status: 200, args: []string{"status", "extra"}, expect: 2},
		{name: "参数错（config set 缺参数）", status: 200, args: []string{"config", "set"}, expect: 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gw := newMockGateway(t, map[string]http.HandlerFunc{
				"/status.json": func(w http.ResponseWriter, r *http.Request) {
					if c.status == http.StatusOK {
						writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "system": map[string]any{"version": "1.9.1-beta1"}})
						return
					}
					writeJSON(w, c.status, map[string]any{"error": http.StatusText(c.status)})
				},
			})
			app, _, errOut, _ := newTestApp(t)
			args := append([]string{}, c.args...)
			args = append(args, "--url", gw.URL, "--token", testToken)
			code := runCLI(app, args...)
			if code != c.expect {
				t.Fatalf("退出码 = %d, 期望 %d（stderr=%s）", code, c.expect, errOut.String())
			}
		})
	}
}

func TestErrorGoesToStderrInJSONMode(t *testing.T) {
	gw := newMockGateway(t, map[string]http.HandlerFunc{
		"/status.json": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 500, map[string]any{"error": "内部错误", "code": "internal_error"})
		},
	})
	app, out, errOut, _ := newTestApp(t)
	// 直接用 --url/--token 绕过 login，避免 login 阶段就失败
	code := runCLI(app, "status", "--json", "--url", gw.URL, "--token", testToken)
	if code != 1 {
		t.Fatalf("退出码 = %d, 期望 1", code)
	}
	if out.Len() != 0 {
		t.Fatalf("--json 且请求失败时 stdout 必须为空，实际：%q", out.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(errOut.Bytes(), &payload); err != nil {
		t.Fatalf("stderr 不是合法 JSON：%q", errOut.String())
	}
	if payload["status"].(float64) != 500 || payload["code"] != "internal_error" {
		t.Fatalf("stderr payload = %v", payload)
	}
}

func TestProfileListUseRemove(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, dir := newTestApp(t)
	if code := runCLI(app, "login", "--url", gw.URL, "--token", testToken, "--profile", "local"); code != 0 {
		t.Fatalf("login local: %d %s", code, errOut.String())
	}
	if code := runCLI(app, "login", "--url", gw.URL, "--token", "sk-zzzzzzzzzzzz", "--profile", "prod"); code != 0 {
		t.Fatalf("login prod: %d %s", code, errOut.String())
	}

	out.Reset()
	if code := runCLI(app, "profile", "list"); code != 0 {
		t.Fatalf("profile list: %d", code)
	}
	list := out.String()
	if strings.Contains(list, testToken) || strings.Contains(list, "sk-zzzzzzzzzzzz") {
		t.Fatalf("profile list 泄露完整 token：%s", list)
	}
	if !strings.Contains(list, "sk-a****ijkl") || !strings.Contains(list, "****") {
		t.Fatalf("profile list 缺少脱敏 token：%s", list)
	}

	out.Reset()
	if code := runCLI(app, "profile", "list", "--json"); code != 0 {
		t.Fatalf("profile list --json: %d", code)
	}
	if !json.Valid(out.Bytes()) {
		t.Fatalf("profile list --json 输出不是合法 JSON：%s", out.String())
	}
	if strings.Contains(out.String(), testToken) {
		t.Fatalf("profile list --json 泄露完整 token：%s", out.String())
	}

	out.Reset()
	if code := runCLI(app, "profile", "use", "local"); code != 0 {
		t.Fatalf("profile use: %d", code)
	}
	f := readConfigFile(t, dir)
	if f.ActiveProfile != "local" {
		t.Fatalf("active_profile = %q, 期望 local", f.ActiveProfile)
	}

	// 未传 --yes 且 stdin 非 TTY：必须拦截（退出码 2）
	if code := runCLI(app, "profile", "remove", "prod"); code != 2 {
		t.Fatalf("profile remove 未确认时退出码 = %d, 期望 2", code)
	}
	if code := runCLI(app, "profile", "remove", "prod", "--yes"); code != 0 {
		t.Fatalf("profile remove --yes: %d", code)
	}
	f = readConfigFile(t, dir)
	if _, ok := f.Profile("prod"); ok {
		t.Fatal("prod 应已删除")
	}
}

func TestLogoutClearsToken(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, dir := newTestApp(t)
	if code := runCLI(app, "login", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("login: %d %s", code, errOut.String())
	}
	out.Reset()
	if code := runCLI(app, "logout"); code != 0 {
		t.Fatalf("logout: %d", code)
	}
	f := readConfigFile(t, dir)
	prof, ok := f.Profile(f.ActiveProfile)
	if !ok {
		t.Fatal("profile 不应被删除")
	}
	if prof.Token != "" {
		t.Fatalf("token = %q, 期望已清空", prof.Token)
	}
	if prof.BaseURL != gw.URL {
		t.Fatalf("base_url = %q, 期望保留", prof.BaseURL)
	}
}

func TestConfigGetAndSet(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, _ := newTestApp(t)

	out.Reset()
	if code := runCLI(app, "config", "get", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("config get: %d %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "site_name") || !strings.Contains(out.String(), "gateway") {
		t.Fatalf("config get 输出 = %s", out.String())
	}

	out.Reset()
	if code := runCLI(app, "config", "get", "--json", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("config get --json: %d", code)
	}
	if !json.Valid(out.Bytes()) {
		t.Fatalf("config get --json 输出不是合法 JSON：%s", out.String())
	}

	if code := runCLI(app, "config", "set", "--key", "theme=dark", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("config set --key: %d", code)
	}
	last := gw.rec.last()
	if last.Method != http.MethodPut || last.Path != "/config.json" {
		t.Fatalf("请求 = %s %s, 期望 PUT /config.json", last.Method, last.Path)
	}
	var body map[string]any
	if err := json.Unmarshal(last.Body, &body); err != nil {
		t.Fatalf("请求体不是合法 JSON：%v", err)
	}
	if body["theme"] != "dark" {
		t.Fatalf("请求体 = %v, 期望包含 theme=dark", body)
	}

	// --file 与 --key 互斥
	if code := runCLI(app, "config", "set", "--key", "a=b", "--file", "x.json", "--url", gw.URL, "--token", testToken); code != 2 {
		t.Fatalf("--file 与 --key 同时给出的退出码 = %d, 期望 2", code)
	}
}

func TestConfigSetFromFile(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, _, errOut, _ := newTestApp(t)
	path := filepath.Join(t.TempDir(), "cfg.json")
	if err := os.WriteFile(path, []byte(`{"site_name":"from-file"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if code := runCLI(app, "config", "set", "--file", path, "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("config set --file: %d %s", code, errOut.String())
	}
	var body map[string]any
	if err := json.Unmarshal(gw.rec.last().Body, &body); err != nil {
		t.Fatalf("请求体：%v", err)
	}
	if body["site_name"] != "from-file" {
		t.Fatalf("请求体 = %v", body)
	}
}

func TestDashboard(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, _ := newTestApp(t)
	if code := runCLI(app, "dashboard", "--json", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("dashboard --json: %d %s", code, errOut.String())
	}
	var payload struct {
		Dashboard map[string]any   `json:"dashboard"`
		Recent    []map[string]any `json:"recent"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatalf("dashboard --json 输出不是合法 JSON：%v", err)
	}
	if payload.Dashboard["total_requests"].(float64) != 10 {
		t.Fatalf("dashboard.total_requests = %v", payload.Dashboard["total_requests"])
	}
	if len(payload.Recent) != 1 || payload.Recent[0]["status"] != "success" {
		t.Fatalf("recent = %v", payload.Recent)
	}
	// 两个接口都要被请求到（验证并发聚合）
	paths := strings.Join(gw.rec.paths(), ",")
	if !strings.Contains(paths, "/stats/dashboard.json") || !strings.Contains(paths, "/stats/recent.json") {
		t.Fatalf("请求路径 = %s", paths)
	}
}

func TestUpdateCheck(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, out, errOut, _ := newTestApp(t)
	if code := runCLI(app, "update", "check", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("update check: %d %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "1.9.1-beta1") {
		t.Fatalf("update check 输出 = %s", out.String())
	}
	if code := runCLI(app, "update", "check", "--force", "--json", "--url", gw.URL, "--token", testToken); code != 0 {
		t.Fatalf("update check --force --json: %d", code)
	}
	if got := gw.rec.last().Path; got != "/update.json?force=1" {
		t.Fatalf("请求路径 = %q, 期望带 force=1", got)
	}
}

func TestNoCredentialsIsUsageError(t *testing.T) {
	app, _, _, _ := newTestApp(t)
	code := runCLI(app, "status")
	if code != 2 {
		t.Fatalf("无任何配置时退出码 = %d, 期望 2", code)
	}
}

func TestVersionFlag(t *testing.T) {
	app, out, _, _ := newTestApp(t)
	if code := runCLI(app, "--version"); code != 0 {
		t.Fatalf("--version 退出码 = %d", code)
	}
	if !strings.Contains(out.String(), "1.9.1-beta1") {
		t.Fatalf("--version 输出 = %q", out.String())
	}
}

func TestTenantHeaderFromFlag(t *testing.T) {
	gw := newMockGateway(t, nil)
	app, _, errOut, _ := newTestApp(t)
	if code := runCLI(app, "status", "--url", gw.URL, "--token", testToken, "--tenant", "tenant-b"); code != 0 {
		t.Fatalf("status: %d %s", code, errOut.String())
	}
	if got := gw.rec.last().Header.Get("X-Tenant-ID"); got != "tenant-b" {
		t.Fatalf("X-Tenant-ID = %q, 期望 tenant-b", got)
	}
}

// TestUnknownErrorShapeSurfacesRawBody 验证未知错误形态（如反代 502 HTML）不吞原始 body：
// 人类模式把截断后的原文打到 stderr；--json 模式把状态码与 body 放进结构化 JSON（仍走 stderr），stdout 保持干净。
func TestUnknownErrorShapeSurfacesRawBody(t *testing.T) {
	gw := newMockGateway(t, map[string]http.HandlerFunc{
		"/status.json": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte("<html><body>502 Bad Gateway (nginx)</body></html>"))
		},
	})

	t.Run("人类模式", func(t *testing.T) {
		app, out, errOut, _ := newTestApp(t)
		code := runCLI(app, "status", "--url", gw.URL, "--token", testToken)
		if code != 1 {
			t.Fatalf("退出码 = %d, 期望 1", code)
		}
		if out.Len() != 0 {
			t.Fatalf("失败时 stdout 应为空：%q", out.String())
		}
		if !strings.Contains(errOut.String(), "原始响应体") || !strings.Contains(errOut.String(), "502 Bad Gateway") {
			t.Fatalf("stderr 未暴露原始 body：%q", errOut.String())
		}
	})

	t.Run("--json 模式", func(t *testing.T) {
		app, out, errOut, _ := newTestApp(t)
		code := runCLI(app, "status", "--json", "--url", gw.URL, "--token", testToken)
		if code != 1 {
			t.Fatalf("退出码 = %d, 期望 1", code)
		}
		if out.Len() != 0 {
			t.Fatalf("--json 失败时 stdout 必须为空：%q", out.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(errOut.Bytes(), &payload); err != nil {
			t.Fatalf("stderr 不是合法 JSON：%q", errOut.String())
		}
		if payload["status"].(float64) != http.StatusBadGateway {
			t.Fatalf("status = %v, 期望 502", payload["status"])
		}
		body, _ := payload["body"].(string)
		if !strings.Contains(body, "502 Bad Gateway") {
			t.Fatalf("body 字段未包含原始响应：%v", payload)
		}
	})
}
