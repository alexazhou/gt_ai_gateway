package client

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// StreamResponse 是流式响应的句柄：调用方需要自己读完并 Close。
//
// 与 Response 的区别只有一个：Body 不预先读进内存。
// SSE 的价值就在于「边到边用」，先 ReadAll 再解析会把时间戳证据一起丢掉。
type StreamResponse struct {
	StatusCode int
	Header     http.Header
	Body       io.ReadCloser
}

// Close 释放底层连接。
func (s *StreamResponse) Close() error {
	if s == nil || s.Body == nil {
		return nil
	}
	return s.Body.Close()
}

// ContentType 返回响应的 Content-Type（去掉参数）。
func (s *StreamResponse) ContentType() string {
	if s == nil {
		return ""
	}
	return s.Header.Get("Content-Type")
}

// maxErrorBodyForStream 是非 2xx 响应体的读取上限：错误体是要展示的，不是要消费的，
// 但不能无上限读（恶意/异常服务端可能一直吐字节）。
const maxErrorBodyForStream = 64 << 10

// DoStream 发起一次「响应体按流读取」的请求。
//
// 非 2xx 不返回 StreamResponse：此时响应体是错误 JSON，读全（最多 64KB）后转成 *APIError，
// 保证流式命令的退出码与普通命令完全一致（401/403→3，其余 4xx/5xx→1）。
func (c *Client) DoStream(ctx context.Context, method, path string, body any) (*StreamResponse, error) {
	if !hasPrefixSlash(path) {
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
	req.Header.Set("Accept", "text/event-stream")
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

	if resp.StatusCode >= http.StatusBadRequest {
		defer resp.Body.Close()
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyForStream))
		if readErr != nil {
			return nil, &NetworkError{Op: "读取错误响应 " + method + " " + path, Err: readErr}
		}
		return nil, newAPIError(resp.StatusCode, raw)
	}

	return &StreamResponse{StatusCode: resp.StatusCode, Header: resp.Header, Body: resp.Body}, nil
}

// hasPrefixSlash 判断路径是否以 / 开头（避免与 strings 包反复导入冲突）。
func hasPrefixSlash(path string) bool {
	return len(path) > 0 && path[0] == '/'
}
