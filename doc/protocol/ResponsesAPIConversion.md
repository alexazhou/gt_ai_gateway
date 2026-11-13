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

> `function_call_output.output` 除了字符串，也可以是内容块数组（`input_text` / `input_image` / `input_file`）。转换时文本和图片会映射为 `tool_result` 的内容块；`input_file` 暂不支持，遇到时会明确返回 400。

### 2.3 请求转换映射表

| Responses API | Anthropic API | 方向 |
|---|---|---|
| `instructions` | `system` | Responses → Anthropic |
| `input[].type === "message", role === "user"` | `messages[].role = "user"` | Responses → Anthropic |
| `input[].type === "message", role === "assistant"` | `messages[].role = "assistant"` | Responses → Anthropic |
| `input[].type === "function_call"` | `messages[].role = "assistant", content = [tool_use]` | Responses → Anthropic |
| `input[].type === "function_call_output"` | `messages[].role = "user", content = [tool_result]` | Responses → Anthropic；`output` 为数组时按 text / image 块映射 |
| `input[].content[].type === "input_image"` | `messages[].content[].type = "image"` | Responses → Anthropic；data URL 拆成 base64 source，普通 URL 保留 |
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
| `content[].type = "tool_result"` | `input[].type = "function_call_output"` | Anthropic → Responses；`content` 为数组时按 input_text / input_image 映射 |
| `content[].type = "image"` | `input[].content[].type = "input_image"` | Anthropic → Responses；base64 source 组装成 data URL，url source 原样保留 |
| `content[].type = "thinking"` | `input[].type = "reasoning"` | Anthropic → Responses |
| `max_tokens` | `max_output_tokens` | Anthropic → Responses |
| `tool_choice: {type: "any"}` | `tool_choice: "required"` | Anthropic → Responses |
| `tool_choice: {type: "tool", name}` | `tool_choice: {type: "function", name}` | Anthropic → Responses |
| `thinking: {type: "enabled"}` | `reasoning: {effort: "high"}` | Anthropic → Responses |

### 2.4 多模态与工具结果

**图片消息**

- Responses → Anthropic：`input_image.image_url` 为 data URL 时拆成 `{type:"base64", media_type, data}`；普通 URL 转为 `{type:"url", url}`
- Anthropic → Responses：base64 source 组装成 `data:<media_type>;base64,<data>`；url source 原样作为 `input_image.image_url`
- `input_image.file_id` 无法由网关解析成图片内容，转换为其他协议时直接返回 400
- Anthropic `image` 块缺少有效 `source` / `data` / `url` 时，转换为 Responses 会直接返回 400

**工具结果**

- Anthropic `tool_result.content` 是字符串时，`function_call_output.output` 保持字符串
- `tool_result.content` 是数组时：
  - `text` → `input_text`
  - `image` → `input_image`（base64 source 组装成 data URL）
- Responses `function_call_output.output` 是数组时反向映射：
  - `input_text` / `output_text` → `text`
  - `input_image` → `image`
- `input_file` 暂不支持转换，遇到该内容块时明确返回 400（不会静默丢弃）

**Responses → OpenAI 方向**

OpenAI 的 `tool` 消息只支持文本，因此 `function_call_output.output` 数组中的文本会进入 tool 消息，图片会被收集到所有连续 tool 消息之后的一条 `user` 消息中。

**顺序说明**

普通消息内容按原始块顺序输出，`text → image → text` 的逐项顺序会被保留；工具结果中的图片受目标协议限制，仍会被拆分到后续位置（Responses → OpenAI 的 tool 消息只支持文本，Anthropic → OpenAI 的 tool 消息同样只支持文本）。

**连续 user 消息**

Responses 的 `function_call_output` 后紧跟普通 user 消息时，转换到 Anthropic 会合并到同一条 user 消息，不会产生连续 user turn。

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
src/util/protocol/                        # 各协议类型定义
├── commonTypes.ts                        # 协议无关类型（ReasoningEffort、ProtocolStreamEvent）
├── anthropicTypes.ts                     # Anthropic 请求 / 响应 / SSE 类型
├── openaiTypes.ts                        # OpenAI Chat Completions 类型
└── responsesTypes.ts                     # Responses API 类型

src/util/protocolUtil/                    # 协议工具模块

src/util/protocolConverter/
├── protocolConverterUtil.ts            # 转换器共享工具
├── BaseConverter.ts                    # 抽象基类
├── AnthropicToOpenAIConverter.ts       # Anthropic → OpenAI ChatCompletions
├── OpenAIToAnthropicConverter.ts       # OpenAI ChatCompletions → Anthropic
├── ResponsesToAnthropicConverter.ts    # Responses → Anthropic
├── AnthropicToResponsesConverter.ts    # Anthropic → Responses
├── OpenAIToResponsesConverter.ts       # OpenAI → Responses
├── ResponsesToOpenAIConverter.ts       # Responses → OpenAI
└── ConverterFactory.ts                 # 工厂类
```

### ConverterFactory 转换矩阵

| 客户端 ↓ / 上游 → | OPENAI | ANTHROPIC | RESPONSES |
|---|---|---|---|
| **OPENAI** | null | OpenAI→Anthropic | OpenAI→Responses |
| **ANTHROPIC** | Anthropic→OpenAI | null | Anthropic→Responses |
| **RESPONSES** | Responses→OpenAI | Responses→Anthropic | null |
