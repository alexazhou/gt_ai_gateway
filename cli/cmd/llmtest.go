package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/stream"
)

// 推理自测命令（step2 §test）。
//
// 与 P2 的资源命令不同，这里打的是**对外 LLM 接口**（/llm/v1/*），鉴权语义是
// 「用户 Token 或 root Token」而不是管理员接口的租户鉴权，所以：
//   - 默认用当前登录 Token，允许 --api-key 覆盖（用户常拿 sk- 开头的用户 Token 自测）；
//   - 超时用推理档（120s），SSE 场景由 --timeout 进一步放宽。
const (
	llmModelsPath    = "/llm/v1/models"
	llmChatPath      = "/llm/v1/chat/completions"
	llmMessagesPath  = "/llm/v1/messages"
	llmResponsesPath = "/llm/v1/responses"

	// defaultTestPrompt 让 `gtgw test chat --model x` 不带 --prompt 也能跑通：
	// 自测要的是「链路是否通」，默认提示词越短越省钱。
	defaultTestPrompt = "ping"
)

// testModelColumns 对应 modelController.listLlmModels 的返回项（OpenAI 风格 {object:"list",data:[]}）。
var testModelColumns = []string{"id", "owned_by", "created"}

func (a *App) newTestCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "test",
		Short: "连通性自测（models / chat / messages / responses，支持流式）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		a.newTestModelsCmd(),
		a.newTestInferenceCmd(llmInferenceSpec{
			use:      "chat",
			short:    "测 OpenAI 兼容接口（POST /llm/v1/chat/completions）",
			path:     llmChatPath,
			protocol: stream.ProtocolOpenAI,
		}),
		a.newTestInferenceCmd(llmInferenceSpec{
			use:      "messages",
			short:    "测 Anthropic 接口（POST /llm/v1/messages）",
			path:     llmMessagesPath,
			protocol: stream.ProtocolAnthropic,
		}),
		a.newTestInferenceCmd(llmInferenceSpec{
			use:      "responses",
			short:    "测 Responses 接口（POST /llm/v1/responses）",
			path:     llmResponsesPath,
			protocol: stream.ProtocolResponses,
		}),
	)
	return cmd
}

// newLLMClient 构造打 /llm/v1/* 的客户端。
//
// 不复用 NewClient：那条路径强制要求「已有 Token」，而 --api-key 场景下用户可能没登录
// （只想拿一把 sk- Token 试一下推理）。
func (a *App) newLLMClient(apiKey string, timeout time.Duration) (*client.Client, config.Resolved, error) {
	res, err := a.Settings()
	if err != nil {
		return nil, res, err
	}
	if res.BaseURL == "" {
		return nil, res, client.Usagef("没有可用的网关地址：请先 `gtgw login`，或传 --url / 设置 GTGW_URL")
	}
	token := strings.TrimSpace(apiKey)
	if token == "" {
		token = res.Token
	}
	if token == "" {
		return nil, res, client.Usagef("没有可用的 Token：请先 `gtgw login`，或传 --api-key / --token")
	}
	eff := timeout
	if a.flagTimeout > 0 {
		eff = a.flagTimeout
	}
	c, err := client.New(client.Options{BaseURL: res.BaseURL, Token: token, Tenant: res.Tenant, Timeout: eff})
	if err != nil {
		return nil, res, err
	}
	return c, res, nil
}

func (a *App) newTestModelsCmd() *cobra.Command {
	var apiKey string
	cmd := &cobra.Command{
		Use:   "models",
		Short: "拉取可用模型列表（GET /llm/v1/models）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, _, err := a.newLLMClient(apiKey, client.InferenceTimeout)
			if err != nil {
				return err
			}
			started := time.Now()
			resp, err := cl.Do(cmd.Context(), "GET", llmModelsPath, nil)
			if err != nil {
				return withNonIdempotentHint(err)
			}
			if err := a.outList(resp, testModelColumns); err != nil {
				return err
			}
			fmt.Fprintf(a.errOut, "连通性：成功（%s，耗时 %s）\n", llmModelsPath, time.Since(started).Round(time.Millisecond))
			return nil
		},
	}
	cmd.Flags().StringVar(&apiKey, "api-key", "", "本次请求使用的 Token（默认用当前登录 Token；填 sk- 开头的用户 Token 可直接测推理）")
	return cmd
}

// llmInferenceSpec 描述一种协议的自测命令差异。
type llmInferenceSpec struct {
	use      string
	short    string
	path     string
	protocol stream.Protocol
}

func (a *App) newTestInferenceCmd(spec llmInferenceSpec) *cobra.Command {
	var (
		model    string
		prompt   string
		file     string
		doStream bool
		apiKey   string
	)
	cmd := &cobra.Command{
		Use:   spec.use,
		Short: spec.short,
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			body, err := buildTestBody(spec.protocol, model, prompt, file, doStream, a.in)
			if err != nil {
				return err
			}
			timeout := client.InferenceTimeout
			cl, _, err := a.newLLMClient(apiKey, timeout)
			if err != nil {
				return err
			}
			if doStream {
				return a.runStreamingTest(cmd, cl, spec, body)
			}
			started := time.Now()
			resp, err := cl.Do(cmd.Context(), "POST", spec.path, body)
			if err != nil {
				return withNonIdempotentHint(err)
			}
			if err := a.outObject(resp); err != nil {
				return err
			}
			fmt.Fprintf(a.errOut, "连通性：成功（%s，耗时 %s）\n", spec.path, time.Since(started).Round(time.Millisecond))
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&model, "model", "", "模型名（必填，除非 --file 里已带 model）")
	f.StringVar(&prompt, "prompt", defaultTestPrompt, "提示词（默认 ping）")
	f.StringVarP(&file, "file", "f", "", "请求体 JSON 文件路径（- 从 stdin 读），给了就整体覆盖默认体")
	f.BoolVar(&doStream, "stream", false, "走流式（SSE）：增量文本边到边打到 stdout")
	f.StringVar(&apiKey, "api-key", "", "本次请求使用的 Token（默认用当前登录 Token）")
	return cmd
}

