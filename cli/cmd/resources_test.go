package cmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
)

// 本文件覆盖 P2 的资源域命令（vendor / vendor model / model / user / balance /
// tenant / rule / record）。核心判据有两条：
//
//  1. 每个命令都真实发一次 HTTP 往返，且「方法 + 路径」必须命中 src/routes.ts
//     里真实存在的路由（mock 侧对未登记路径一律 404 并记入 unmatched）；
//  2. 危险操作在非 TTY 且未传 --yes 时退出码 2，且**一个请求都不发**。

// stubRoute 是 mock 网关的一条路由：pattern 里以 ":" 开头的段是通配。
type stubRoute struct {
	method  string
	pattern string
	handler http.HandlerFunc
}

// resourceGateway 是带路由表匹配的 mock 网关：未登记路径返回 404 并记录，
// 便于断言「CLI 没打到 routes.ts 里不存在的路径」。
type resourceGateway struct {
	*httptest.Server
	rec *recorder

	mu        sync.Mutex
	unmatched []string
}

func (g *resourceGateway) takeUnmatched() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := append([]string{}, g.unmatched...)
	g.unmatched = nil
	return out
}

// matchRoutePattern 判断具体路径是否匹配含 ":" 占位段的模式。
func matchRoutePattern(pattern, path string) bool {
	patternParts := strings.Split(pattern, "/")
	pathParts := strings.Split(path, "/")
	if len(patternParts) != len(pathParts) {
		return false
	}
	for i, p := range patternParts {
		if strings.HasPrefix(p, ":") {
			if pathParts[i] == "" {
				return false
			}
			continue
		}
		if p != pathParts[i] {
			return false
		}
	}
	return true
}

func newResourceGateway(t *testing.T, overrides []stubRoute) *resourceGateway {
	t.Helper()
	rec := &recorder{}
	// overrides 排在前面：同名同方法时用例自己的 stub 优先。
	routes := append(append([]stubRoute{}, overrides...), defaultP2Routes()...)

	g := &resourceGateway{rec: rec}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, rt := range routes {
			if rt.method != r.Method || !matchRoutePattern(rt.pattern, r.URL.Path) {
				continue
			}
			rt.handler(w, r)
			return
		}
		g.mu.Lock()
		g.unmatched = append(g.unmatched, r.Method+" "+r.URL.RequestURI())
		g.mu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error": "mock: 该路径未在 src/routes.ts 登记",
			"path":  r.URL.Path,
		})
	})
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.add(r)
		inner.ServeHTTP(w, r)
	}))
	t.Cleanup(g.Close)
	return g
}

func jsonStub(method, pattern string, body any) stubRoute {
	return stubRoute{method: method, pattern: pattern, handler: func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, body)
	}}
}

func p2ListBody() map[string]any {
	return map[string]any{
		"list": []map[string]any{
			{"id": 12, "name": "acme", "type": "openai", "url": "http://up", "model_id": "gpt-4o", "vendor_id": 12},
		},
		"total": 1,
	}
}

