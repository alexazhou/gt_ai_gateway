package cmd

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// route-command-map 的机读源是 cli/testdata/route-map.json：它同时被
// 「路由 → 命令」双向对照表的生成脚本和本测试消费，避免文档与代码各写一份。
//
// 本测试守住三件事：
//  1. src/routes.ts 里的每条路由都在 map 里有且仅有一条记录（不多不少）；
//  2. 已覆盖的路由必须指向一个**真实存在于命令树**里的命令；
//  3. 未覆盖的路由必须写明理由（不许留空、不许只写 TODO）。
func TestRouteMapCoversRoutesTs(t *testing.T) {
	routes := loadRoutesTs(t)
	doc := loadRouteMap(t)

	if doc.Source != "src/routes.ts" {
		t.Fatalf("route-map.source = %q, 期望 src/routes.ts", doc.Source)
	}

	type key struct{ method, path string }
	seen := map[key]bool{}
	for _, entry := range doc.Entries {
		k := key{entry.Method, entry.Path}
		if seen[k] {
			t.Fatalf("route-map 重复记录：%s %s", entry.Method, entry.Path)
		}
		seen[k] = true
		if !routes[k] {
			t.Fatalf("route-map 里的 %s %s 在 src/routes.ts 中不存在（命令/理由都必须锚在真实路由上）", entry.Method, entry.Path)
		}
	}

	for k := range routes {
		if !seen[k] {
			t.Fatalf("src/routes.ts 的 %s %s 在 route-map 中没有记录：请给它挂命令，或写明不覆盖的理由", k.method, k.path)
		}
	}

	// 覆盖项：命令必须真实存在，phase 必须是已知值，且不能带理由。
	tree := commandPathIndex(t)
	covered := 0
	for _, entry := range doc.Entries {
		if entry.Command == nil {
			if strings.TrimSpace(deref(entry.Reason)) == "" {
				t.Fatalf("%s %s 未覆盖但没有理由", entry.Method, entry.Path)
			}
			if entry.Category == "" {
				t.Fatalf("%s %s 未覆盖但没有 category", entry.Method, entry.Path)
			}
			continue
		}
		covered++
		switch deref(entry.Phase) {
		case "P1", "P2", "P3":
		default:
			t.Fatalf("%s %s 的 phase = %q，期望 P1/P2/P3", entry.Method, entry.Path, deref(entry.Phase))
		}
		if strings.TrimSpace(deref(entry.Reason)) != "" {
			t.Fatalf("%s %s 已覆盖却仍写了理由：命令与理由互斥", entry.Method, entry.Path)
		}
		name := commandPathOf(*entry.Command)
		if _, ok := tree[name]; !ok {
			t.Fatalf("%s %s 映射到命令 %q，但命令树里没有 `gtgw %s`", entry.Method, entry.Path, *entry.Command, name)
		}
	}

	// 反向：命令树里每个 P2 叶子命令都必须在 map 中出现，避免「写了命令忘了登记路由」。
	claimed := map[string]bool{}
	for _, entry := range doc.Entries {
		if entry.Command != nil {
			claimed[commandPathOf(*entry.Command)] = true
		}
	}
	for _, name := range p2LeafCommandPaths(tree) {
		if !claimed[name] {
			t.Fatalf("命令 `gtgw %s` 在 route-map 里没有对应路由记录", name)
		}
	}

	// 偏差记录：每条都要有 id / 文档写法 / 代码事实 / CLI 做法 / 理由，缺一项说明文档没写完。
	if len(doc.Deviations) == 0 {
		t.Fatalf("route-map.json 没有 deviations：文档偏差必须以代码为准并逐条记录")
	}
	for _, d := range doc.Deviations {
		for field, value := range map[string]string{
			"id": d.ID, "doc": d.Doc, "code": d.Code, "cli": d.CLI, "reason": d.Reason,
		} {
			if strings.TrimSpace(value) == "" {
				t.Fatalf("deviation %q 的 %s 为空", d.ID, field)
			}
		}
	}

	t.Logf("routes.ts=%d 条，已覆盖=%d 条，未覆盖=%d 条，偏差记录=%d 条",
		len(routes), covered, len(routes)-covered, len(doc.Deviations))
}

// ---------- 数据装载 ----------

type routeMapEntry struct {
	Method   string  `json:"method"`
	Path     string  `json:"path"`
	Command  *string `json:"command"`
	Phase    *string `json:"phase"`
	Reason   *string `json:"reason"`
	Category string  `json:"category"`
}

type routeMapDoc struct {
	Source     string           `json:"source"`
	Entries    []routeMapEntry  `json:"entries"`
	Deviations []routeDeviation `json:"deviations"`
}

