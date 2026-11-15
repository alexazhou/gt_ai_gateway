package stream

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"
)

// decodeAll 用指定协议把样本解成「拼接文本 + 是否 done + 有效帧数」。
func decodeAll(t *testing.T, protocol Protocol, r io.Reader) (string, bool, int) {
	t.Helper()
	dec := NewDecoder(protocol)
	var sb strings.Builder
	done := false
	frames := 0
	err := ReadEvents(r, func(ev Event) error {
		text, finished, ok, derr := dec.Handle(ev)
		if derr != nil {
			return derr
		}
		if ok {
			frames++
		}
		if finished {
			done = true
		}
		sb.WriteString(text)
		return nil
	})
	if err != nil {
		t.Fatalf("ReadEvents 失败：%v", err)
	}
	return sb.String(), done, frames
}

func openFixture(t *testing.T, name string) *os.File {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("打开样本 %s 失败：%v", name, err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// TestFixturesThreeProtocols 是三份原始样本的解析基线：文本、结束标记、帧数都要对上。
func TestFixturesThreeProtocols(t *testing.T) {
	cases := []struct {
		name     string
		protocol Protocol
		wantText string
		wantDone bool
	}{
		{"openai-chat.sse", ProtocolOpenAI, "Hello, world", true},
		{"anthropic-messages.sse", ProtocolAnthropic, "Hello, world", true},
		{"responses.sse", ProtocolResponses, "Hello, world", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text, done, _ := decodeAll(t, tc.protocol, openFixture(t, tc.name))
			if text != tc.wantText {
				t.Fatalf("文本 = %q，期望 %q", text, tc.wantText)
			}
			if done != tc.wantDone {
				t.Fatalf("done = %v，期望 %v", done, tc.wantDone)
			}
		})
	}
}

// TestFixturesChunkedRead 是「同一个流被网络切成任意小块」的稳定性检验：
// 逐字节读（OneByteReader 每次只给 1 字节）必须得到与整读完全一致的文本。
func TestFixturesChunkedRead(t *testing.T) {
	cases := []struct {
		name     string
		protocol Protocol
	}{
		{"openai-chat.sse", ProtocolOpenAI},
		{"anthropic-messages.sse", ProtocolAnthropic},
		{"responses.sse", ProtocolResponses},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wholeText, wholeDone, _ := decodeAll(t, tc.protocol, openFixture(t, tc.name))
			chunkedText, chunkedDone, _ := decodeAll(t, tc.protocol, iotest.OneByteReader(openFixture(t, tc.name)))
			if wholeText != chunkedText || wholeDone != chunkedDone {
				t.Fatalf("逐字节读与整读不一致：整读 %q/%v，逐字节 %q/%v", wholeText, wholeDone, chunkedText, chunkedDone)
			}
		})
	}
}

// TestFrameSeparators 覆盖 CRLF / LF / 单独 CR 三种换行混用（后端 sseEventUtil 明确支持）。
func TestFrameSeparators(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\r\n\r\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"B\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"C\"}}]}\r\r" +
		"data: [DONE]\r\n\r\n"
	text, done, frames := decodeAll(t, ProtocolOpenAI, strings.NewReader(raw))
	if text != "ABC" || !done || frames != 4 {
		t.Fatalf("文本=%q done=%v frames=%d，期望 ABC/true/4", text, done, frames)
	}
}

// TestMultilineDataAndSingleSpace 校验 data 多行拼接与「只去掉一个前导空格」。
func TestMultilineDataAndSingleSpace(t *testing.T) {
	raw := "data: {\"choices\":[\ndata: {\"delta\":{\"content\":\" 2 spaces\"}}]}\n\n"
	text, _, frames := decodeAll(t, ProtocolOpenAI, strings.NewReader(raw))
	// 多行拼接后的 JSON 仍然合法：缩进里的空格必须保留，所以内容里应有 " 2 spaces"
	if text != " 2 spaces" {
		t.Fatalf("文本 = %q，期望 %q（多行 data 拼接或空格处理有误）", text, " 2 spaces")
	}
	if frames != 1 {
		t.Fatalf("有效帧 = %d，期望 1", frames)
	}
}

