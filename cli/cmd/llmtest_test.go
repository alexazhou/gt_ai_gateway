package cmd

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// sseHandler 把给定的帧序列按“先写、再等”的方式吐出去，用来构造真实的流式节奏。
// delays[i] 表示写完第 i 帧之后等待多久（最后一个可以省略）。
func sseHandler(frames []string, delays []time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i, frame := range frames {
			if _, err := w.Write([]byte(frame)); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
			if i < len(delays) && delays[i] > 0 {
				time.Sleep(delays[i])
			}
		}
	}
}

// timedWriter 记录每次写出的时刻，用来证明「增量是真的分段到达，而不是最后一次性写出」。
type timedWriter struct {
	mu     sync.Mutex
	writes []writeRecord
	buf    bytes.Buffer
}

type writeRecord struct {
	At   time.Time
	Text string
}

func (w *timedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writes = append(w.writes, writeRecord{At: time.Now(), Text: string(p)})
	return w.buf.Write(p)
}

func (w *timedWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// TestTestModelsCommand 覆盖 `test models`：路径、鉴权头、表格输出。
func TestTestModelsCommand(t *testing.T) {
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		llmModelsPath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"object": "list",
				"data": []map[string]any{
					{"id": "gpt-4o-mini", "object": "model", "created": 1731650000, "owned_by": "vendor-a"},
				},
			})
		},
	})
	app, out, errOut, _ := newTestApp(t)

	code := runCLI(app, "--url", mock.URL, "--token", "root-token", "test", "models", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "gpt-4o-mini") {
		t.Fatalf("stdout 缺少模型名：%s", out.String())
	}
	req := mock.rec.last()
	if req.Path != llmModelsPath {
		t.Fatalf("请求路径 = %q，期望 %q", req.Path, llmModelsPath)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer root-token" {
		t.Fatalf("Authorization = %q", got)
	}
	if !strings.Contains(errOut.String(), "连通性：成功") {
		t.Fatalf("stderr 缺少连通性结论：%s", errOut.String())
	}
}

// TestTestChatBody 校验三种协议的最小请求体形状（字段名必须与后端一致）。
func TestTestChatBody(t *testing.T) {
	cases := []struct {
		name string
		args []string
		path string
		want []string
	}{
		{"chat", []string{"test", "chat", "--model", "m1", "--prompt", "hi"}, llmChatPath, []string{`"model":"m1"`, `"role":"user"`, `"content":"hi"`, `"stream":false`}},
		{"messages", []string{"test", "messages", "--model", "m1", "--prompt", "hi"}, llmMessagesPath, []string{`"model":"m1"`, `"max_tokens":1024`, `"content":"hi"`}},
		{"responses", []string{"test", "responses", "--model", "m1", "--prompt", "hi"}, llmResponsesPath, []string{`"model":"m1"`, `"input":"hi"`, `"stream":false`}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mock := newMockGateway(t, map[string]http.HandlerFunc{
				tc.path: func(w http.ResponseWriter, r *http.Request) {
					writeJSON(w, http.StatusOK, map[string]any{"id": "resp-1", "ok": true})
				},
			})
			app, _, errOut, _ := newTestApp(t)
			code := runCLI(app, append([]string{"--url", mock.URL, "--token", "t"}, tc.args...)...)
			if code != 0 {
				t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
			}
			body := string(mock.rec.last().Body)
			for _, want := range tc.want {
				if !strings.Contains(body, want) {
					t.Fatalf("请求体 %s 缺少 %s", body, want)
				}
			}
			if got := mock.rec.last().Path; got != tc.path {
				t.Fatalf("路径 = %q，期望 %q", got, tc.path)
			}
		})
	}
}

