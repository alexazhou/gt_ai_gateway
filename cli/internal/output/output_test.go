package output

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestMaskToken(t *testing.T) {
	if got := MaskToken("12345678"); got != "****" {
		t.Fatalf("MaskToken(<=8) = %q, 期望 ****", got)
	}
	if got := MaskToken("sk-1234567890"); got != "sk-1****7890" {
		t.Fatalf("MaskToken = %q", got)
	}
	if got := MaskToken(""); got != "" {
		t.Fatalf("MaskToken(\"\") = %q, 期望空串", got)
	}
}

// TestJSONPurity 验证 --json 模式下 stdout 只有合法 JSON，人类提示全在 stderr。
func TestJSONPurity(t *testing.T) {
	var out, errOut bytes.Buffer
	p := New(&out, &errOut, true, false)

	if err := p.JSONValue(map[string]any{"status": "ok"}); err != nil {
		t.Fatalf("JSONValue: %v", err)
	}
	p.Info("提示：这是人类可读信息")
	p.JSONError(errString("boom"), map[string]any{"status": 500})

	if !json.Valid(out.Bytes()) {
		t.Fatalf("stdout 不是合法 JSON：%q", out.String())
	}
	if strings.Contains(out.String(), "提示") {
		t.Fatalf("人类提示污染了 stdout：%q", out.String())
	}
	if !strings.Contains(errOut.String(), "提示") {
		t.Fatalf("stderr 丢失人类提示：%q", errOut.String())
	}
	if !strings.Contains(errOut.String(), `"error":"boom"`) {
		t.Fatalf("stderr 的结构化错误缺少 error 字段：%q", errOut.String())
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestJSONRawKeepsFields(t *testing.T) {
	var out bytes.Buffer
	p := New(&out, &bytes.Buffer{}, true, false)
	if err := p.JSONRaw([]byte(`{"status":"ok","system":{"version":"1.9.1-beta1"}}`)); err != nil {
		t.Fatalf("JSONRaw: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("stdout 不是合法 JSON：%v", err)
	}
	system, ok := decoded["system"].(map[string]any)
	if !ok || system["version"] != "1.9.1-beta1" {
		t.Fatalf("字段被改写：%v", decoded)
	}
}

func TestJSONRawRejectsInvalid(t *testing.T) {
	p := New(&bytes.Buffer{}, &bytes.Buffer{}, true, false)
	if err := p.JSONRaw([]byte("<html>not json</html>")); err == nil {
		t.Fatal("非 JSON 响应体应报错，而不是把 HTML 打到 stdout")
	}
}

func TestTable(t *testing.T) {
	var out bytes.Buffer
	p := New(&out, &bytes.Buffer{}, false, false)
	if err := p.Table([]string{"NAME", "URL"}, [][]string{{"local", "http://127.0.0.1:8720"}, {"prod", "https://gw.example"}}); err != nil {
		t.Fatalf("Table: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("行数 = %d, 期望 3：%q", len(lines), out.String())
	}
	if !strings.HasPrefix(lines[0], "NAME") {
		t.Fatalf("表头错误：%q", lines[0])
	}
	// tabwriter 需要按列对齐：第二列起点应一致
	firstIdx := strings.Index(lines[1], "http")
	secondIdx := strings.Index(lines[2], "https")
	if firstIdx != secondIdx {
		t.Fatalf("列未对齐：%q vs %q", lines[1], lines[2])
	}
}

func TestKVSorted(t *testing.T) {
	var out bytes.Buffer
	p := New(&out, &bytes.Buffer{}, false, false)
	if err := p.KVSorted(map[string]string{"b": "2", "a": "1"}); err != nil {
		t.Fatalf("KVSorted: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "a") || !strings.HasPrefix(lines[1], "b") {
		t.Fatalf("输出未按 key 排序：%q", out.String())
	}
}