// defaultP2Routes 覆盖全部 P2 命令会打到的路径，返回结构与后端一致的最小响应。
func defaultP2Routes() []stubRoute {
	return []stubRoute{
		jsonStub(http.MethodGet, "/vendor/preset-urls.json", map[string]any{"openai": "https://api.openai.com/v1"}),
		jsonStub(http.MethodGet, "/vendor/list.json", p2ListBody()),
		jsonStub(http.MethodPost, "/vendor/create.json", map[string]any{"id": 99, "name": "acme"}),
		jsonStub(http.MethodGet, "/vendor/:id", map[string]any{"id": 12, "name": "acme", "type": "openai"}),
		jsonStub(http.MethodPut, "/vendor/:id", map[string]any{"id": 12, "name": "acme2"}),
		jsonStub(http.MethodDelete, "/vendor/:id", map[string]any{"success": true}),
		jsonStub(http.MethodPost, "/vendor/:id/test.json", map[string]any{"success": true, "latency_ms": 12}),
		jsonStub(http.MethodGet, "/vendor/:id/model/list.json", p2ListBody()),
		jsonStub(http.MethodGet, "/vendor/:id/model/fetch.json", map[string]any{
			"models": []map[string]any{{"id": "gpt-4o", "owned_by": "openai"}},
		}),
		jsonStub(http.MethodPost, "/vendor/:id/model/sync.json", p2ListBody()),
		jsonStub(http.MethodPost, "/vendor/:id/model/add.json", map[string]any{"id": 34, "model_id": "gpt-4o"}),
		jsonStub(http.MethodPut, "/vendor/:id/model/:modelId", map[string]any{"id": 34, "allowed_formats": []string{"openai"}}),
		jsonStub(http.MethodDelete, "/vendor/:id/model/:modelId", map[string]any{"success": true}),
		jsonStub(http.MethodGet, "/model/list.json", p2ListBody()),
		// 模型对象必须带 routing_mode / routing_config：用于验证 update 的读改写不会把路由配置清空。
		jsonStub(http.MethodGet, "/model/:id", map[string]any{
			"id": 12, "name": "gpt-4o", "routing_mode": "round_robin",
			"routing_config": map[string]any{"strategy": "weighted"}, "enabled": true,
		}),
		jsonStub(http.MethodPost, "/model/create.json", map[string]any{"id": 77, "name": "m1"}),
		jsonStub(http.MethodPut, "/model/:id", map[string]any{
			"id": 12, "name": "gpt-4o-mini", "routing_mode": "round_robin",
			"routing_config": map[string]any{"strategy": "weighted"},
		}),
		jsonStub(http.MethodDelete, "/model/:id", map[string]any{"success": true}),
		jsonStub(http.MethodPost, "/model/route-test.json", map[string]any{"success": true, "model": "gpt-4o"}),
		jsonStub(http.MethodGet, "/user/list.json", p2ListBody()),
		jsonStub(http.MethodGet, "/user/:id", map[string]any{"id": 12, "name": "alice", "type": "normal"}),
		jsonStub(http.MethodPost, "/user/create.json", map[string]any{"id": 13, "name": "alice"}),
		jsonStub(http.MethodPut, "/user/:id", map[string]any{"id": 12, "status": "disabled"}),
		jsonStub(http.MethodPost, "/user/:id/balance/adjust.json", map[string]any{"success": true, "balance": 10.5}),
		// 余额流水列表后端返回的是**裸数组**（不是 {list,total}），专门覆盖这条分支。
		jsonStub(http.MethodGet, "/balance/recharge/list.json", []map[string]any{
			{"id": 3, "user_id": 12, "amount": 10.5, "type": "recharge"},
		}),
		jsonStub(http.MethodGet, "/balance/recharge/:id", map[string]any{"id": 3, "user_id": 12, "amount": 10.5}),
		jsonStub(http.MethodGet, "/tenant.json", p2ListBody()),
		jsonStub(http.MethodPost, "/tenant.json", map[string]any{"id": 3, "name": "t1"}),
		jsonStub(http.MethodGet, "/tenant/:id", map[string]any{"id": 3, "name": "t1"}),
		jsonStub(http.MethodPut, "/tenant/:id", map[string]any{"id": 3, "name": "t1", "description": "d"}),
		jsonStub(http.MethodDelete, "/tenant/:id", map[string]any{"success": true}),
		jsonStub(http.MethodGet, "/rule/list.json", p2ListBody()),
		jsonStub(http.MethodGet, "/rule/:id", map[string]any{"id": 5, "name": "r1"}),
		jsonStub(http.MethodPost, "/rule/create.json", map[string]any{"id": 6, "name": "r1"}),
		jsonStub(http.MethodPut, "/rule/:id", map[string]any{"id": 5, "name": "r2"}),
		jsonStub(http.MethodDelete, "/rule/:id", map[string]any{"success": true}),
		jsonStub(http.MethodGet, "/record/list.json", map[string]any{
			"list":  []map[string]any{{"id": 7, "status": "success", "model": "gpt-4o", "created_at": "2026-11-15 10:00:00"}},
			"total": 42,
		}),
		jsonStub(http.MethodGet, "/record/:id", map[string]any{"id": 7, "status": "success"}),
		jsonStub(http.MethodGet, "/record/:id/activity.json", map[string]any{
			"record_id": 7,
			"activities": []map[string]any{
				{"stage": "routing", "level": "info", "message": "选中供应商 acme", "ts": 1763200000000},
				{"stage": "result", "level": "info", "message": "响应已写入记录", "ts": 1763200000900},
			},
		}),
		jsonStub(http.MethodDelete, "/record/:id", map[string]any{"success": true}),
		jsonStub(http.MethodPost, "/record/recover-orphans.json", map[string]any{"success": true, "recovered": 3}),
		jsonStub(http.MethodDelete, "/record/clear-payload", map[string]any{"success": true}),
		jsonStub(http.MethodDelete, "/record/clear-all", map[string]any{"success": true}),
	}
}

