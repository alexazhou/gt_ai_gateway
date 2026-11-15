// Package output 负责三态渲染：Table / JSON / Quiet，并保证 stdout 与 stderr 分离。
//
// 硬约束（判据 §5）：`--json` 时 stdout 只允许出现合法 JSON。任何人类提示、
// 进度、错误一律写 stderr，这样 `gtgw status --json 2>/dev/null | jq .` 恒可用。
package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
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

// ---- 通用 JSON 渲染（P2 资源域命令用：接口返回结构各不相同，但都是 JSON） ----

// ValueString 把任意 JSON 值渲染成适合表格单元格的一行文本：
// 标量原样，对象/数组压成紧凑 JSON 并截断，避免把表格撑爆。
func ValueString(v any) string {
	switch typed := v.(type) {
	case nil:
		return ""
	case string:
		return truncate(typed, 120)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		// JSON 数字统一是 float64：整数去掉多余小数位
		if typed == math.Trunc(typed) && math.Abs(typed) < 1e15 {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		raw, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprintf("%v", typed)
		}
		return truncate(string(raw), 120)
	}
}

func truncate(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit]) + "…"
}

// DecodeList 解析「列表类」响应：既支持裸数组，也支持 {list:[...],total:n} 包装。
func DecodeList(raw []byte) (items []map[string]any, total int, err error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, 0, nil
	}
	if trimmed[0] == '[' {
		var arr []any
		if err := json.Unmarshal(trimmed, &arr); err != nil {
			return nil, 0, fmt.Errorf("解析列表响应失败：%w", err)
		}
		items = make([]map[string]any, 0, len(arr))
		for _, entry := range arr {
			switch typed := entry.(type) {
			case map[string]any:
				items = append(items, typed)
			default:
				items = append(items, map[string]any{"value": typed})
			}
		}
		return items, len(items), nil
	}
	var wrapper struct {
		List  []map[string]any `json:"list"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(trimmed, &wrapper); err != nil {
		return nil, 0, fmt.Errorf("解析列表响应失败（既不是数组也不是 {list,total}）：%w", err)
	}
	return wrapper.List, wrapper.Total, nil
}

// RenderList 把列表响应渲染成表格；--quiet 时只打印第一列（通常是 ID）。
// total 打到 stderr，保证 stdout 只含数据。
func (p *Printer) RenderList(raw []byte, columns []string) error {
	items, total, err := DecodeList(raw)
	if err != nil {
		return err
	}
	if p.Quiet {
		for _, item := range items {
			p.Line("%s", ValueString(item[columns[0]]))
		}
		return nil
	}
	rows := make([][]string, 0, len(items))
	for _, item := range items {
		row := make([]string, 0, len(columns))
		for _, col := range columns {
			val := ValueString(item[col])
			if val == "" {
				val = "-"
			}
			row = append(row, val)
		}
		rows = append(rows, row)
	}
	headers := make([]string, 0, len(columns))
	for _, col := range columns {
		headers = append(headers, strings.ToUpper(col))
	}
	if err := p.Table(headers, rows); err != nil {
		return err
	}
	fmt.Fprintf(p.Err, "total: %d\n", total)
	return nil
}

// RenderObject 把单个对象渲染成「键: 值」摘要（嵌套结构压成紧凑 JSON）。
// --quiet 时只打印 id（若存在），便于链式命令使用。
func (p *Printer) RenderObject(raw []byte) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	var obj map[string]any
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		// 不是对象（比如字符串/数组）：原样打出，不假装是键值
		return p.JSONRaw(trimmed)
	}
	if p.Quiet {
		for _, key := range []string{"id", "record_id", "success"} {
			if val, ok := obj[key]; ok {
				p.Line("%s", ValueString(val))
				return nil
			}
		}
		return p.JSONRaw(trimmed)
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([][2]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, [2]string{k, ValueString(obj[k])})
	}
	return p.KV(pairs)
}
