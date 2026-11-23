package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestExitCodeMapping(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		expect int
	}{
		{"成功", nil, ExitOK},
		{"401 鉴权", &APIError{StatusCode: 401}, ExitAuth},
		{"403 权限", &APIError{StatusCode: 403}, ExitAuth},
		{"400 业务", &APIError{StatusCode: 400}, ExitError},
		{"404 业务", &APIError{StatusCode: 404}, ExitError},
		{"409 业务", &APIError{StatusCode: 409}, ExitError},
		{"422 业务", &APIError{StatusCode: 422}, ExitError},
		{"500 服务端", &APIError{StatusCode: 500}, ExitError},
		{"网络错误", &NetworkError{Op: "GET /status.json", Err: context.DeadlineExceeded}, ExitError},
		{"参数错误", Usagef("bad flag"), ExitUsage},
		{"未归类错误", errTest("boom"), ExitError},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ExitCodeOf(c.err); got != c.expect {
				t.Fatalf("ExitCodeOf(%v) = %d, 期望 %d", c.err, got, c.expect)
			}
		})
	}
}

type errTest string

func (e errTest) Error() string { return string(e) }

func TestClientHeaders(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c, err := New(Options{BaseURL: srv.URL + "/", Token: "tok-123", Tenant: "main"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	var out map[string]any
	if _, err := c.PutJSON(context.Background(), "/config.json", map[string]string{"k": "v"}, &out); err != nil {
		t.Fatalf("PutJSON: %v", err)
	}
	if auth := got.Get("Authorization"); auth != "Bearer tok-123" {
		t.Fatalf("Authorization = %q, 期望 Bearer tok-123", auth)
	}
	if tenant := got.Get("X-Tenant-ID"); tenant != "main" {
		t.Fatalf("X-Tenant-ID = %q, 期望 main", tenant)
	}
	if ct := got.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if out["ok"] != true {
		t.Fatalf("响应解析错误：%v", out)
	}
}

func TestClientOmitsTenantWhenEmpty(t *testing.T) {
	var headers http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c, err := New(Options{BaseURL: srv.URL, Token: "t"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := c.GetJSON(context.Background(), "/status.json", nil); err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	if _, ok := headers["X-Tenant-Id"]; ok {
		t.Fatal("未设置租户时不应发送 X-Tenant-ID")
	}
}

func TestAPIErrorBodyParsing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"内部错误","code":"internal_error","request_id":"err_abc123"}`))
	}))
	defer srv.Close()

	c, err := New(Options{BaseURL: srv.URL, Token: "t"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = c.GetJSON(context.Background(), "/status.json", nil)
	if err == nil {
		t.Fatal("500 应返回错误")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("错误类型 = %T, 期望 *APIError", err)
	}
	if apiErr.StatusCode != 500 || apiErr.Message != "内部错误" || apiErr.Code != "internal_error" || apiErr.RequestID != "err_abc123" {
		t.Fatalf("解析结果 = %+v", apiErr)
	}
	if code := ExitCodeOf(err); code != ExitError {
		t.Fatalf("退出码 = %d, 期望 1", code)
	}
}

func TestAPIErrorFallbackMessage(t *testing.T) {
	err := newAPIError(400, []byte(`{"message":"字段缺失"}`))
	if err.Message != "字段缺失" {
		t.Fatalf("Message = %q, 期望回退到 message 字段", err.Message)
	}
	plain := newAPIError(400, []byte("plain text body"))
	if plain.Message != "" {
		t.Fatalf("Message = %q, 非 JSON 响应体不应解析出 message", plain.Message)
	}
	if plain.Error() == "" {
		t.Fatal("Error() 不应为空")
	}
}

func TestNewValidatesBaseURL(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Fatal("空地址应报错")
	} else if ExitCodeOf(err) != ExitUsage {
		t.Fatalf("退出码 = %d, 期望 2", ExitCodeOf(err))
	}
	if _, err := New(Options{BaseURL: "127.0.0.1:8720"}); err == nil {
		t.Fatal("缺少 scheme 应报错")
	}
	c, err := New(Options{BaseURL: "https://gateway.example/", Token: "t"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if c.BaseURL() != "https://gateway.example" {
		t.Fatalf("BaseURL() = %q, 期望去掉尾部斜杠", c.BaseURL())
	}
}

func TestNetworkError(t *testing.T) {
	c, err := New(Options{BaseURL: "http://127.0.0.1:1", Token: "t", Timeout: 300 * time.Millisecond})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = c.GetJSON(context.Background(), "/status.json", nil)
	if err == nil {
		t.Fatal("连不上应报错")
	}
	if ExitCodeOf(err) != ExitError {
		t.Fatalf("退出码 = %d, 期望 1", ExitCodeOf(err))
	}
}

func TestJSONResponseBodySurvivesForRawOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","system":{"version":"1.9.1-beta1"}}`))
	}))
	defer srv.Close()

	c, err := New(Options{BaseURL: srv.URL, Token: "t"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	resp, err := c.GetJSON(context.Background(), "/status.json", nil)
	if err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(resp.Body, &decoded); err != nil {
		t.Fatalf("原始响应体应保持合法 JSON：%v", err)
	}
	if decoded["status"] != "ok" {
		t.Fatalf("decoded = %v", decoded)
	}
}

// TestAPIErrorThreeKnownShapes 覆盖后端三种已知错误形态（业务错 / 500 带 request_id / 401·403 只有 error）。
func TestAPIErrorThreeKnownShapes(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		wantMessage string
		wantCode    string
		wantReqID   string
		wantExit    int
	}{
		{
			name:        "业务错误 {error,code}",
			status:      http.StatusBadRequest,
			body:        `{"error":"参数不合法","code":"bad_request"}`,
			wantMessage: "参数不合法",
			wantCode:    "bad_request",
			wantExit:    ExitError,
		},
		{
			name:        "500 带 request_id",
			status:      http.StatusInternalServerError,
			body:        `{"error":"内部错误","code":"internal_error","request_id":"err_abc123"}`,
			wantMessage: "内部错误",
			wantCode:    "internal_error",
			wantReqID:   "err_abc123",
			wantExit:    ExitError,
		},
		{
			name:        "401 只有 {error}",
			status:      http.StatusUnauthorized,
			body:        `{"error":"Invalid token"}`,
			wantMessage: "Invalid token",
			wantExit:    ExitAuth,
		},
		{
			name:        "403 只有 {error}",
			status:      http.StatusForbidden,
			body:        `{"error":"Admin access required"}`,
			wantMessage: "Admin access required",
			wantExit:    ExitAuth,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()

			cl, err := New(Options{BaseURL: srv.URL, Token: "t"})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			_, err = cl.GetJSON(context.Background(), "/status.json", nil)
			apiErr, ok := err.(*APIError)
			if !ok {
				t.Fatalf("错误类型 = %T, 期望 *APIError", err)
			}
			if apiErr.Message != c.wantMessage || apiErr.Code != c.wantCode || apiErr.RequestID != c.wantReqID {
				t.Fatalf("解析结果 = %+v", apiErr)
			}
			if !apiErr.HasStructuredMessage() {
				t.Fatal("已知形态应判定为结构化错误")
			}
			if got := ExitCodeOf(err); got != c.wantExit {
				t.Fatalf("退出码 = %d, 期望 %d", got, c.wantExit)
			}
		})
	}
}

