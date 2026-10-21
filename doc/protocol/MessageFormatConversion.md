# OpenAI 与 Anthropic 消息格式双向转换逻辑

本文档整理了 OpenAI Chat Completions API 和 Anthropic Messages API 的消息格式差异，以及在网关中的对应转换逻辑。

---

## 1. 概述

网关当前支持三种 API 格式（`ApiFormat`）：

| 格式 | 枚举值 | 端点 | 说明 |
|------|--------|------|------|
| OpenAI Chat Completions | `openai` | `/llm/v1/chat/completions` | 标准 OpenAI 对话格式 |
| Anthropic Messages | `anthropic` | `/llm/v1/messages` | Anthropic 消息格式 |
| OpenAI Responses | `responses` | `/llm/v1/responses` | OpenAI 新一代 Responses API |

**重要说明**：客户端协议与上游协议一致时，网关**透传转发**；不一致时，由 `senderService` 通过 `ConverterFactory` 对请求体做协议转换后再转发。响应侧同理：同格式原样透传，跨格式时先转换为客户端协议再返回。流式响应的 Accumulator 消费的是**转换后的客户端协议事件**；非流式响应的 usage 仍按**上游格式**解析。

---

## 2. 请求格式对比

### 2.1 认证方式

| 格式 | 认证 Header | 格式 |
|------|-------------|------|
| OpenAI | `Authorization` | `Bearer <token>` |
| Anthropic | `x-api-key` | `<api-key>`（也支持 `Authorization: Bearer <token>` 兜底） |
| Responses | `Authorization` | `Bearer <token>` |

### 2.2 请求体结构对比

#### OpenAI Chat Completions 请求

```json
{
  "model": "gpt-4",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there!"},
    {"role": "user", "content": "How are you?"}
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

#### Anthropic Messages 请求

```json
{
  "model": "claude-3-sonnet",
  "system": "You are a helpful assistant.",
  "messages": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": [{"type": "text", "text": "Hi there!"}]},
    {"role": "user", "content": "How are you?"}
  ],
  "max_tokens": 1024,
  "stream": true,
  "thinking": {"type": "enabled", "budget_tokens": 10000}
}
```

#### 关键差异

| 特性 | OpenAI | Anthropic |
|------|--------|-----------|
| 系统提示 | `messages` 中 `role: system` | 独立 `system` 字段 |
| 消息 content | 字符串 `content: "text"` | 数组 `content: [{type: "text", text: "..."}]` |
| 思考过程 | 不支持（或 `reasoning_content` 字段） | `thinking` 配置，返回 thinking 块 |
| Token 上限 | `max_tokens` | `max_tokens`（必需） |
| 流式配置 | `stream: true` + `stream_options` | `stream: true` |
| 工具调用 | `tools` + `tool_choice` | `tools` + `tool_choice` |

---

## 3. 非流式响应格式对比

### OpenAI Chat Completions 响应

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I assist you?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 12,
    "total_tokens": 21
  }
}
```

### Anthropic Messages 响应

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "thinking", "thinking": "Let me think..."},
    {"type": "text", "text": "Hello! How can I help you?"}
  ],
  "model": "claude-3-sonnet",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20
  }
}
```

### 关键差异

| 特性 | OpenAI | Anthropic |
|------|--------|-----------|
| 顶层字段 | `choices[]` 数组 | 直接的 `content[]` 数组 |
| 消息结构 | `choices[0].message.content` 为字符串 | `content[]` 为内容块数组 |
| 内容类型 | 仅文本（或 `function_call` / `tool_calls`） | `text`、`thinking`、`tool_use` 等多种类型 |
| 结束原因 | `finish_reason`: stop/length/tool_calls | `stop_reason`: end_turn/max_tokens/tool_use |
| Token 字段 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |

---

## 4. 流式响应格式对比

这是网关核心的转换区域。两种格式的 SSE 流式事件完全不同。

### 4.1 事件格式对比

| 特性 | OpenAI | Anthropic |
|------|--------|-----------|
| SSE 格式 | `data: {json}\n\n` | `event: type\ndata: {json}\n\n` |
| 事件类型 | 无 event 行，通过 JSON 结构区分 | 有 `event:` 行 |
| 结束标志 | `data: [DONE]` | `event: message_stop` |
| 增量字段 | `choices[].delta.content` | `delta.text` / `delta.thinking` |

### 4.2 OpenAI 流式事件序列

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]
```