// buildTestBody 组装请求体。
//
// --file 给了就整体覆盖（便于用真实线上请求体复现问题）；否则按协议拼最小合法体：
//   - openai:    {model, messages:[{role:user,content}], stream}
//   - anthropic: {model, max_tokens, messages:[{role:user,content}], stream}（max_tokens 是 Anthropic 必填）
//   - responses: {model, input, stream}
func buildTestBody(protocol stream.Protocol, model, prompt, file string, doStream bool, stdin *os.File) (map[string]any, error) {
	if strings.TrimSpace(file) != "" {
		body, err := buildJSONBody(file, nil, stdin)
		if err != nil {
			return nil, err
		}
		if doStream {
			// 流式意图是命令行显式表达的，--file 只是换载荷，不应该反过来把 stream 抹掉
			body["stream"] = true
		}
		return body, nil
	}
	if strings.TrimSpace(model) == "" {
		return nil, client.Usagef("缺少 --model：请指定要测的模型名（或用 --file 传完整请求体）")
	}
	if strings.TrimSpace(prompt) == "" {
		return nil, client.Usagef("--prompt 不能为空")
	}

	messages := []map[string]any{{"role": "user", "content": prompt}}
	switch protocol {
	case stream.ProtocolOpenAI:
		return map[string]any{"model": model, "messages": messages, "stream": doStream}, nil
	case stream.ProtocolAnthropic:
		return map[string]any{"model": model, "max_tokens": 1024, "messages": messages, "stream": doStream}, nil
	case stream.ProtocolResponses:
		return map[string]any{"model": model, "input": prompt, "stream": doStream}, nil
	}
	return nil, client.Usagef("不支持的协议 %q", protocol)
}

// runStreamingTest 消费 SSE：增量文本立刻写 stdout，收尾把统计写 stderr。
//
// 为什么不用 ReadAll 再解析：那样「是否实时」就无从证明。
// 判据要求的分段到达证据，正是靠这里逐帧写出 + --json 模式下的 t_ms 相对时间戳。
func (a *App) runStreamingTest(cmd *cobra.Command, cl *client.Client, spec llmInferenceSpec, body map[string]any) error {
	started := time.Now()
	resp, err := cl.DoStream(cmd.Context(), "POST", spec.path, body)
	if err != nil {
		return withNonIdempotentHint(err)
	}
	defer resp.Close()

	ctype := resp.ContentType()
	if !strings.Contains(ctype, "text/event-stream") {
		// 服务端没按流式回：读全后按整包输出，但必须把这件事说出来，不能假装流式成功
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if readErr != nil {
			return &client.NetworkError{Op: "读取响应 " + spec.path, Err: readErr}
		}
		if werr := a.outObject(&client.Response{StatusCode: resp.StatusCode, Header: resp.Header, Body: raw}); werr != nil {
			return werr
		}
		fmt.Fprintf(a.errOut, "提示：服务端返回的 Content-Type 是 %q，不是 text/event-stream——本次没有得到流式响应（请确认网关是否透传了 stream=true）\n", ctype)
		return nil
	}

	decoder := stream.NewDecoder(spec.protocol)
	var (
		chunks int
		done   bool
		text   strings.Builder
	)
	p := a.Printer()
	readErr := stream.ReadEvents(resp.Body, func(ev stream.Event) error {
		delta, finished, ok, derr := decoder.Handle(ev)
		if derr != nil {
			return derr
		}
		elapsed := time.Since(started).Milliseconds()
		if a.flagJSON {
			rec := map[string]any{"t_ms": elapsed, "event": ev.Event, "data": ev.Data}
			raw, mErr := json.Marshal(rec)
			if mErr != nil {
				return mErr
			}
			if _, werr := fmt.Fprintf(a.out, "%s\n", raw); werr != nil {
				return werr
			}
		}
		if !ok {
			if finished {
				done = true
			}
			return nil
		}
		if finished {
			done = true
			return nil
		}
		if delta == "" {
			return nil
		}
		chunks++
		text.WriteString(delta)
		if a.flagJSON {
			return nil
		}
		_, werr := io.WriteString(a.out, delta)
		return werr
	})
	if readErr != nil {
		return readErr
	}
	if !a.flagJSON {
		io.WriteString(a.out, "\n")
	} else {
		summary := map[string]any{
			"t_ms":     time.Since(started).Milliseconds(),
			"done":     done,
			"chunks":   chunks,
			"text":     text.String(),
			"protocol": string(spec.protocol),
			"finish":   finishWord(done),
		}
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		fmt.Fprintf(a.out, "%s\n", raw)
	}
	if !done {
		// 流正常结束但没见到结束标记：多半是上游截断，明确告警但不吞掉已收到的内容
		fmt.Fprintf(a.errOut, "警告：流已结束但未收到 %s 的结束标记，内容可能不完整\n", spec.protocol)
	}
	if p.Quiet {
		return nil
	}
	fmt.Fprintf(a.errOut, "流式完成：%d 段增量，%s，耗时 %s\n", chunks, finishWord(done), time.Since(started).Round(time.Millisecond))
	return nil
}

func finishWord(done bool) string {
	if done {
		return "收到结束标记"
	}
	return "未收到结束标记"
}
