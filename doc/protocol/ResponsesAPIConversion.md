# OpenAI Responses API ↔ Anthropic Messages API 协议转换文档

## 1. 概述

本文档描述 OpenAI Responses API 与 Anthropic Messages API 之间的双向协议转换逻辑。

Responses API 是 OpenAI 推出的新一代 API 格式，与传统的 Chat Completions API 不同：
- 使用 `input` 数组而非 `messages` 数组
- 支持 `function_call` / `function_call_output` 独立类型
- 支持 `reasoning`（推理/思考链）类型
- 流式事件使用 `response.output_text.delta`、`response.completed` 等类型标识
- 使用 `instructions` 字段传递系统提示词

---

## 2. 请求格式对比

### 2.1 系统提示词

| Responses API | Anthropic API |
|---|---|
| `instructions: "You are helpful"` | `system: "You are helpful"` |
| `input[].role === "system"` | `system: "..."` |

### 2.2 消息结构

**Responses API input 数组：**
```json
{
  "input": [
    { "type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello"}] },
    { "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hi!"}] },
    { "type": "function_call", "call_id": "call_1", "name": "search", "arguments": "{\"q\":\"test\"}" },
    { "type": "function_call_output", "call_id": "call_1", "output": "result" },
    { "type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking..."}] }
  ]
}
```

**Anthropic Messages messages 数组：**
```json
{
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi!" },
    { "role": "assistant", "content": [{"type": "tool_use", "id": "call_1", "name": "search", "input": {"q": "test"}}] },
    { "role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_1", "content": "result"}] },
    { "role": "assistant", "content": [{"type": "thinking", "thinking": "thinking...", "signature": "..."}] }
  ]
}
```

### 2.3 请求转换映射表

| Responses API | Anthropic API | 方向 |
|---|---|---|
| `instructions` | `system` | Responses → Anthropic |
| `input[].type === "message", role === "user"` | `messages[].role = "user"` | Responses → Anthropic |
| `input[].type === "message", role === "assistant"` | `messages[].role = "assistant"` | Responses → Anthropic |
| `input[].type === "function_call"` | `messages[].role = "assistant", content = [tool_use]` | Responses → Anthropic |
| `input[].type === "function_call_output"` | `messages[].role = "user", content = [tool_result]` | Responses → Anthropic |
| `input[].type === "reasoning"` | `messages[].role = "assistant", content = [thinking]` | Responses → Anthropic |
| `max_output_tokens` | `max_tokens` | Responses → Anthropic |
| `tools[].parameters` | `tools[].input_schema` | Responses → Anthropic |
| `tool_choice: "required"` | `tool_choice: {type: "any"}` | Responses → Anthropic |
| `tool_choice: {type: "function", name}` | `tool_choice: {type: "tool", name}` | Responses → Anthropic |
| `reasoning.effort: "high"` | `thinking: {type: "enabled", budget_tokens: 10000}` | Responses → Anthropic |
| `reasoning.effort: "none"` | `thinking: {type: "disabled"}` | Responses → Anthropic |
| `system` | `instructions` | Anthropic → Responses |
| `messages[].role = "user"` | `input[].type = "message", role = "user"` | Anthropic → Responses |
| `messages[].role = "assistant"` | `input[].type = "message", role = "assistant"` | Anthropic → Responses |
| `content[].type = "tool_use"` | `input[].type = "function_call"` | Anthropic → Responses |
| `content[].type = "tool_result"` | `input[].type = "function_call_output"` | Anthropic → Responses |
| `content[].type = "thinking"` | `input[].type = "reasoning"` | Anthropic → Responses |
| `max_tokens` | `max_output_tokens` | Anthropic → Responses |
| `tool_choice: {type: "any"}` | `tool_choice: "required"` | Anthropic → Responses |
| `tool_choice: {type: "tool", name}` | `tool_choice: {type: "function", name}` | Anthropic → Responses |
| `thinking: {type: "enabled"}` | `reasoning: {effort: "high"}` | Anthropic → Responses |

---

## 3. 非流式响应对比

### 3.1 Responses API 非流式响应
```json
{
  "id": "resp_abc123",
  "object": "response",
  "created_at": 1700000000,
  "status": "completed",
  "model": "gpt-4o",
  "output": [
    {
      "type": "message", "id": "msg_0",
      "role": "assistant", "status": "completed",
      "content": [{"type": "output_text", "text": "Hello!"}]
    },
    {
      "type": "function_call", "id": "fc_1",
      "call_id": "call_1", "name": "search", "arguments": "{\"q\":\"test\"}", "status": "completed"
    }
  ],
  "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}
}
```

### 3.2 Anthropic 非流式响应
```json
{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello!"},
    {"type": "tool_use", "id": "call_1", "name": "search", "input": {"q": "test"}}
  ],
  "model": "claude-sonnet-4-20250514",
  "stop_reason": "tool_use",
  "usage": {"input_tokens": 100, "output_tokens": 50}
}
```

### 3.3 非流式响应转换映射

