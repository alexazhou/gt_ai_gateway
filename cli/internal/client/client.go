// Package client 是 gtgw 的 HTTP 客户端层。
//
// 它只做三件事：
//  1. 把 BaseURL / Token / Tenant 注入到每个请求（Authorization: Bearer、X-Tenant-ID）；
//  2. 把非 2xx 响应解析成带退出码语义的 *APIError；
//  3. 把「用户输入问题」「网络问题」「服务端问题」统一映射到 0/1/2/3 四种退出码
//     （step2 §错误分类与退出码约定）。
//
// 本包不直接访问任何数据库，也不绕过网关接口——纯 HTTP 客户端是产品的硬边界。
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// 退出码约定（step2 §错误分类与退出码约定）
const (
	// ExitOK 成功。
	ExitOK = 0
	// ExitError 业务 / 服务端错误：HTTP 400/404/409/422/5xx，或网络连接失败。
	ExitError = 1
	// ExitUsage 参数错误：缺失必填参数、JSON 文件解析失败、Flag 非法。
	ExitUsage = 2
	// ExitAuth 鉴权 / 权限错误：本地无有效 Token，或服务端 401/403。
	ExitAuth = 3
)

// 超时策略（step2 §请求头与超时）
const (
	// DefaultTimeout 管理接口默认超时。
	DefaultTimeout = 30 * time.Second
	// InferenceTimeout 推理 / 连通性测试类请求默认超时。
	InferenceTimeout = 120 * time.Second
)

// UsageError 表示调用方参数或输入有问题，退出码 2。
type UsageError struct {
	Msg string
}

func (e *UsageError) Error() string { return e.Msg }

// ExitCode 实现 ExitCoder。
func (e *UsageError) ExitCode() int { return ExitUsage }

// Usagef 构造一个 UsageError。
func Usagef(format string, a ...any) error {
	return &UsageError{Msg: fmt.Sprintf(format, a...)}
}

// NetworkError 表示请求没能拿到响应（DNS / 连接被拒 / 超时等），退出码 1。
type NetworkError struct {
	Op  string
	Err error
}

func (e *NetworkError) Error() string {
	return fmt.Sprintf("网络请求失败（%s）：%v", e.Op, e.Err)
}

// Unwrap 让 errors.Is/As 能继续追踪底层错误。
func (e *NetworkError) Unwrap() error { return e.Err }

// ExitCode 实现 ExitCoder。
func (e *NetworkError) ExitCode() int { return ExitError }

// APIError 表示服务端返回了非 2xx 响应，退出码 1（401/403 为 3）。
type APIError struct {
	StatusCode int
	Message    string
	Code       string
	RequestID  string
	Body       []byte
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("服务端返回 %d：%s", e.StatusCode, e.Message)
	}
	// 未解析出结构化错误信息时，不要在这里把整段 body 塞进 message：
	// 调用方的输出层会用 BodyPreview 截断展示，避免超长 HTML/堆栈把 stderr 刷爆。
	return fmt.Sprintf("服务端返回 %d（响应体不是结构化错误 JSON，原始内容见下）", e.StatusCode)
}

// BodyPreview 返回响应体前 n 字节的预览（用于「未知错误形态」时把原文暴露给用户）。
// 触发条件：响应体不是后端约定的结构化错误 JSON，此时不预览就会只剩一句空错误。
func (e *APIError) BodyPreview(n int) string {
	body := strings.TrimSpace(string(e.Body))
	if body == "" {
		return ""
	}
	if n <= 0 {
		n = 512
	}
	if len(body) <= n {
		return body
	}
	// 按 rune 截断，避免把 UTF-8 多字节字符切成半个
	runes := []rune(body)
	if len(runes) <= n {
		return body
	}
	return string(runes[:n]) + "…（已截断，原始长度 " + strconv.Itoa(len(body)) + " 字节）"
}

// HasStructuredMessage 表示响应体解析出了后端约定的可读错误信息。
func (e *APIError) HasStructuredMessage() bool {
	return e.Message != "" || e.Code != "" || e.RequestID != ""
}

// ExitCode 实现 ExitCoder：401/403 归为鉴权错误。
func (e *APIError) ExitCode() int {
	if e.StatusCode == http.StatusUnauthorized || e.StatusCode == http.StatusForbidden {
		return ExitAuth
	}
	return ExitError
}

// ExitCoder 由能够自报退出码的错误实现。
type ExitCoder interface {
	ExitCode() int
}

// ExitCodeOf 把任意错误映射成退出码：nil→0，能自报的用它，其余按业务错误 1。
func ExitCodeOf(err error) int {
	if err == nil {
		return ExitOK
	}
	var coder ExitCoder
	if errors.As(err, &coder) {
		return coder.ExitCode()
	}
	return ExitError
}

// errorBody 是后端错误响应体的两种形态（见 src/routes.ts onError 与 src/middleware/authUtil.ts）：
// 业务错误 {error, code?}，500 另带 request_id，401/403 只有 {error}。
type errorBody struct {
	Error     string `json:"error"`
	Message   string `json:"message"`
	Code      string `json:"code"`
	RequestID string `json:"request_id"`
}

// Options 构造 Client 的参数。
type Options struct {
	BaseURL string
	Token   string
	Tenant  string
	// Timeout 为 0 时使用 DefaultTimeout。
	Timeout time.Duration
	// HTTP 为 nil 时使用带 Timeout 的默认 client（测试可注入 httptest 的 client）。
	HTTP *http.Client
}

