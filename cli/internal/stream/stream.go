// Package stream 解析网关的 SSE 流，并把三种协议的增量事件抽成纯文本。
//
// 设计要点（对齐后端 src/util/protocolUtil/sseEventUtil.ts 的语义）：
//   - 帧分隔符是空行，且 CRLF / LF / CR 可混用；
//   - 多行 `data:` 按规范用换行拼接；
//   - 只去掉 `data:` 后的一个前导空格，其余空白的语义保留；
//   - 只有注释行（`: ping`）的帧是心跳，不是错误也不是数据；
//   - **任何畸形 / 截断的 chunk 都不许 panic**：解析失败就跳过该帧，由调用方决定是否报错。
package stream

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Event 是一帧 SSE 事件。
type Event struct {
	// Event 是 `event:` 行的值（Anthropic / Responses 用它区分事件类型）。
	Event string
	// Data 是多行 `data:` 拼接后的载荷。
	Data string
	// ID 是 `id:` 行的值。
	ID string
	// Comment 是纯注释帧（心跳）的内容，Data 为空时有意义。
	Comment string
}

// IsHeartbeat 表示这是一帧心跳（只有注释，无数据）。
func (e Event) IsHeartbeat() bool { return e.Data == "" && e.Comment != "" }

// readLine 读一整行，行尾可以是 LF / CRLF / 单独的 CR。
//
// 为什么不用 bufio.ReadString('\n')：SSE 规范允许单独 CR 作为行结束符，而 ReadString 只认 LF，
// 遇到纯 CR 的服务端会把整个流当成一行。这里逐字节读，同时把跨越读边界的 CRLF 正确合并。
// 返回值 complete 为 false 表示「读到了不足一行的尾部」（EOF 前的残行）。
func readLine(br *bufio.Reader) (line string, complete bool, err error) {
	var sb strings.Builder
	for {
		b, readErr := br.ReadByte()
		if readErr != nil {
			if sb.Len() > 0 {
				return sb.String(), false, readErr
			}
			return "", false, readErr
		}
		switch b {
		case '\n':
			return sb.String(), true, nil
		case '\r':
			// CRLF：下一个字节是 LF 就一并吃掉（Peek 在缓冲区边界也会补读）
			if next, peekErr := br.Peek(1); peekErr == nil && next[0] == '\n' {
				_, _ = br.Discard(1)
			}
			return sb.String(), true, nil
		default:
			sb.WriteByte(b)
		}
	}
}

// ReadEvents 逐帧读取 SSE，每读到一帧就回调 fn。
// fn 返回错误会中止读取并把该错误原样返回（用于「客户端的写失败」这类需要上抛的情况）。
func ReadEvents(r io.Reader, fn func(Event) error) error {
	if r == nil {
		return errors.New("stream: reader 为空")
	}
	br := bufio.NewReader(r)

	var data []string
	var event, id string
	var comments []string

	dispatch := func() error {
		// 只有空白（比如连续多个空行）不算一帧；但只要有 event/data/id/注释就交付，
		// 否则「event: message_stop + 空 data」这类终止帧会被吃掉。
		if len(data) == 0 && len(comments) == 0 && event == "" && id == "" {
			return nil
		}
		ev := Event{Event: event, Data: strings.Join(data, "\n"), ID: id, Comment: strings.Join(comments, "\n")}
		data, event, id, comments = nil, "", "", nil
		return fn(ev)
	}

	for {
		line, complete, err := readLine(br)
		// EOF 前的残行也当作一整行收下：SSE 服务器经常在最后一帧后直接断连，
		// 丢掉这行就等于丢掉尾部内容（实测有上游不发结尾空行）。
		if complete || (err != nil && errors.Is(err, io.EOF) && line != "") {
			switch {
			case line == "":
				// 空行 = 一帧结束
				if dispatchErr := dispatch(); dispatchErr != nil {
					return dispatchErr
				}
			case strings.HasPrefix(line, ":"):
				comments = append(comments, line)
			case strings.HasPrefix(line, "data:"):
				value := line[len("data:"):]
				if strings.HasPrefix(value, " ") {
					value = value[1:]
				}
				data = append(data, value)
			case strings.HasPrefix(line, "event:"):
				event = strings.TrimSpace(line[len("event:"):])
			case strings.HasPrefix(line, "id:"):
				id = strings.TrimSpace(line[len("id:"):])
			default:
				// 不认识的字段（retry: 等）忽略；也不算错误——SSE 规范允许扩展字段
			}
			continue
		}

		// 未完成的尾行
		if err != nil {
			if errors.Is(err, io.EOF) {
				// 流意外结束：把已缓冲的半帧交出去，让调用方自己判断是否完整
				return dispatch()
			}
			return fmt.Errorf("stream: 读取失败：%w", err)
		}
		return nil
	}
}

