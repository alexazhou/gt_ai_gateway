# OpenAI Chat Completions API 协议文档

本文档描述 OpenAI Chat Completions API 的请求和响应格式，特别是流式响应（SSE）的实现细节。

---

## 1. 非流式请求格式

### 请求

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{
  "model": "glm-4.7",
  "messages": [
    {
      "role": "user",
      "content": "Hello!"
    }
  ],
  "temperature": 0.7
}
```

### 响应

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "glm-4.7",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I assist you today?"
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

---

## 2. 流式请求格式（SSE）

### 请求

在请求中添加 `"stream": true`。若需要获取 Token 统计信息，需额外配置 `stream_options`。

```json
{
  "model": "glm-4.7",
  "messages": [
    {
      "role": "user",
      "content": "Hello!"
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

### 响应格式

流式响应使用 Server-Sent Events (SSE) 协议。每行以 `data: ` 开头，后接 JSON 字符串，最后以 `data: [DONE]` 结束。

#### 2.1 基础 Data 结构

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "created": 1677652288,
  "model": "glm-4.7",
  "choices": [
    {
      "index": 0,
      "delta": {
        "content": "Hello"
      },
      "finish_reason": null
    }
  ]
}
```

#### 2.2 `delta` 对象

与非流式的 `message` 不同，流式使用 `delta` 记录增量：
- **首个 Chunk**：通常包含 `role: "assistant"`，`content` 可能为空字符串，也可能不存在。
- **后续 Chunk**：包含增量的 `content` 文本。
- **工具调用**：包含 `tool_calls` 的增量片段（如 `arguments` 的 JSON 片段）。

#### 2.3 `finish_reason` 状态

- `null`：生成进行中。
- `stop`：自然结束。
- `length`：达到 `max_tokens` 限制。
- `tool_calls`：触发工具调用。
- `content_filter`：因安全策略被截断。

#### 2.4 Token 统计 (`usage`)

当启用 `include_usage: true` 时，在 `[DONE]` 之前通常会带上完整的 `usage` 字段。

常见实现有两种形式：
- 作为一个单独的 Chunk 发送，此时 `choices` 可能为空。
- 附着在最后一个 `finish_reason != null` 的 Chunk 上一并返回。

因此解析器不应把 `usage` 的位置写死，只要在结束前捕获到 `usage` 即可。

---

## 3. 完整流式响应示例

```text
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"glm-4.7","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"glm-4.7","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"glm-4.7","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"glm-4.7","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]
```

也可能出现下面这种等价形式，其中 `usage` 单独放在一个 Chunk 中：

```text
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"glm-4.7","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"glm-4.7","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]
```

---

## 4. 累积响应逻辑

为了记录完整对话，客户端通常需要执行以下操作：

1. **初始化**：创建一个空字符串用于拼接 `content`。
2. **拼接**：收到每个包含 `delta.content` 的 Chunk 时，将其内容追加到字符串末尾。
3. **继续读取**：即使已经收到 `finish_reason` 不为 `null` 的 Chunk，也应继续读取直到 `[DONE]`，因为 `usage` 可能仍在后续 Chunk 中，或者与结束 Chunk 合并返回。
4. **完成**：收到 `data: [DONE]` 后停止接收。
5. **统计**：保存结束前最后一次出现的 `usage` 数据。

---

## 5. 与 Anthropic 格式对比

| 特性 | OpenAI | Anthropic |
|------|-----------|--------|
| 事件前缀 | `data: ` | `event: xxx\ndata: ` |
| 结束标志 | `data: [DONE]` | `event: message_stop` |
| 增量字段 | `delta.content` | `delta.text` / `delta.thinking` |
| Token 统计 | 需 `stream_options` | 默认在 `message_start/delta` 中 |
| 思考过程 | 通常在 `content` 中或 `reasoning_content` (如 o1 模型) | 独立的 `thinking` 块 |