// newEnvTestApp 构造用环境变量指定网关地址与 Token 的 App。
//
// 这里刻意不用 --url / --token 全局 Flag：`gtgw user create|update` 自带同名 --token 局
// 部 Flag（语义是「用户 Token」），会遮蔽全局 --token。走环境变量可同时覆盖该场景，
// 也顺便验证「env 层」在配置解析里的生效。
func newEnvTestApp(t *testing.T, baseURL, token string) (*App, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	home := t.TempDir()
	env := map[string]string{
		"HOME":          home,
		"USERPROFILE":   home,
		config.EnvURL:   baseURL,
		config.EnvToken: token,
	}
	var out, errOut bytes.Buffer
	app := NewApp(&out, &errOut, func(k string) string { return env[k] }, "1.9.1-beta1", "testsha")
	app.SetTauriLoader(func() (*config.TauriConfig, error) { return nil, config.ErrTauriConfigNotFound })
	return app, &out, &errOut
}

// 需要 --file 的用例在参数表里写占位符，执行前替换成真实临时文件路径，
// 这样用例表本身保持可读（不出现 t.TempDir 之类的运行期路径）。
const (
	fileVendorUpdate = "<TMPFILE:vendor-update>"
	fileModelCreate  = "<TMPFILE:model-create>"
)

func resolveFilePlaceholders(t *testing.T, args []string) []string {
	t.Helper()
	contents := map[string]string{
		fileVendorUpdate: `{"name":"acme-updated"}`,
		fileModelCreate:  `{"name":"m1","routing_mode":"round_robin","routing_config":{"strategy":"weighted"}}`,
	}
	out := append([]string{}, args...)
	for i, arg := range out {
		content, ok := contents[arg]
		if !ok {
			continue
		}
		out[i] = writeTempJSON(t, content)
	}
	return out
}

// writeTempJSON 把内容写到临时文件，返回路径。
func writeTempJSON(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "body.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write temp json: %v", err)
	}
	return path
}

// writeTempStdin 把内容写到临时文件并设为 App 的 stdin（非 TTY）。
func writeTempStdin(t *testing.T, app *App, content string) {
	t.Helper()
	path := writeTempJSON(t, content)
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open stdin: %v", err)
	}
	t.Cleanup(func() { _ = f.Close() })
	app.SetStdin(f)
}

// assertLastRequest 断言最后一次请求的方法、路径与 query。
func assertLastRequest(t *testing.T, gw *resourceGateway, wantMethod, wantPath string, wantQuery map[string]string) {
	t.Helper()
	if len(gw.rec.paths()) == 0 {
		t.Fatalf("没有任何请求发出")
	}
	last := gw.rec.last()
	parsed, err := url.Parse(last.Path)
	if err != nil {
		t.Fatalf("解析 RequestURI %q: %v", last.Path, err)
	}
	if last.Method != wantMethod {
		t.Fatalf("方法 = %s, 期望 %s（RequestURI=%s）", last.Method, wantMethod, last.Path)
	}
	if parsed.Path != wantPath {
		t.Fatalf("路径 = %s, 期望 %s", parsed.Path, wantPath)
	}
	got := parsed.Query()
	if len(got) != len(wantQuery) {
		t.Fatalf("query = %v, 期望 %v", got, wantQuery)
	}
	for k, v := range wantQuery {
		if got.Get(k) != v {
			t.Fatalf("query[%s] = %q, 期望 %q（完整 query=%v）", k, got.Get(k), v, got)
		}
	}
}

// decodeLastBody 把最后一次请求体解成 map。
func decodeLastBody(t *testing.T, gw *resourceGateway) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(gw.rec.last().Body, &body); err != nil {
		t.Fatalf("请求体不是合法 JSON：%v（body=%s）", err, gw.rec.last().Body)
	}
	return body
}