// TestAPIErrorUnknownShapeKeepsBody 验证「未知错误形态」不吞原始 body。
func TestAPIErrorUnknownShapeKeepsBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html><body>502 Bad Gateway (nginx)</body></html>"))
	}))
	defer srv.Close()

	cl, err := New(Options{BaseURL: srv.URL, Token: "t"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = cl.GetJSON(context.Background(), "/status.json", nil)
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("错误类型 = %T", err)
	}
	if apiErr.HasStructuredMessage() {
		t.Fatal("HTML 响应体不应被判定为结构化错误")
	}
	preview := apiErr.BodyPreview(512)
	if !strings.Contains(preview, "502 Bad Gateway") {
		t.Fatalf("预览丢失原始 body：%q", preview)
	}
}

func TestBodyPreviewTruncates(t *testing.T) {
	long := strings.Repeat("错", 1000) // 1000 个多字节字符
	e := &APIError{StatusCode: 500, Body: []byte(long)}
	preview := e.BodyPreview(512)
	if !strings.HasSuffix(strings.SplitN(preview, "…", 2)[0], "") {
		t.Fatalf("预览格式异常：%q", preview)
	}
	if !strings.Contains(preview, "已截断") {
		t.Fatalf("长 body 应带截断提示：%q", preview)
	}
	// 按 rune 截断，不能切出半个 UTF-8 字符
	head := strings.SplitN(preview, "…", 2)[0]
	if got := len([]rune(head)); got != 512 {
		t.Fatalf("截断后 rune 数 = %d, 期望 512", got)
	}
	if !utf8.ValidString(head) {
		t.Fatalf("截断破坏了 UTF-8：%q", head)
	}
}
