// Package output 负责三态渲染：Table / JSON / Quiet，并保证 stdout 与 stderr 分离。
//
// 硬约束（判据 §5）：`--json` 时 stdout 只允许出现合法 JSON。任何人类提示、
// 进度、错误一律写 stderr，这样 `gtgw status --json 2>/dev/null | jq .` 恒可用。
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
)

// Printer 绑定三态开关与两个输出流。
type Printer struct {
	Out   io.Writer
	Err   io.Writer
	JSON  bool
	Quiet bool
}

// New 构造 Printer。out/err 为 nil 时退化为 io.Discard，避免 nil panic。
func New(out, errOut io.Writer, asJSON, quiet bool) *Printer {
	if out == nil {
		out = io.Discard
	}
	if errOut == nil {
		errOut = io.Discard
	}
	return &Printer{Out: out, Err: errOut, JSON: asJSON, Quiet: quiet}
}

// MaskToken 对 token 脱敏：长度 <= 8 显示 `****`，否则保留前 4 位与后 4 位。
func MaskToken(token string) string {
	if token == "" {
		return ""
	}
	if len(token) <= 8 {
		return "****"
	}
	return token[:4] + "****" + token[len(token)-4:]
}

// JSONValue 把 v 以缩进 JSON 写到 stdout。
func (p *Printer) JSONValue(v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化输出失败：%w", err)
	}
	_, err = fmt.Fprintf(p.Out, "%s\n", raw)
	return err
}

// JSONRaw 把服务端原始 JSON 规范化缩进后写到 stdout（保持字段原样，不做结构转换）。
func (p *Printer) JSONRaw(raw []byte) error {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		trimmed = "{}"
	}
	var buf any
	if err := json.Unmarshal([]byte(trimmed), &buf); err != nil {
		return fmt.Errorf("服务端返回的不是合法 JSON：%w", err)
	}
	return p.JSONValue(buf)
}

// JSONError 把错误以结构化 JSON 写到 stderr（--json 模式下的错误输出）。
func (p *Printer) JSONError(err error, extra map[string]any) {
	payload := map[string]any{"error": err.Error()}
	for k, v := range extra {
		payload[k] = v
	}
	raw, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		fmt.Fprintf(p.Err, "Error: %v\n", err)
		return
	}
	fmt.Fprintf(p.Err, "%s\n", raw)
}

// Table 以制表对齐输出表头与行。
func (p *Printer) Table(headers []string, rows [][]string) error {
	tw := tabwriter.NewWriter(p.Out, 0, 0, 2, ' ', 0)
	if len(headers) > 0 {
		if _, err := fmt.Fprintln(tw, strings.Join(headers, "\t")); err != nil {
			return err
		}
	}
	for _, row := range rows {
		if _, err := fmt.Fprintln(tw, strings.Join(row, "\t")); err != nil {
			return err
		}
	}
	return tw.Flush()
}

// KV 以「键: 值」形式输出摘要；键按传入顺序排列，空值显示为空。
func (p *Printer) KV(pairs [][2]string) error {
	width := 0
	for _, kv := range pairs {
		if len(kv[0]) > width {
			width = len(kv[0])
		}
	}
	for _, kv := range pairs {
		if _, err := fmt.Fprintf(p.Out, "%-*s  %s\n", width, kv[0], kv[1]); err != nil {
			return err
		}
	}
	return nil
}

// KVSorted 以键名排序输出 map 形式的配置（config get / config set 用）。
func (p *Printer) KVSorted(values map[string]string) error {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([][2]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, [2]string{k, values[k]})
	}
	return p.KV(pairs)
}

// Line 向 stdout 输出一行（人类模式下的正文）。
func (p *Printer) Line(format string, a ...any) {
	fmt.Fprintf(p.Out, format+"\n", a...)
}

// Info 向 stderr 输出提示信息（不污染 stdout）。
func (p *Printer) Info(format string, a ...any) {
	fmt.Fprintf(p.Err, format+"\n", a...)
}