// TestP2CommandRoutes 是覆盖表：每个 P2 命令真发一次请求，断言「方法 + 路径 + query」。
func TestP2CommandRoutes(t *testing.T) {
	cases := []struct {
		name      string
		args      []string
		method    string
		path      string
		query     map[string]string
		checkBody func(t *testing.T, body map[string]any)
	}{
		// ---- vendor ----
		{name: "vendor presets", args: []string{"vendor", "presets"}, method: http.MethodGet, path: "/vendor/preset-urls.json"},
		{
			name:   "vendor list 带筛选与分页",
			args:   []string{"vendor", "list", "--type", "openai", "--keyword", "ac me", "--page", "2", "--limit", "50"},
			method: http.MethodGet, path: "/vendor/list.json",
			query: map[string]string{"type": "openai", "keyword": "ac me", "page": "2", "limit": "50"},
		},
		{name: "vendor get", args: []string{"vendor", "get", "12"}, method: http.MethodGet, path: "/vendor/12"},
		{
			name:   "vendor create --key",
			args:   []string{"vendor", "create", "--key", "name=acme", "--key", "type=openai"},
			method: http.MethodPost, path: "/vendor/create.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["name"] != "acme" || body["type"] != "openai" {
					t.Fatalf("vendor create body = %v", body)
				}
			},
		},
		{
			name:   "vendor update --file",
			args:   []string{"vendor", "update", "12", "--file", fileVendorUpdate},
			method: http.MethodPut, path: "/vendor/12",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["name"] != "acme-updated" {
					t.Fatalf("vendor update body = %v", body)
				}
			},
		},
		{name: "vendor delete -y", args: []string{"vendor", "delete", "12", "-y"}, method: http.MethodDelete, path: "/vendor/12"},
		{
			name:   "vendor test 只发后端认识的字段",
			args:   []string{"vendor", "test", "12", "--format", "openai", "--model", "gpt-4o", "--auto-convert"},
			method: http.MethodPost, path: "/vendor/12/test.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["format"] != "openai" || body["model"] != "gpt-4o" || body["auto_convert"] != true {
					t.Fatalf("vendor test body = %v", body)
				}
				if _, ok := body["content_mode"]; ok {
					t.Fatalf("vendor test 不应发送 content_mode（后端无此字段）：%v", body)
				}
			},
		},
		// ---- vendor model ----
		{name: "vendor model list", args: []string{"vendor", "model", "list", "12"}, method: http.MethodGet, path: "/vendor/12/model/list.json"},
		{name: "vendor model fetch", args: []string{"vendor", "model", "fetch", "12"}, method: http.MethodGet, path: "/vendor/12/model/fetch.json"},
		{
			name:   "vendor model sync --model-ids",
			args:   []string{"vendor", "model", "sync", "12", "--model-ids", "gpt-4o,gpt-4o-mini"},
			method: http.MethodPost, path: "/vendor/12/model/sync.json",
			checkBody: func(t *testing.T, body map[string]any) {
				ids, ok := body["model_ids"].([]any)
				if !ok || len(ids) != 2 || ids[0] != "gpt-4o" || ids[1] != "gpt-4o-mini" {
					t.Fatalf("sync body = %v", body)
				}
			},
		},
		{
			name:   "vendor model add --model-id",
			args:   []string{"vendor", "model", "add", "12", "--model-id", "gpt-4o"},
			method: http.MethodPost, path: "/vendor/12/model/add.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if len(body) != 1 || body["model_id"] != "gpt-4o" {
					t.Fatalf("add body = %v（后端只接受 model_id）", body)
				}
			},
		},
		{
			name:   "vendor model update --allowed-formats",
			args:   []string{"vendor", "model", "update", "12", "34", "--allowed-formats", "openai, anthropic"},
			method: http.MethodPut, path: "/vendor/12/model/34",
			checkBody: func(t *testing.T, body map[string]any) {
				formats, ok := body["allowed_formats"].([]any)
				if !ok || len(formats) != 2 || formats[0] != "openai" || formats[1] != "anthropic" {
					t.Fatalf("vendor model update body = %v", body)
				}
			},
		},
		{name: "vendor model delete -y", args: []string{"vendor", "model", "delete", "12", "34", "-y"}, method: http.MethodDelete, path: "/vendor/12/model/34"},
		// ---- model ----
		{
			name:   "model list 带筛选",
			args:   []string{"model", "list", "--vendor-id", "12", "--keyword", "gpt"},
			method: http.MethodGet, path: "/model/list.json",
			query: map[string]string{"vendor_id": "12", "keyword": "gpt"},
		},
		{name: "model get", args: []string{"model", "get", "12"}, method: http.MethodGet, path: "/model/12"},
		{
			name:   "model create 带路由字段",
			args:   []string{"model", "create", "--file", fileModelCreate},
			method: http.MethodPost, path: "/model/create.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["routing_mode"] == nil || body["routing_config"] == nil {
					t.Fatalf("model create body 缺路由字段：%v", body)
				}
			},
		},
		{
			name:   "model update 读改写保留路由配置",
			args:   []string{"model", "update", "12", "--key", "name=gpt-4o-mini"},
			method: http.MethodPut, path: "/model/12",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["name"] != "gpt-4o-mini" {
					t.Fatalf("model update 未带上补丁字段：%v", body)
				}
				if body["routing_mode"] != "round_robin" || body["routing_config"] == nil {
					t.Fatalf("model update 丢了 GET 回来的路由字段：%v", body)
				}
			},
		},
		{name: "model delete -y", args: []string{"model", "delete", "12", "-y"}, method: http.MethodDelete, path: "/model/12"},
		{
			name:   "model route-test",
			args:   []string{"model", "route-test", "--model", "gpt-4o", "--format", "anthropic"},
			method: http.MethodPost, path: "/model/route-test.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["model"] != "gpt-4o" || body["format"] != "anthropic" {
					t.Fatalf("route-test body = %v", body)
				}
			},
		},
		// ---- user / balance ----
		{
			name:   "user list 带筛选",
			args:   []string{"user", "list", "--type", "admin", "--keyword", "ali"},
			method: http.MethodGet, path: "/user/list.json",
			query: map[string]string{"type": "admin", "keyword": "ali"},
		},
		{name: "user get", args: []string{"user", "get", "12"}, method: http.MethodGet, path: "/user/12"},
		{
			name:   "user create 快捷 flag",
			args:   []string{"user", "create", "--name", "alice", "--type", "normal"},
			method: http.MethodPost, path: "/user/create.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["name"] != "alice" || body["type"] != "normal" {
					t.Fatalf("user create body = %v", body)
				}
				if _, ok := body["token"]; ok {
					t.Fatalf("未传 --token 时不应发送 token（由服务端生成）：%v", body)
				}
			},
		},
		{
			name:   "user update 只发改动字段",
			args:   []string{"user", "update", "12", "--status", "disabled"},
			method: http.MethodPut, path: "/user/12",
			checkBody: func(t *testing.T, body map[string]any) {
				if len(body) != 1 || body["status"] != "disabled" {
					t.Fatalf("user update body = %v（后端只更新出现的字段）", body)
				}
			},
		},
		{
			name:   "user recharge",
			args:   []string{"user", "recharge", "12", "--amount", "10.5", "--remark", "top up"},
			method: http.MethodPost, path: "/user/12/balance/adjust.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["amount"] != 10.5 || body["type"] != "recharge" || body["remark"] != "top up" {
					t.Fatalf("recharge body = %v", body)
				}
			},
		},
		{
			name:   "balance list",
			args:   []string{"balance", "list", "--user-id", "12", "--type", "recharge"},
			method: http.MethodGet, path: "/balance/recharge/list.json",
			query: map[string]string{"user_id": "12", "type": "recharge"},
		},
		{name: "balance get", args: []string{"balance", "get", "3"}, method: http.MethodGet, path: "/balance/recharge/3"},
		// ---- tenant / rule ----
		{name: "tenant list", args: []string{"tenant", "list"}, method: http.MethodGet, path: "/tenant.json"},
		{
			name:   "tenant create",
			args:   []string{"tenant", "create", "--name", "t1"},
			method: http.MethodPost, path: "/tenant.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if len(body) != 1 || body["name"] != "t1" {
					t.Fatalf("tenant create body = %v", body)
				}
			},
		},
		{name: "tenant get", args: []string{"tenant", "get", "3"}, method: http.MethodGet, path: "/tenant/3"},
		{
			name:   "tenant update",
			args:   []string{"tenant", "update", "3", "--description", "d"},
			method: http.MethodPut, path: "/tenant/3",
			checkBody: func(t *testing.T, body map[string]any) {
				if len(body) != 1 || body["description"] != "d" {
					t.Fatalf("tenant update body = %v（部分更新）", body)
				}
			},
		},
		{name: "tenant delete -y", args: []string{"tenant", "delete", "3", "-y"}, method: http.MethodDelete, path: "/tenant/3"},
		{name: "rule list", args: []string{"rule", "list"}, method: http.MethodGet, path: "/rule/list.json"},
		{name: "rule get", args: []string{"rule", "get", "5"}, method: http.MethodGet, path: "/rule/5"},
		{
			name:   "rule create",
			args:   []string{"rule", "create", "--key", "name=r1"},
			method: http.MethodPost, path: "/rule/create.json",
			checkBody: func(t *testing.T, body map[string]any) {
				if body["name"] != "r1" {
					t.Fatalf("rule create body = %v", body)
				}
			},
		},
		{
			name:   "rule update",
			args:   []string{"rule", "update", "5", "--key", "name=r2"},
			method: http.MethodPut, path: "/rule/5",
		},
		{name: "rule delete -y", args: []string{"rule", "delete", "5", "-y"}, method: http.MethodDelete, path: "/rule/5"},
		// ---- record ----
		{
			name: "record list 真实参数名透传",
			args: []string{"record", "list", "--user-ids", "1,2", "--model-ids", "3",
				"--status", "success", "--start-time", "2026-11-01 00:00:00", "--end-time", "2026-11-02 00:00:00",
				"--page", "2", "--limit", "20"},
			method: http.MethodGet, path: "/record/list.json",
			query: map[string]string{
				"user_ids": "1,2", "model_ids": "3", "status": "success",
				"start_time": "2026-11-01 00:00:00", "end_time": "2026-11-02 00:00:00",
				"page": "2", "limit": "20",
			},
		},
		{name: "record get", args: []string{"record", "get", "7"}, method: http.MethodGet, path: "/record/7"},
		{name: "record activity", args: []string{"record", "activity", "7"}, method: http.MethodGet, path: "/record/7/activity.json"},
		{name: "record delete -y", args: []string{"record", "delete", "7", "-y"}, method: http.MethodDelete, path: "/record/7"},
		// recover-orphans 会写库，按 #258 安全要求纳入破坏性命令（需要 -y 且受回退闸门约束）
		{name: "record recover-orphans -y", args: []string{"record", "recover-orphans", "-y"}, method: http.MethodPost, path: "/record/recover-orphans.json"},
		{name: "record clear-payload -y", args: []string{"record", "clear-payload", "-y"}, method: http.MethodDelete, path: "/record/clear-payload"},
		{name: "record clear-all -y", args: []string{"record", "clear-all", "-y"}, method: http.MethodDelete, path: "/record/clear-all"},
	}

	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			args := resolveFilePlaceholders(t, c.args)
			gw := newResourceGateway(t, nil)
			app, _, errOut := newEnvTestApp(t, gw.URL, testToken)

			if code := runCLI(app, args...); code != 0 {
				t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
			}
			assertLastRequest(t, gw, c.method, c.path, c.query)
			if c.checkBody != nil {
				c.checkBody(t, decodeLastBody(t, gw))
			}
			if unmatched := gw.takeUnmatched(); len(unmatched) > 0 {
				t.Fatalf("发出了 routes.ts 里不存在的路由：%v", unmatched)
			}
		})
	}
}

