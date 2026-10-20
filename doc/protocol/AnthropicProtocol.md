# Anthropic Messages API 协议文档

本文档描述 Anthropic Messages API 的请求 and 响应格式，特别是流式响应（SSE）的事件类型 Fluency。

---

## 1. 非流式请求格式

### 请求

```http
POST /llm/v1/messages
Content-Type: application/json
x-api-key: YOUR_API_KEY
anthropic-version: 2023-06-01

{
  "model": "glm-4.7",
  "max_tokens": 1024,
  "system": "You are a helpful assistant.",
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}
```

### 响应

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Hello! How can I help you?"
    }
  ],
  "model": "glm-4.7",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20
  }
}
```

### 请求内容块

`messages[].content` 可以是字符串，也可以是内容块数组。常用类型：

**图片**

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "..."
  }
}
```

```json
{
  "type": "image",
  "source": { "type": "url", "url": "https://example.com/cat.png" }
}
```

**工具调用（assistant）**

```json
{
  "type": "tool_use",
  "id": "toolu_123",
  "name": "get_weather",
  "input": { "location": "Tokyo" }
}
```

**工具结果（user）**

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_123",
  "content": "Sunny, 25°C"
}
```

`tool_result.content` 也可以是内容块数组，数组中的元素支持 `text` 和 `image`：

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_123",
  "content": [
    { "type": "text", "text": "截图如下" },
    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
  ]
}
```

---

## 2. 流式请求格式（SSE）

### 请求

若要启用 Extended Thinking（思考过程），需在请求中添加 `thinking` 配置：

```json
{
  "model": "glm-4.7",
  "max_tokens": 16000,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  },
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}
```

### 响应事件类型

流式响应使用 Server-Sent Events (SSE) 格式，包含以下事件类型：

#### 2.1 `message_start` - 消息开始

**Event Type**: `message_start`

**Data**:
```json
{
  "type": "message_start",
  "message": {
    "id": "msg_xxx",
    "type": "message",
    "role": "assistant",
    "content": [],
    "model": "glm-4.7",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 25,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  }
}
```

---

#### 2.2 `content_block_start` - 内容块开始

一个响应可能包含多个内容块，每个块有一个 `index`：

**Event Type**: `content_block_start`

**Data (thinking 块)**:
```json
{
  "type": "content_block_start",
  "index": 0,
  "content_block": {
    "type": "thinking",
    "thinking": ""
  }
}
```

**Data (text 块)**:
```json
{
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "text",
    "text": ""
  }
}
```

**注意**：
- `index=0` 通常是 thinking（思考过程）块
- `index=1` 通常是 text（实际回复）块

---

#### 2.3 `content_block_delta` - 内容增量

根据 `delta.type` 不同，处理逻辑如下：

**Event Type**: `content_block_delta`

**Data (thinking 增量)**:
```json
{
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "thinking_delta",
    "thinking": "Let me consider how to respond"
  }
}
```

**Data (signature 签名)**:
*注意：此事件主要出现在支持 Extended Thinking 的高级模型（如 Claude 3.7 Sonnet）中。部分模型（如 GLM-4.7）可能不返回此字段。*

在 `thinking` 内容结束后，`content_block_stop` 之前，可能会发送一个加密签名：
```json
{
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "signature_delta",
    "signature": "sig_xxx"
  }
}
```

**重要**：
- `thinking_delta`：用于实时展示或累积思考过程。
- `signature_delta`：**若出现则必须保存**。在涉及工具调用（Tool Use）的后续轮次中，必须将包含完整 `thinking` 和 `signature` 的消息传回 API。如果模型未返回签名，则仅传回思考文本内容即可。

---

#### 2.4 `content_block_stop` - 内容块结束

**Event Type**: `content_block_stop`

**Data**:
```json
{
  "type": "content_block_stop",
  "index": 0
}
```

---

#### 2.5 `message_delta` - 消息级别增量

**Event Type**: `message_delta`

**Data**:
```json
{
  "type": "message_delta",
  "delta": {
    "stop_reason": "end_turn",
    "stop_sequence": null
  },
  "usage": {
    "output_tokens": 209
  }
}
```

**注意**：
- 包含最终的 `stop_reason`
- 包含最终的 `usage.output_tokens`（含 thinking tokens）

---

#### 2.6 `message_stop` - 消息结束

**Event Type**: `message_stop`

**Data**:
```json
{
  "type": "message_stop"
}
```

---

## 3. 完整流式响应示例

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant","content":[],"model":"glm-4.7","stop_reason":null,"usage":{"input_tokens":6,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xxx"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"!"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
```

---

## 4. 累积响应逻辑

为了正确记录完整的响应，需要按照以下逻辑累积：

### 4.1 初始化

```
response = {
  id: "",
  model: "",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",      // 实际回复文本
      thinking: "",     // 思考过程
      signature: ""     // 思考块签名（必需）
    },
    finish_reason: null
  }],
  usage: {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  }
}
```

### 4.2 事件处理

| 事件类型 | 处理逻辑 |
|---------|---------|
| `message_start` | 保存 `id`, `model`, `role`, 初始 `usage` |
| `content_block_start` | 根据 `index` 和 `type` 初始化对应块 |
| `content_block_delta` | 根据 `delta.type` 处理：<br>- `thinking_delta` → `message.thinking += delta.thinking`<br>- `signature_delta` → `message.signature = delta.signature`<br>- `text_delta` → `message.content += delta.text` |
| `content_block_stop` | 标记对应块结束 |
| `message_delta` | 更新 `finish_reason` 和最终 `usage` |
| `message_stop` | 响应结束 |

---

## 5. Token 统计

- `input_tokens`：输入 token 数
- `output_tokens`：输出 token 数（包含 thinking tokens）
- `cache_read_input_tokens`：从缓存读取的输入 token
- `cache_creation_input_tokens`：写入缓存的输入 token

---

## 6. Stop Reasons

| 值 | 说明 |
|----|------|
| `end_turn` | 正常结束 |
| `max_tokens` | 达到 max_tokens 限制 |
| `stop_sequence` | 遇到停止序列 |
| `tool_use` | 需要使用工具 |

---

## 7. 与 OpenAI 格式对比

| 特性 | Anthropic | OpenAI |
|------|-----------|--------|
| 事件格式 | `event: xxx\ndata: {...}` | `data: {...}` |
| 多内容块 | 支持（thinking + text） | 支持（text + image_url 等内容块） |
| delta 类型区分 | `thinking_delta` / `signature_delta` / `text_delta` | 只有 `delta.content` |
| Token 字段名 | `input_tokens` / `output_tokens` | `prompt_tokens` / `completion_tokens` |
| 消息结构 | `content: [{type, text}]` | `content: string` 或内容块数组 |