// Protocol 是三种对外协议。
type Protocol string

const (
	// ProtocolOpenAI 对应 POST /llm/v1/chat/completions。
	ProtocolOpenAI Protocol = "openai"
	// ProtocolAnthropic 对应 POST /llm/v1/messages。
	ProtocolAnthropic Protocol = "anthropic"
	// ProtocolResponses 对应 POST /llm/v1/responses。
	ProtocolResponses Protocol = "responses"
)

// ParseProtocol 把命令行里的协议名规范成 Protocol。
func ParseProtocol(raw string) (Protocol, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "openai":
		return ProtocolOpenAI, nil
	case "anthropic":
		return ProtocolAnthropic, nil
	case "responses":
		return ProtocolResponses, nil
	}
	return "", fmt.Errorf("未知协议 %q：可选 openai / anthropic / responses", raw)
}

// Decoder 把一帧事件翻译成「增量文本 / 是否结束 / 错误」。
//
// 三种协议的差异（事件名取自后端 accumulator 的判定口径）：
//   - OpenAI：只有 data（JSON），结束标记是 data 为 [DONE]；
//   - Anthropic：event: content_block_delta 的 data.delta.text 是增量，结束标记是 event: message_stop；
//   - Responses：event: response.output_text.delta 的 data.delta 是增量，结束标记是 response.completed。
type Decoder struct {
	protocol Protocol
}

// NewDecoder 构造解码器。
func NewDecoder(protocol Protocol) *Decoder { return &Decoder{protocol: protocol} }

// Handle 处理一帧，返回本次新增文本、是否收到结束标记、以及这是否是一帧有效负载。
//
// 畸形 JSON 不会 panic：返回 ok=false 且不报错——SSE 流里混进半截 JSON 是常态
// （上游截断、中间代理改写），一个坏帧不该让整次自测失败。
func (d *Decoder) Handle(ev Event) (text string, done bool, ok bool, err error) {
	if ev.IsHeartbeat() {
		return "", false, false, nil
	}
	data := strings.TrimSpace(ev.Data)

	// 所有协议都容忍 OpenAI 风格的 [DONE]：有些 Anthropic 兼容上游会在 message_stop 后追加它
	if data == "[DONE]" {
		return "", true, true, nil
	}

	switch d.protocol {
	case ProtocolOpenAI:
		if data == "" {
			return "", false, false, nil
		}
		var payload struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error any `json:"error"`
		}
		if err := jsonUnmarshal([]byte(data), &payload); err != nil {
			return "", false, false, nil
		}
		if payload.Error != nil {
			return "", false, true, fmt.Errorf("上游返回错误事件：%s", data)
		}
		if len(payload.Choices) == 0 {
			return "", false, false, nil
		}
		return payload.Choices[0].Delta.Content, false, true, nil

	case ProtocolAnthropic:
		var payload struct {
			Type  string `json:"type"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
		}
		if data != "" {
			_ = jsonUnmarshal([]byte(data), &payload)
		}
		eventName := ev.Event
		if eventName == "" {
			eventName = payload.Type
		}
		switch eventName {
		case "content_block_delta":
			return payload.Delta.Text, false, true, nil
		case "message_stop":
			return "", true, true, nil
		case "error":
			return "", false, true, fmt.Errorf("上游返回错误事件：%s", data)
		default:
			// message_start / message_delta / ping 等控制事件不产生文本
			return "", false, false, nil
		}

	case ProtocolResponses:
		var payload struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
		}
		if data != "" {
			_ = jsonUnmarshal([]byte(data), &payload)
		}
		eventName := ev.Event
		if eventName == "" {
			eventName = payload.Type
		}
		switch eventName {
		case "response.output_text.delta":
			return payload.Delta, false, true, nil
		case "response.completed":
			return "", true, true, nil
		case "response.failed", "error":
			return "", false, true, fmt.Errorf("上游返回错误事件：%s", data)
		default:
			return "", false, false, nil
		}
	}
	return "", false, false, fmt.Errorf("未知协议 %q", d.protocol)
}