// TestP2DestructiveNeedsConfirm 覆盖「危险操作未 -y 且非 TTY ⇒ 退出码 2 且请求未发出」。
// 这是 P2 的硬判据之一：确认发生在发请求之前。
func TestP2DestructiveNeedsConfirm(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{name: "vendor delete", args: []string{"vendor", "delete", "12"}},
		{name: "vendor model delete", args: []string{"vendor", "model", "delete", "12", "34"}},
		{name: "model delete", args: []string{"model", "delete", "12"}},
		{name: "tenant delete", args: []string{"tenant", "delete", "3"}},
		{name: "rule delete", args: []string{"rule", "delete", "5"}},
		{name: "record delete", args: []string{"record", "delete", "7"}},
		{name: "record clear-payload", args: []string{"record", "clear-payload"}},
		{name: "record clear-all", args: []string{"record", "clear-all"}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			gw := newResourceGateway(t, nil)
			app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
			// stdin 用普通文件（非 TTY），且内容故意写成 "y"：非 TTY 不允许把输入当确认。
			writeTempStdin(t, app, "y\n")
			args := append([]string{}, c.args...)
			if code := runCLI(app, args...); code != 2 {
				t.Fatalf("退出码 = %d, 期望 2（stderr=%s）", code, errOut.String())
			}
			if paths := gw.rec.paths(); len(paths) != 0 {
				t.Fatalf("确认失败却发出了请求：%v", paths)
			}
			if !strings.Contains(errOut.String(), "--yes") {
				t.Fatalf("错误提示应指出加 --yes，实际：%q", errOut.String())
			}
		})
	}
}