// routeDeviation 是「step2 文档写法 ↔ 代码事实 ↔ CLI 做法」的偏差记录。
// 放在映射数据里一起被生成脚本渲染进 route-command-map.md，避免文档与实现各写一份。
type routeDeviation struct {
	ID     string `json:"id"`
	Doc    string `json:"doc"`
	Code   string `json:"code"`
	CLI    string `json:"cli"`
	Reason string `json:"reason"`
}

func loadRouteMap(t *testing.T) routeMapDoc {
	t.Helper()
	raw, err := os.ReadFile("testdata/route-map.json")
	if err != nil {
		t.Fatalf("读取 testdata/route-map.json: %v", err)
	}
	var doc routeMapDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("解析 route-map.json: %v", err)
	}
	if len(doc.Entries) == 0 {
		t.Fatalf("route-map.json 没有条目")
	}
	return doc
}

var routeDeclRe = regexp.MustCompile(`(?m)^app\.(get|post|put|delete)\("([^"]+)"`)

// loadRoutesTs 解析 src/routes.ts 里注册的路由。
//
// 路径候选包含仓库内编译场景（cli/cmd → ../../src）与独立模块场景；找不到时直接失败，
// 不允许静默跳过——这条对照关系是 P2 的承重判据。
func loadRoutesTs(t *testing.T) map[struct{ method, path string }]bool {
	t.Helper()
	candidates := []string{}
	if custom := strings.TrimSpace(os.Getenv("GTGW_ROUTES_TS")); custom != "" {
		candidates = append(candidates, custom)
	}
	candidates = append(candidates, "../../src/routes.ts", "../../../src/routes.ts", "src/routes.ts")

	var raw []byte
	var used string
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err == nil {
			raw, used = data, path
			break
		}
	}
	if raw == nil {
		t.Fatalf("找不到 src/routes.ts（试过 %v）。\n"+
			"入口差集是本需求的承重判据，所以这里**失败而不是跳过**：\n"+
			"  请用环境变量 GTGW_ROUTES_TS 指向仓库里的 src/routes.ts（该判据校验 routes.ts ↔ 命令的入口覆盖）。\n"+
			"  典型用法：GTGW_ROUTES_TS=$PWD/src/routes.ts go test ./cmd -run TestRouteMapCoversRoutesTs", candidates)
	}
	t.Logf("routes.ts = %s", used)

	routes := map[struct{ method, path string }]bool{}
	for _, m := range routeDeclRe.FindAllStringSubmatch(string(raw), -1) {
		routes[struct{ method, path string }{strings.ToUpper(m[1]), m[2]}] = true
	}
	if len(routes) == 0 {
		t.Fatalf("%s 里没解析出任何 app.<method>(\"/path\") 声明，正则可能已与代码脱节", used)
	}
	return routes
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ---------- 命令树 ----------

// commandPathIndex 返回「命令全路径（不含 gtw）→ 命令」的索引。
func commandPathIndex(t *testing.T) map[string]*cobra.Command {
	t.Helper()
	app, _, _ := newEnvTestApp(t, "http://127.0.0.1:1", "token")
	root := app.NewRootCmd()
	index := map[string]*cobra.Command{}
	var walk func(cmd *cobra.Command, prefix string)
	walk = func(cmd *cobra.Command, prefix string) {
		for _, child := range cmd.Commands() {
			name := strings.TrimSpace(strings.SplitN(child.Use, " ", 2)[0])
			if name == "" || name == "help" || name == "completion" {
				continue
			}
			full := strings.TrimSpace(prefix + " " + name)
			index[full] = child
			walk(child, full)
		}
	}
	walk(root, "")
	return index
}

// commandPathOf 把 route-map 里的命令写法（"gtgw vendor model list <vendorId>"）
// 归一成命令全路径（"vendor model list"）。
func commandPathOf(command string) string {
	parts := strings.Fields(command)
	if len(parts) > 0 && parts[0] == "gtgw" {
		parts = parts[1:]
	}
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		// 跳掉位置参数（<id>）与 flag（--file <json>）：命令路径只保留子命令链
		if strings.HasPrefix(part, "<") || strings.HasPrefix(part, "-") {
			continue
		}
		kept = append(kept, part)
	}
	return strings.Join(kept, " ")
}

// p2LeafCommandPaths 返回「对接网关路由」的命令树下的叶子命令全路径。
//
// 注意 integration 不在其中：`gtgw integration env` 是纯本地生成，不访问任何路由，
// 强行登记会逼着映射表编一条不存在的路由。
func p2LeafCommandPaths(index map[string]*cobra.Command) []string {
	roots := map[string]bool{
		"vendor": true, "model": true, "user": true,
		"balance": true, "tenant": true, "rule": true, "record": true,
		"client": true, "test": true,
	}
	var out []string
	for name, cmd := range index {
		head := strings.SplitN(name, " ", 2)[0]
		if !roots[head] {
			continue
		}
		if cmd.HasSubCommands() {
			continue
		}
		out = append(out, name)
	}
	return out
}