// Client 是绑定了连接配置的 HTTP 客户端。
type Client struct {
	baseURL string
	token   string
	tenant  string
	http    *http.Client
}

// Response 是原始响应，供需要「原样透传 JSON」的命令使用（如 status / config get）。
type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// Unmarshal 把响应体解析到 v。
func (r *Response) Unmarshal(v any) error {
	if err := json.Unmarshal(r.Body, v); err != nil {
		return fmt.Errorf("解析服务端响应失败：%w", err)
	}
	return nil
}

// New 构造客户端。BaseURL 必须带 http(s):// 前缀，否则返回 UsageError（退出码 2）。
func New(o Options) (*Client, error) {
	base := strings.TrimRight(strings.TrimSpace(o.BaseURL), "/")
	if base == "" {
		return nil, Usagef("缺少网关地址：请先 `gtgw login`，或传 --url / 设置 GTGW_URL")
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return nil, Usagef("网关地址必须以 http:// 或 https:// 开头，实际为 %q", o.BaseURL)
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	hc := o.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: timeout}
	}
	return &Client{baseURL: base, token: strings.TrimSpace(o.Token), tenant: strings.TrimSpace(o.Tenant), http: hc}, nil
}

// BaseURL 返回规范化后的网关地址（去掉尾部斜杠）。
func (c *Client) BaseURL() string { return c.baseURL }

// Tenant 返回当前租户视角（可能为空）。
func (c *Client) Tenant() string { return c.tenant }

// Do 发送请求并返回原始响应。body 为 nil 时不发送请求体。
// 非 2xx 一律返回 *APIError；请求发不出去返回 *NetworkError。
func (c *Client) Do(ctx context.Context, method, path string, body any) (*Response, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, Usagef("内部错误：请求路径必须以 / 开头，实际为 %q", path)
	}
	var reader io.Reader
	hasBody := body != nil
	if hasBody {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, Usagef("请求体不是合法 JSON：%v", err)
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, Usagef("构造请求失败：%v", err)
	}
	req.Header.Set("Accept", "application/json")
	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.tenant != "" {
		req.Header.Set("X-Tenant-ID", c.tenant)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &NetworkError{Op: method + " " + path, Err: err}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &NetworkError{Op: "读取响应 " + method + " " + path, Err: err}
	}

	out := &Response{StatusCode: resp.StatusCode, Header: resp.Header, Body: raw}
	if resp.StatusCode >= http.StatusBadRequest {
		return out, newAPIError(resp.StatusCode, raw)
	}
	return out, nil
}

func newAPIError(status int, raw []byte) *APIError {
	apiErr := &APIError{StatusCode: status, Body: raw}
	var parsed errorBody
	if err := json.Unmarshal(raw, &parsed); err == nil {
		apiErr.Message = parsed.Error
		if apiErr.Message == "" {
			apiErr.Message = parsed.Message
		}
		apiErr.Code = parsed.Code
		apiErr.RequestID = parsed.RequestID
	}
	return apiErr
}

// GetJSON 发送 GET 并把响应解析到 out（out 为 nil 时忽略响应体）。
func (c *Client) GetJSON(ctx context.Context, path string, out any) (*Response, error) {
	return c.doJSON(ctx, http.MethodGet, path, nil, out)
}

// PutJSON 发送 PUT（body 为请求体）并把响应解析到 out。
func (c *Client) PutJSON(ctx context.Context, path string, body, out any) (*Response, error) {
	return c.doJSON(ctx, http.MethodPut, path, body, out)
}

// PostJSON 发送 POST（body 为请求体）并把响应解析到 out。
func (c *Client) PostJSON(ctx context.Context, path string, body, out any) (*Response, error) {
	return c.doJSON(ctx, http.MethodPost, path, body, out)
}

// DeleteJSON 发送 DELETE 并把响应解析到 out。
func (c *Client) DeleteJSON(ctx context.Context, path string, out any) (*Response, error) {
	return c.doJSON(ctx, http.MethodDelete, path, nil, out)
}

func (c *Client) doJSON(ctx context.Context, method, path string, body, out any) (*Response, error) {
	resp, err := c.Do(ctx, method, path, body)
	if err != nil {
		return resp, err
	}
	if out != nil && len(bytes.TrimSpace(resp.Body)) > 0 {
		if err := resp.Unmarshal(out); err != nil {
			return resp, err
		}
	}
	return resp, nil
}

// IsTimeout 判断错误是否属于「请求超时 / 客户端主动放弃」。
//
// 用途：非幂等写操作超时后要提示「服务端可能已执行」——客户端超时与服务端完成是两件事
// （2026-11-15 的验收事故里，三个 DELETE 客户端全部超时退出，服务端全部 200）。
func IsTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	// url.Error 会包一层，errors.As 已覆盖；这里兜底判断文案（部分自定义 RoundTripper 不实现 net.Error）
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "context deadline exceeded") ||
		strings.Contains(msg, "timeout awaiting response headers") ||
		strings.Contains(msg, "i/o timeout")
}

// CleanupTimeout 是长耗时清理类接口的默认超时（真实库 clear-payload 实测 193.9s）。
const CleanupTimeout = 5 * time.Minute