// TestP2BodyFromStdin 覆盖 --file - 从 stdin 读请求体。
func TestP2BodyFromStdin(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	writeTempStdin(t, app, `{"name":"from-stdin","type":"openai"}`)
	if code := runCLI(app, "vendor", "create", "--file", "-"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	body := decodeLastBody(t, gw)
	if body["name"] != "from-stdin" {
		t.Fatalf("stdin 请求体未透传：%v", body)
	}
}

// TestP2BadInputSendsNoRequest 覆盖参数/请求体错误时一个请求都不发（失败早于网络）。
func TestP2BadInputSendsNoRequest(t *testing.T) {
	badJSON := writeTempJSON(t, `{"name": `)
	cases := []struct {
		name string
		args []string
		want int
	}{
		{name: "create 缺请求体", args: []string{"vendor", "create"}, want: 2},
		{name: "非法 JSON 文件", args: []string{"vendor", "create", "--file", badJSON}, want: 2},
		{name: "非法 --key", args: []string{"vendor", "create", "--key", "nokey"}, want: 2},
		{name: "id 非正整数", args: []string{"vendor", "get", "abc"}, want: 2},
		{name: "id 为零", args: []string{"model", "get", "0"}, want: 2},
		{name: "model create 缺路由字段", args: []string{"model", "create", "--key", "name=m1"}, want: 2},
		{name: "route-test 缺 --model", args: []string{"model", "route-test"}, want: 2},
		{name: "recharge 金额非数字", args: []string{"user", "recharge", "12", "--amount", "abc"}, want: 2},
		{name: "recharge 缺金额", args: []string{"user", "recharge", "12"}, want: 2},
		{name: "recharge 非法 type", args: []string{"user", "recharge", "12", "--amount", "1", "--type", "gift"}, want: 2},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			gw := newResourceGateway(t, nil)
			app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
			args := append([]string{}, c.args...)
			if code := runCLI(app, args...); code != c.want {
				t.Fatalf("退出码 = %d, 期望 %d（stderr=%s）", code, c.want, errOut.String())
			}
			if paths := gw.rec.paths(); len(paths) != 0 {
				t.Fatalf("参数错误却发出了请求：%v", paths)
			}
		})
	}
}