// TestTestStreamThreeProtocols 三协议流式：文本拼接正确、结束标记被识别。
func TestTestStreamThreeProtocols(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		path    string
		fixture string
	}{
		{"chat", []string{"test", "chat", "--model", "m1", "--stream"}, llmChatPath, "openai-chat.sse"},
		{"messages", []string{"test", "messages", "--model", "m1", "--stream"}, llmMessagesPath, "anthropic-messages.sse"},
		{"responses", []string{"test", "responses", "--model", "m1", "--stream"}, llmResponsesPath, "responses.sse"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("..", "internal", "stream", "testdata", tc.fixture))
			if err != nil {
				t.Fatalf("读取样本失败：%v", err)
			}
			mock := newMockGateway(t, map[string]http.HandlerFunc{
				tc.path: sseHandler([]string{string(raw)}, nil),
			})
			app, out, errOut, _ := newTestApp(t)
			code := runCLI(app, append([]string{"--url", mock.URL, "--token", "t"}, tc.args...)...)
			if code != 0 {
				t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
			}
			if got := strings.TrimSpace(out.String()); got != "Hello, world" {
				t.Fatalf("stdout = %q，期望 Hello, world", got)
			}
			if !strings.Contains(errOut.String(), "收到结束标记") {
				t.Fatalf("stderr 未识别结束标记：%s", errOut.String())
			}
			// 流式请求必须显式要求 SSE，否则服务端可能直接回 JSON
			if got := mock.rec.last().Header.Get("Accept"); !strings.Contains(got, "text/event-stream") {
				t.Fatalf("Accept = %q，期望包含 text/event-stream", got)
			}
			if !strings.Contains(string(mock.rec.last().Body), `"stream":true`) {
				t.Fatalf("请求体未带 stream=true：%s", string(mock.rec.last().Body))
			}
		})
	}
}

// TestStreamSegmentedArrival 是「实时性」证据：两帧之间隔 120ms，写出的时刻必须也分开。
// 若实现是「先 ReadAll 再解析」，两次写入会几乎同时发生，本用例会失败。
func TestStreamSegmentedArrival(t *testing.T) {
	frames := []string{
		"data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"-second\"}}]}\n\n",
		"data: [DONE]\n\n",
	}
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		llmChatPath: sseHandler(frames, []time.Duration{120 * time.Millisecond, 0, 0}),
	})

	var errBuf bytes.Buffer
	tw := &timedWriter{}
	home := t.TempDir()
	app := NewApp(tw, &errBuf, func(k string) string {
		if k == "HOME" || k == "USERPROFILE" {
			return home
		}
		return ""
	}, "test", "sha")

	code := runCLI(app, "--url", mock.URL, "--token", "t", "test", "chat", "--model", "m1", "--stream")
	if code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errBuf.String())
	}
	if got := strings.TrimSpace(tw.String()); got != "first-second" {
		t.Fatalf("stdout = %q", got)
	}
	tw.mu.Lock()
	writes := append([]writeRecord(nil), tw.writes...)
	tw.mu.Unlock()
	if len(writes) < 2 {
		t.Fatalf("只发生 %d 次写出，无法证明分段到达", len(writes))
	}
	gap := writes[len(writes)-1].At.Sub(writes[0].At)
	if gap < 80*time.Millisecond {
		t.Fatalf("两次写出间隔 %v，说明内容是一次性缓冲后写出的（不是实时流）", gap)
	}
}