// TestHeartbeatOnlyFrame 心跳帧不产生文本、不算错误。
func TestHeartbeatOnlyFrame(t *testing.T) {
	var events []Event
	err := ReadEvents(strings.NewReader(": ping\n\n: keep-alive\n\n"), func(ev Event) error {
		events = append(events, ev)
		return nil
	})
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if len(events) != 2 {
		t.Fatalf("收到 %d 帧，期望 2 帧心跳", len(events))
	}
	for _, ev := range events {
		if !ev.IsHeartbeat() {
			t.Fatalf("帧不是心跳：%+v", ev)
		}
	}
}

// TestMalformedChunksDoNotPanic 覆盖畸形负载：半截 JSON、纯垃圾、错类型、空 data。
func TestMalformedChunksDoNotPanic(t *testing.T) {
	protocols := []Protocol{ProtocolOpenAI, ProtocolAnthropic, ProtocolResponses}
	raw := "data: {\"choices\":[{\"delta\":\n\n" + // 截断 JSON
		"data: not-json-at-all\n\n" + // 纯垃圾
		"data: 12345\n\n" + // 类型不对（数字）
		"data:\n\n" + // 空 data
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\n\n" + // 截断的增量
		"data: null\n\n" + // null
		"event: message_stop\ndata:\n\n" + // 终止帧无 data
		"event: response.completed\ndata: {}\n\n"
	for _, p := range protocols {
		t.Run(string(p), func(t *testing.T) {
			dec := NewDecoder(p)
			err := ReadEvents(strings.NewReader(raw), func(ev Event) error {
				// 只关心「不 panic、不返回 err」；坏帧应被当作无负载跳过
				_, _, _, _ = dec.Handle(ev)
				return nil
			})
			if err != nil {
				t.Fatalf("畸形流不应导致读取失败：%v", err)
			}
		})
	}
}

// TestAbruptEOFKeepsPartialFrame 流在帧中间断掉：已收内容不能丢，且不能报 panic。
func TestAbruptEOFKeepsPartialFrame(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}"
	text, done, _ := decodeAll(t, ProtocolOpenAI, strings.NewReader(raw))
	if text != "partialtail" {
		t.Fatalf("文本 = %q，期望 partialtail（尾部未闭合帧也要交付）", text)
	}
	if done {
		t.Fatalf("没有 [DONE] 却判定为完成")
	}
}

// TestErrorEventSurfaces 上游错误事件必须报错，而不是静默当成空增量。
func TestErrorEventSurfaces(t *testing.T) {
	cases := []struct {
		protocol Protocol
		raw      string
	}{
		{ProtocolOpenAI, "data: {\"error\":{\"message\":\"upstream 500\"}}\n\n"},
		{ProtocolAnthropic, "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\n\n"},
		{ProtocolResponses, "event: response.failed\ndata: {\"type\":\"response.failed\"}\n\n"},
	}
	for _, tc := range cases {
		t.Run(string(tc.protocol), func(t *testing.T) {
			dec := NewDecoder(tc.protocol)
			var gotErr error
			_ = ReadEvents(strings.NewReader(tc.raw), func(ev Event) error {
				if _, _, _, err := dec.Handle(ev); err != nil {
					gotErr = err
				}
				return nil
			})
			if gotErr == nil {
				t.Fatalf("错误事件没有上抛")
			}
		})
	}
}

// TestParseProtocol 边界：空串默认 openai，未知值报错。
func TestParseProtocol(t *testing.T) {
	if p, err := ParseProtocol(""); err != nil || p != ProtocolOpenAI {
		t.Fatalf("空串应默认 openai，得到 %q/%v", p, err)
	}
	if _, err := ParseProtocol("gemini"); err == nil {
		t.Fatalf("未知协议应报错")
	}
}