// TestP2AuthErrorExitCode 确认资源命令复用统一退出码：401 ⇒ 3。
func TestP2AuthErrorExitCode(t *testing.T) {
	gw := newResourceGateway(t, []stubRoute{{
		method: http.MethodGet, pattern: "/vendor/list.json",
		handler: func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid token"})
		},
	}})
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "vendor", "list", "--url", gw.URL, "--token", testToken); code != 3 {
		t.Fatalf("退出码 = %d, 期望 3（stderr=%s）", code, errOut.String())
	}
}

// TestP2JSONOutputPurity 断言 --json 时 stdout 是合法 JSON、stderr 无内容（列表类与非列表类）。
func TestP2JSONOutputPurity(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{name: "vendor list（{list,total}）", args: []string{"vendor", "list"}},
		{name: "balance list（裸数组）", args: []string{"balance", "list"}},
		{name: "vendor get（单对象）", args: []string{"vendor", "get", "12"}},
		{name: "record list", args: []string{"record", "list"}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			gw := newResourceGateway(t, nil)
			app, out, errOut := newEnvTestApp(t, gw.URL, testToken)
			args := append(append([]string{}, c.args...), "--json")
			if code := runCLI(app, args...); code != 0 {
				t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
			}
			if !json.Valid(out.Bytes()) {
				t.Fatalf("stdout 不是合法 JSON：%q", out.String())
			}
			if errOut.Len() != 0 {
				t.Fatalf("--json 时 stderr 应为空，实际：%q", errOut.String())
			}
		})
	}
}

// TestP2QuietListOutputsIDs 断言 --quiet 时列表只打第一列（通常是 id），可直接接 shell 管道。
func TestP2QuietListOutputsIDs(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "vendor", "list", "-q"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	if got := strings.TrimSpace(out.String()); got != "12" {
		t.Fatalf("--quiet 输出 = %q, 期望仅 id 12", got)
	}
}

// TestP2HumanListPrintsTotalToStderr 断言表格模式下 total 走 stderr，stdout 只有表数据。
func TestP2HumanListPrintsTotalToStderr(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "record", "list"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "total: 42") {
		t.Fatalf("stderr 应含 total: 42，实际：%q", errOut.String())
	}
	if strings.Contains(out.String(), "total:") {
		t.Fatalf("stdout 不应含 total，实际：%q", out.String())
	}
}

// TestMatchRoutePattern 单测占位匹配，避免路由断言本身出错。
func TestMatchRoutePattern(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{pattern: "/vendor/:id", path: "/vendor/12", want: true},
		{pattern: "/vendor/:id", path: "/vendor/12/model", want: false},
		{pattern: "/vendor/:id/model/:modelId", path: "/vendor/12/model/34", want: true},
		{pattern: "/record/clear-payload", path: "/record/7", want: false},
		{pattern: "/tenant.json", path: "/tenant.json", want: true},
	}
	for _, c := range cases {
		if got := matchRoutePattern(c.pattern, c.path); got != c.want {
			t.Fatalf("matchRoutePattern(%q, %q) = %v, 期望 %v", c.pattern, c.path, got, c.want)
		}
	}
}