// TestTestExitCodes 退出码口径：鉴权 3、服务端错 1、参数错 2（且不发请求）。
func TestTestExitCodes(t *testing.T) {
	unauthorized := newMockGateway(t, map[string]http.HandlerFunc{
		llmChatPath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid token (user not found)"})
		},
	})
	app, _, errOut, _ := newTestApp(t)
	if code := runCLI(app, "--url", unauthorized.URL, "--token", "t", "test", "chat", "--model", "m1"); code != 3 {
		t.Fatalf("401 退出码 = %d，期望 3（stderr=%s）", code, errOut.String())
	}

	serverErr := newMockGateway(t, map[string]http.HandlerFunc{
		llmChatPath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "upstream unavailable"})
		},
	})
	app2, _, errOut2, _ := newTestApp(t)
	if code := runCLI(app2, "--url", serverErr.URL, "--token", "t", "test", "chat", "--model", "m1"); code != 1 {
		t.Fatalf("502 退出码 = %d，期望 1（stderr=%s）", code, errOut2.String())
	}

	// 缺 --model：参数错误 2，且零请求
	quiet := newMockGateway(t, nil)
	app3, _, _, _ := newTestApp(t)
	if code := runCLI(app3, "--url", quiet.URL, "--token", "t", "test", "chat"); code != 2 {
		t.Fatalf("缺 --model 退出码 = %d，期望 2", code)
	}
	if got := len(quiet.rec.paths()); got != 0 {
		t.Fatalf("参数错误时不应发请求，实际发了 %d 个", got)
	}

	// --file 不是合法 JSON：参数错误 2，零请求
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	app4, _, _, _ := newTestApp(t)
	if code := runCLI(app4, "--url", quiet.URL, "--token", "t", "test", "chat", "--file", bad); code != 2 {
		t.Fatalf("非法 JSON 退出码 = %d，期望 2", code)
	}
	if got := len(quiet.rec.paths()); got != 0 {
		t.Fatalf("非法 JSON 时不应发请求，实际发了 %d 个", got)
	}
}

// TestTestStreamNonSSEFallback 服务端没按 SSER 回时必须有明确提示，不能假装流式成功。
func TestTestStreamNonSSEFallback(t *testing.T) {
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		llmChatPath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"id": "resp-1", "object": "chat.completion"})
		},
	})
	app, out, errOut, _ := newTestApp(t)
	code := runCLI(app, "--url", mock.URL, "--token", "t", "test", "chat", "--model", "m1", "--stream")
	if code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "resp-1") {
		t.Fatalf("整包响应未输出：%s", out.String())
	}
	if !strings.Contains(errOut.String(), "不是 text/event-stream") {
		t.Fatalf("未提示 Content-Type 不符：%s", errOut.String())
	}
}

// TestTestStreamJSONRecordsTimestamps --json --stream 的 NDJSON 必须带 t_ms，供外部做时间戳取证。
func TestTestStreamJSONRecordsTimestamps(t *testing.T) {
	frames := []string{
		"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n",
		"data: [DONE]\n\n",
	}
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		llmChatPath: sseHandler(frames, []time.Duration{60 * time.Millisecond, 0, 0}),
	})
	app, out, errOut, _ := newTestApp(t)
	code := runCLI(app, "--url", mock.URL, "--token", "t", "--json", "test", "chat", "--model", "m1", "--stream")
	if code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) < 4 {
		t.Fatalf("NDJSON 行数 = %d，期望 >= 4：%s", len(lines), out.String())
	}
	for _, line := range lines {
		if !strings.Contains(line, `"t_ms"`) {
			t.Fatalf("NDJSON 行缺少 t_ms：%s", line)
		}
	}
	if !strings.Contains(lines[len(lines)-1], `"chunks":2`) {
		t.Fatalf("汇总行缺少 chunks：%s", lines[len(lines)-1])
	}
}

// TestTestAPIKeyOverride --api-key 覆盖鉴权头，且不要求已登录。
func TestTestAPIKeyOverride(t *testing.T) {
	mock := newMockGateway(t, map[string]http.HandlerFunc{
		llmModelsPath: func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": []map[string]any{{"id": "m"}}})
		},
	})
	dir := t.TempDir()
	var out, errOut bytes.Buffer
	app := NewApp(&out, &errOut, func(k string) string {
		if k == "HOME" || k == "USERPROFILE" {
			return dir
		}
		return ""
	}, "test", "sha")
	app.SetTauriLoader(nil)
	code := runCLI(app, "--url", mock.URL, "test", "models", "--api-key", "sk-user-token")
	if code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
	}
	if got := mock.rec.last().Header.Get("Authorization"); got != "Bearer sk-user-token" {
		t.Fatalf("Authorization = %q", got)
	}
}