| Responses API | Anthropic API |
|---|---|
| `output[].type === "message"` → `content[].output_text` | `content[].type = "text"` |
| `output[].type === "function_call"` | `content[].type = "tool_use"` |
| `output[].type === "reasoning"` → `summary[].text` | `content[].type = "thinking"` |
| `status: "completed"` | `stop_reason: "end_turn"` |
| `output` 中有 `function_call` | `stop_reason: "tool_use"` |
| `usage.input_tokens` | `usage.input_tokens` |
| `usage.output_tokens` | `usage.output_tokens` |
| `resp_` 前缀 | `msg_` 前缀 |

---

## 4. 流式响应对比

### 4.1 Responses API 流式事件序列

```
response.created
response.in_progress
response.output_item.added         (type: message)
response.content_part.added        (type: output_text)
response.output_text.delta         (增量文本)
response.output_text.done          (完整文本)
response.content_part.done
response.output_item.done          (message 完成)
response.output_item.added         (type: function_call)
response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done          (function_call 完成)
response.completed                 (包含完整 output 和 usage)
```

### 4.2 Anthropic 流式事件序列

```
message_start                     (包含 model, usage.input_tokens)
content_block_start               (type: text)
content_block_delta               (type: text_delta)
content_block_stop
content_block_start               (type: tool_use)
content_block_delta               (type: input_json_delta)
content_block_stop
message_delta                     (包含 stop_reason, usage.output_tokens)
message_stop
```

### 4.3 流式事件映射表

| Anthropic → Responses | Responses → Anthropic |
|---|---|
| `message_start` → `response.created` + `response.in_progress` | `response.created` → `message_start` |
| `content_block_start (text)` → `response.output_item.added` + `response.content_part.added` | `response.output_item.added (message)` → `content_block_start (text)` |
| `content_block_delta (text_delta)` → `response.output_text.delta` | `response.output_text.delta` → `content_block_delta (text_delta)` |
| `content_block_stop (text)` → `response.output_text.done` + `response.content_part.done` | `response.function_call_arguments.delta` → `content_block_delta (input_json_delta)` |
| `content_block_start (tool_use)` → `response.output_item.added (function_call)` | `response.function_call_arguments.done` → `content_block_stop` |
| `content_block_delta (input_json_delta)` → `response.function_call_arguments.delta` | `response.output_item.done (function_call)` → *(already handled)* |
| `content_block_stop (tool_use)` → `response.function_call_arguments.done` + `response.output_item.done` | `response.reasoning_summary_text.delta` → `content_block_delta (thinking_delta)` |
| `content_block_start (thinking)` → `response.output_item.added (reasoning)` + `response.reasoning_summary_part.added` | `response.output_item.done (reasoning)` → `content_block_stop` |
| `content_block_delta (thinking_delta)` → `response.reasoning_summary_text.delta` | `response.completed` → `message_delta` + `message_stop` |
| `message_delta` → *(usage 累积)* | |
| `message_stop` → 所有 `output_item.done` + `response.completed` | |

---

## 5. 特殊处理

### 5.1 Reasoning / Thinking

- **Responses → Anthropic**: `reasoning` input item 中的 `summary[].text` 转换为 `thinking` content block 的 `thinking` 字段，`encrypted_content` 映射到 `signature`
- **Anthropic → Responses**: `thinking` content block 转换为 `reasoning` output item

### 5.2 ID 前缀转换

- Responses 使用 `resp_` 前缀（如 `resp_abc123`）
- Anthropic 使用 `msg_` 前缀（如 `msg_abc123`）
- 转换时自动处理前缀映射

### 5.3 Tool Choice 映射

| Responses API | Anthropic API |
|---|---|
| `"auto"` | `{type: "auto"}` |
| `"required"` | `{type: "any"}` |
| `"none"` | *(不设置)* |
| `{type: "function", name: "x"}` | `{type: "tool", name: "x"}` |

### 5.4 流式状态管理

Responses API 的流式事件需要维护复杂的状态机来跟踪：
- 当前消息 ID（`currentMsgId`）
- 当前函数调用 ID（`currentFcId`）
- 文本缓冲区（`textBuf`）
- 函数参数缓冲区（`funcArgsBuf`）
- 推理状态（`reasoningActive`, `reasoningBuf`）
- 序列号（`seq`）

---

## 6. 代码结构

```
src/util/protocolConverter/
├── protocolTypes.ts                    # OpenAI / Anthropic 类型定义
├── responsesTypes.ts                   # Responses API 类型定义（新增）
├── BaseConverter.ts                    # 抽象基类
├── AnthropicToOpenAIConverter.ts       # Anthropic → OpenAI ChatCompletions
├── OpenAIToAnthropicConverter.ts       # OpenAI ChatCompletions → Anthropic
├── ResponsesToAnthropicConverter.ts    # Responses → Anthropic（新增）
├── AnthropicToResponsesConverter.ts    # Anthropic → Responses（新增）
├── ConverterFactory.ts                 # 工厂类（已更新支持 Responses）
└── ProtocolPairConverter.ts            # 请求/响应转换器对
```

### ConverterFactory 转换矩阵

| 客户端 ↓ / 上游 → | OPENAI | ANTHROPIC | RESPONSES |
|---|---|---|---|
| **OPENAI** | null | OpenAI→Anthropic | *(暂不支持)* |
| **ANTHROPIC** | Anthropic→OpenAI | null | Anthropic→Responses |
| **RESPONSES** | *(暂不支持)* | Responses→Anthropic | null |