### 4.3 Anthropic 流式事件序列

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant","content":[],"model":"claude-3","stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xxx"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
```

---

## 5. 网关内部累积逻辑（Accumulator）

网关按客户端协议选择 Accumulator：OpenAI / Anthropic 流分别使用 `OpenAIChatAccumulator` / `AnthropicAccumulator`，统一累积为以下内部格式；Responses 流使用 `ResponsesAccumulator`（格式见第 6 节）。跨格式时，喂给 Accumulator 的是转换后的客户端协议事件。

### 5.1 统一累积格式（AccumulatedResponse）

```typescript
interface AccumulatedResponse {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices: Array<{
        index: number;
        message: {
            role?: string;
            content: string;           // 实际回复文本
            reasoning_content?: string; // OpenAI 推理内容
            thinking?: string;          // Anthropic 思考过程
            signature?: string;         // Anthropic 思考签名
            function_call?: {
                name?: string;
                arguments: string;
            };
            tool_calls?: Array<{
                id?: string;
                type?: string;
                function: {
                    name?: string;
                    arguments: string;
                };
            }>;
            tool_use?: Array<{          // Anthropic 工具调用
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
                input_json?: string;
            }>;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
}
```

### 5.2 OpenAI → 内部格式的映射

| OpenAI 字段 | 内部字段 | 映射逻辑 |
|-------------|---------|---------|
| `id` | `response.id` | 直接赋值 |
| `model` | `response.model` | 直接赋值 |
| `choices[].delta.role` | `choices[].message.role` | 直接赋值 |
| `choices[].delta.content` | `choices[].message.content` | 累积拼接 |
| `choices[].delta.reasoning_content` | `choices[].message.reasoning_content` | 累积拼接 |
| `choices[].delta.function_call` | `choices[].message.function_call` | 累积拼接（arguments） |
| `choices[].delta.tool_calls[]` | `choices[].message.tool_calls[]` | 按 index 累积 |
| `choices[].finish_reason` | `choices[].finish_reason` | 覆盖赋值 |
| `usage` | `response.usage` | 直接赋值（最后一个含 usage 的 chunk 覆盖） |

### 5.3 Anthropic → 内部格式的映射

| Anthropic 事件 | 内部字段 | 映射逻辑 |
|---------------|---------|---------|
| `message_start` → `message.id` | `response.id` | 直接赋值 |
| `message_start` → `message.model` | `response.model` | 直接赋值 |
| `message_start` → `message.role` | `choices[0].message.role` | 直接赋值 |
| `message_start` → `message.usage.input_tokens` | `usage.prompt_tokens` | 直接赋值 |
| `message_start` → `message.usage.output_tokens` | `usage.completion_tokens` | 直接赋值 |
| `content_block_start` (type=tool_use) | `choices[0].message.tool_use[]` | 按 index 初始化 |
| `content_block_delta` (type=text_delta) | `choices[0].message.content` | 累积拼接 |
| `content_block_delta` (type=thinking_delta) | `choices[0].message.thinking` | 累积拼接 |
| `content_block_delta` (type=signature_delta) | `choices[0].message.signature` | 覆盖赋值 |
| `content_block_delta` (type=input_json_delta) | `choices[0].message.tool_use[].input_json` | 累积拼接 |
| `message_delta` → `delta.stop_reason` | `choices[0].finish_reason` | 覆盖赋值 |
| `message_delta` → `usage.output_tokens` | `usage.completion_tokens` | 覆盖赋值 |

### 5.4 Stop Reason 映射

| OpenAI `finish_reason` | Anthropic `stop_reason` | 含义 |
|------------------------|------------------------|------|
| `stop` | `end_turn` | 正常结束 |
| `length` | `max_tokens` | 达到 Token 上限 |
| `tool_calls` | `tool_use` | 触发工具调用 |
| `content_filter` | — | 安全过滤 |

---

## 6. OpenAI Responses API 差异

Responses API 使用独立的 `ResponsesAccumulator`，其累积格式不同：

### 6.1 事件类型序列

```
response.created → response.in_progress → response.output_item.added → 
response.content_part.added → response.output_text.delta → response.output_text.done → 
response.content_part.done → response.output_item.done → response.completed
```

### 6.2 累积格式

```typescript
interface ResponsesAccumulatedResponse {
    id?: string;
    object?: string;
    created_at?: number;
    model?: string;
    status?: string;
    output: ResponsesOutputItem[];
    usage?: ResponsesUsage;
    completed_at?: number;
}
```

### 6.3 与 Chat Completions 的关键差异

| 特性 | Chat Completions | Responses API |
|------|-----------------|---------------|
| SSE 事件类型 | 无 event 字段，通过 JSON 结构区分 | `type` 字段在 JSON data 中 |
| 文本增量 | `choices[].delta.content` | `response.output_text.delta` 事件的 `delta` 字段 |
| 结束标志 | `data: [DONE]` | `response.completed` 事件 |
| 首个 token 时间 | 首个含 `delta.content` 的 chunk | `response.output_text.delta` 事件 |
| Usage 字段 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
| 输出结构 | `choices[].message` | `output[].content[]` |

---

## 7. 网关转发逻辑

### 7.1 请求转发

```
客户端请求 → 网关判断 ApiFormat → 转发到对应上游 URL
```

| ApiFormat | 上游 URL 后缀 | 认证 Header | 特殊处理 |
|-----------|-------------|------------|---------|
| `openai` | `/chat/completions` | `Authorization: Bearer <token>` | 流式请求注入 `stream_options: {include_usage: true}` |
| `anthropic` | `/v1/messages` | `x-api-key: <token>` + `anthropic-version: 2023-06-01` | 无 |
| `responses` | `/responses` | `Authorization: Bearer <token>` | 无 |

客户端格式与上游格式不一致时，`senderService` 会在转发前通过 `ConverterFactory` 转换请求体；上表描述的是转换后的上游请求。

### 7.2 响应处理

```
上游响应 → 判断是否流式
              ├── 是 ──▶ 选择客户端协议对应的 Accumulator ──▶ 累积响应
              └── 否 ──▶ 直接解析 JSON ──▶ 提取 usage
                              ↓
                        保存记录 + 计费
```

跨格式时，响应在返回客户端前还会经过 `convertResponse` / `convertStreamEvent` 转换为客户端协议。流式路径的 Accumulator 消费转换后的客户端协议事件；非流式 usage 仍从上游原始响应按 `upstreamFormat` 解析。

### 7.3 Token 统计字段映射

| 来源 | prompt_tokens | completion_tokens | total_tokens |
|------|--------------|-------------------|-------------|
| OpenAI 流式 | `usage.prompt_tokens` | `usage.completion_tokens` | `usage.total_tokens` |
| OpenAI 非流式 | `usage.prompt_tokens` | `usage.completion_tokens` | `usage.total_tokens` |
| Anthropic 流式 | `message_start.usage.input_tokens` | `message_delta.usage.output_tokens` | 计算值 |
| Anthropic 非流式 | `usage.input_tokens` | `usage.output_tokens` | 计算值 |
| Responses 流式 | `response.usage.input_tokens` | `response.usage.output_tokens` | `response.usage.total_tokens` |
| Responses 非流式 | `usage.input_tokens` | `usage.output_tokens` | `usage.total_tokens` |

---

## 8. 双向格式转换映射表

> 以下映射表描述了如果需要将一种协议转换为另一种协议时的字段对应关系。

### 8.1 请求转换：Anthropic → OpenAI

| Anthropic 字段 | OpenAI 字段 | 转换逻辑 |
|----------------|------------|---------|
| `system` (string) | `messages[0]` with `role: "system"` | 插入到 messages 数组最前面 |
| `messages[].content` (array，无图片) | `messages[].content` (string) | 多个 text 块按 `\n` 拼接为字符串 |
| `messages[].content[].type == "text"` | `messages[].content` | 提取 `.text` 字段 |
| `messages[].content[].type == "image"` | `messages[].content` (array) | 转为 `{type:"image_url", image_url:{url}}`；base64 source 先组装成 `data:<mime>;base64,<data>`，url source 原样透传 |
| `messages[role="assistant"].content[].type == "tool_use"` | `messages[].tool_calls` | 转为 `{id, type:"function", function:{name, arguments}}` |
| `messages[role="user"].content[].type == "tool_result"` | `messages[role="tool"]` | 字符串 content 直接转成 tool 消息；数组 content 只保留 text 块，图片拆分到后续 user 消息 |
| `max_tokens` | `max_tokens` | 直接传递 |
| `temperature` | `temperature` | 直接传递 |
| `top_p` | `top_p` | 直接传递 |
| `stream` | `stream` | 直接传递 |
| `tools[].name` | `tools[].function.name` | 嵌套到 function 对象 |
| `tools[].description` | `tools[].function.description` | 嵌套到 function 对象 |
| `tools[].input_schema` | `tools[].function.parameters` | 直接传递（JSON Schema 兼容） |
| `stop_sequences` | `stop` | 直接传递 |

#### tool_result 与普通用户文本的顺序

当 Anthropic 的同一条 `user` 消息中同时包含 `tool_result` 和普通 `text` 块时，转换到 OpenAI Chat Completions 格式后，必须先输出所有 `role="tool"` 消息，再输出普通 `role="user"` 文本消息。原因是 OpenAI 要求带 `tool_calls` 的 assistant 消息后面必须紧跟对应的 `tool` 消息；如果先输出普通用户文本，会变成 `assistant(tool_calls) -> user(text) -> tool(result)`，上游会以 `invalid_request_error` 拒绝请求。

示例：

```text
Anthropic:
assistant: [text, tool_use(call_1)]
user: [tool_result(call_1), text]

OpenAI:
assistant: content + tool_calls(call_1)
tool: tool_call_id=call_1
user: text
```

#### 多模态与工具结果图片

**Anthropic → OpenAI**

- 普通 `image` 内容块转为 `{type:"image_url", image_url:{url}}`：
  - `source.type == "base64"` → `data:<media_type>;base64,<data>`
  - `source.type == "url"` → 原 URL
- `tool_result.content` 是数组时：
  - tool 消息只保留 `text` 块（多个 text 按 `\n` 拼接）
  - 图片从工具结果中取出，在所有连续 tool 消息输出完后，合并到一条 `user` 消息里
  - 如果工具结果只有图片没有文本，tool 消息的 `content` 为空字符串
- 这样做的原因：OpenAI 的 `tool` 消息规范上只支持文本，图片只能通过 user 消息传入
- Anthropic `image` 块缺少有效 `source` / `data` / `url` 时，该图片会被跳过，不会报错

**OpenAI → Anthropic**

- `content` 数组中的 `image_url` 转为 Anthropic `image` 块：
  - `data:<mime>;base64,<data>` → `{type:"image", source:{type:"base64", media_type, data}}`
  - 普通 URL → `{type:"image", source:{type:"url", url}}`
- 纯文本 content 数组保持原样（两种协议的 text 块结构一致）
- 缺少 `image_url.url` 或 data URL 不是 base64 形式时，转换直接返回 400，不会把非法请求体发给上游
- OpenAI 的 `tool` 消息逐条转成 Anthropic user 消息；若 tool 结果后紧跟普通 user 内容，会形成连续 Anthropic user 消息，依赖上游自动合并连续同角色消息

### 8.2 请求转换：OpenAI → Anthropic

| OpenAI 字段 | Anthropic 字段 | 转换逻辑 |
|-------------|----------------|---------|
| `messages[role="system"]` | `system` (string) | 提取 content 作为 system 字段 |
| `messages[].content` (string) | `messages[].content` (string) | 原样保留 |
| `messages[].content` (array，纯文本) | `messages[].content` (array) | 原样保留（两种协议的 text 块结构一致） |
| `messages[].content[].type == "image_url"` | `messages[].content[].type == "image"` | data URL 拆成 `{type:"base64", media_type, data}`；普通 URL 转为 `{type:"url", url}` |
| `messages[].tool_calls` | `messages[].content` (array) | 每个转为 `{type: "tool_use", id, name, input}` |
| `messages[role="tool"]` | `messages[].content` (array) | 转为 `{type: "tool_result", tool_use_id, content}` |
| `max_tokens` | `max_tokens` | 直接传递（Anthropic 必需） |
| `temperature` | `temperature` | 直接传递 |
| `top_p` | `top_p` | 直接传递 |
| `stream` | `stream` | 直接传递 |
| `tools[].function` | `tools[]` | 提取 name/description/parameters 到顶层 |
| `stop` | `stop_sequences` | 直接传递 |

### 8.3 响应转换：Anthropic → OpenAI（非流式）

| Anthropic 响应 | OpenAI 响应 | 转换逻辑 |
|---------------|-----------|---------|
| `id` | `id` | 直接传递 |
| `model` | `model` | 直接传递 |
| `content[].type == "text"` | `choices[0].message.content` | 拼接所有 text 块 |
| `content[].type == "thinking"` | `choices[0].message.reasoning_content` | 拼接 thinking 内容 |
| `content[].type == "tool_use"` | `choices[0].message.tool_calls` | 转为 `{id, type:"function", function:{name, arguments}}` |
| `stop_reason == "end_turn"` | `finish_reason = "stop"` | 映射 |
| `stop_reason == "max_tokens"` | `finish_reason = "length"` | 映射 |
| `stop_reason == "tool_use"` | `finish_reason = "tool_calls"` | 映射 |
| `usage.input_tokens` | `usage.prompt_tokens` | 直接传递 |
| `usage.output_tokens` | `usage.completion_tokens` | 直接传递 |

### 8.4 响应转换：OpenAI → Anthropic（非流式）

| OpenAI 响应 | Anthropic 响应 | 转换逻辑 |
|------------|---------------|---------|
| `id` | `id` | 直接传递（或生成 `msg_` 前缀） |
| `model` | `model` | 直接传递 |
| `choices[0].message.content` | `content: [{type: "text", text: "..."}]` | 包装为数组 |
| `choices[0].message.reasoning_content` | `content: [{type: "thinking", thinking: "..."}]` | 插入到 content 数组前面 |
| `choices[0].message.tool_calls` | `content: [{type: "tool_use", id, name, input}]` | 转换工具调用 |
| `finish_reason == "stop"` | `stop_reason = "end_turn"` | 映射 |
| `finish_reason == "length"` | `stop_reason = "max_tokens"` | 映射 |
| `finish_reason == "tool_calls"` | `stop_reason = "tool_use"` | 映射 |
| `usage.prompt_tokens` | `usage.input_tokens` | 直接传递 |
| `usage.completion_tokens` | `usage.output_tokens` | 直接传递 |

---

## 9. 流式事件双向转换映射

### 9.1 Anthropic 流式 → OpenAI 流式

| Anthropic 事件 | OpenAI 对应 | 转换逻辑 |
|---------------|-----------|---------|
| `message_start` | 首个 chunk | `delta: {role: "assistant"}` + `usage.prompt_tokens` |
| `content_block_start` (type=text) | chunk | `delta: {content: ""}` |
| `content_block_start` (type=thinking) | chunk | `delta: {reasoning_content: ""}` |
| `content_block_start` (type=tool_use) | chunk | `delta: {tool_calls: [{id, type, function}]}` |
| `content_block_delta` (text_delta) | chunk | `delta: {content: delta.text}` |
| `content_block_delta` (thinking_delta) | chunk | `delta: {reasoning_content: delta.thinking}` |
| `content_block_delta` (input_json_delta) | chunk | `delta: {tool_calls: [{function: {arguments}}]}` |
| `content_block_stop` | 无对应 | 忽略 |
| `message_delta` (stop_reason) | 最终 chunk | `finish_reason` 映射 |
| `message_delta` (usage) | 最终 chunk | `usage` 字段注入 |
| `message_stop` | `data: [DONE]` | 流结束 |

### 9.2 OpenAI 流式 → Anthropic 流式

| OpenAI chunk | Anthropic 事件 | 转换逻辑 |
|-------------|---------------|---------|
| 首个 chunk (delta.role) | `message_start` | 生成 `message` 对象 |
| `delta.content` 首次出现 | `content_block_start` (type=text) | `{content_block: {type: "text", text: ""}}` |
| `delta.content` 后续 | `content_block_delta` (text_delta) | `{delta: {type: "text_delta", text: ...}}` |
| `delta.reasoning_content` 首次 | `content_block_start` (type=thinking) | `{content_block: {type: "thinking", thinking: ""}}` |
| `delta.reasoning_content` 后续 | `content_block_delta` (thinking_delta) | `{delta: {type: "thinking_delta", thinking: ...}}` |
| `delta.tool_calls` 首次 | `content_block_start` (type=tool_use) | `{content_block: {id, type: "tool_use", name, input: {}}}` |
| `delta.tool_calls` 后续 | `content_block_delta` (input_json_delta) | `{delta: {type: "input_json_delta", partial_json: ...}}` |
| `finish_reason != null` | `content_block_stop` + `message_delta` | `stop_reason` 映射 |
| `usage` 出现 | `message_delta` | usage 映射 |
| `data: [DONE]` | `message_stop` | 流结束 |

---

## 10. 当前网关的转换架构

```
Client (clientFormat)
        │
        ▼
   Gateway ── 同格式 ──▶ 请求体原样转发 ──▶ Upstream (upstreamFormat)
        │
        └── 跨格式 ──▶ ConverterFactory → convertRequestBody
        │
        ▼
Upstream Response
        │
        ├── 同格式 ──▶ 原样透传
        └── 跨格式 ──▶ convertResponse / convertStreamEvent
        │
        ▼
   Accumulator（消费客户端协议事件）──▶ 记录 + 计费
```

**关键点**：
1. **请求体**：客户端格式与上游格式一致时原样转发；不一致时由 `ConverterFactory` 创建转换器并调用 `convertRequestBody`
2. **响应**：同格式原样透传；跨格式时非流式调用 `convertResponse`，流式逐事件调用 `convertStreamEvent`
3. 流式响应的 Accumulator 按**客户端协议**消费事件（跨格式时已转换），用于请求记录和计费，不返回给客户端；非流式响应体按客户端协议落库，usage 按 `upstreamFormat` 解析
4. 转换方向覆盖 OpenAI / Anthropic / Responses 两两组合，共 6 个方向

> 注：历史设计稿 [ProtocolConversionIntegration.md](./ProtocolConversionIntegration.md) §6.4 仍保留“累积器按上游格式累积”的旧说法，仅反映当时设计，已被当前实现取代。