// TestRecordActivityRendersTimeline 断言 activity 命令按真实响应结构
// {record_id, activities:[{stage,level,message,ts}]} 打印时间线（此前误当 {list,total} 渲染成空表）。
func TestRecordActivityRendersTimeline(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "record", "activity", "7"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	got := out.String()
	for _, want := range []string{"STAGE", "routing", "result", "选中供应商 acme"} {
		if !strings.Contains(got, want) {
			t.Fatalf("activity 输出缺少 %q：\n%s", want, got)
		}
	}
	assertLastRequest(t, gw, http.MethodGet, "/record/7/activity.json", nil)
}

// TestRecordActivityEmptyTimeline 断言空时间线只在 stderr 提示，stdout 不出现空表头。
func TestRecordActivityEmptyTimeline(t *testing.T) {
	gw := newResourceGateway(t, []stubRoute{{
		method: http.MethodGet, pattern: "/record/:id/activity.json",
		handler: func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"record_id": 8, "activities": []any{}})
		},
	}})
	app, out, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "record", "activity", "8"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	if strings.Contains(out.String(), "STAGE") {
		t.Fatalf("空时间线不应打印表头：%q", out.String())
	}
	if !strings.Contains(errOut.String(), "没有活动日志") {
		t.Fatalf("stderr 应提示没有活动日志，实际：%q", errOut.String())
	}
}

// TestUserCreateLegacyTokenFlagRejected 固化 #257 的裁决：
// `user create --token sk-admin-xxx` 会被误读成「设置该用户的 Token」，从而把管理员 Token
// 写进用户记录 —— 这是最坏的静默错误。改名后**不做兼容**：旧 flag 一出现就退出码 2、零请求。
func TestUserCreateLegacyTokenFlagRejected(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{name: "create", args: []string{"user", "create", "--name", "alice", "--token", "sk-admin-oops"}},
		{name: "update", args: []string{"user", "update", "41", "--token", "sk-admin-oops"}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			gw := newResourceGateway(t, nil)
			app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
			if code := runCLI(app, c.args...); code != 2 {
				t.Fatalf("退出码 = %d, 期望 2（stderr=%s）", code, errOut.String())
			}
			if paths := gw.rec.paths(); len(paths) != 0 {
				t.Fatalf("旧 --token 被拒绝了却发出了请求：%v", paths)
			}
			if !strings.Contains(errOut.String(), "--user-token") {
				t.Fatalf("错误提示应指出新名字 --user-token，实际：%q", errOut.String())
			}
		})
	}
}

// TestUserCreateUserTokenFlag `--user-token` 是**用户自己的 Token**：
// 它进请求体 body.token，而鉴权头用的是环境变量里的管理员 Token。
func TestUserCreateUserTokenFlag(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "user", "create", "--name", "alice", "--user-token", "sk-user-1"); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	last := gw.rec.last()
	if last.Method != http.MethodPost || last.Path != "/user/create.json" {
		t.Fatalf("请求 = %s %s", last.Method, last.Path)
	}
	// 鉴权头用环境变量里的管理员 Token，而不是 --user-token
	if auth := last.Header.Get("Authorization"); auth != "Bearer "+testToken {
		t.Fatalf("Authorization = %q, 期望管理员 Token（env）", auth)
	}
	var body map[string]any
	if err := json.Unmarshal(last.Body, &body); err != nil {
		t.Fatalf("请求体不是合法 JSON：%v", err)
	}
	if body["token"] != "sk-user-1" {
		t.Fatalf("body.token = %v, 期望 --user-token 的值 sk-user-1", body["token"])
	}
}

// TestUserUpdateUserTokenEmptyRegenerates `--user-token ""` 仍要把 token 字段作为空串发出去
// （后端语义：重新生成 UUID），所以断言字段存在且为空，而不是「没给就不发」。
func TestUserUpdateUserTokenEmptyRegenerates(t *testing.T) {
	gw := newResourceGateway(t, nil)
	app, _, errOut := newEnvTestApp(t, gw.URL, testToken)
	if code := runCLI(app, "user", "update", "41", "--user-token", ""); code != 0 {
		t.Fatalf("退出码 = %d, 期望 0（stderr=%s）", code, errOut.String())
	}
	body := decodeLastBody(t, gw)
	val, ok := body["token"]
	if !ok {
		t.Fatalf("body 应包含 token 字段（空串表示让服务端重新生成）：%v", body)
	}
	if val != "" {
		t.Fatalf("body.token = %v, 期望空串", val)
	}
}
