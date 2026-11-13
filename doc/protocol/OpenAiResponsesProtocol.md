# OpenAI Responses API 协议文档

本文档描述 OpenAI Responses API 的请求和响应格式，包括非流式和流式两种模式。

---

## 1. 非流式请求

### 请求

```http
POST /v1/responses
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{
  "model": "gpt-5.4",
  "input": "Say hello briefly."
}
```

### 常用请求参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型名称 |
| `input` | string \| array | 输入内容，字符串或消息数组 |
| `stream` | boolean | 是否启用流式输出，默认 false |
| `instructions` | string | 系统指令（相当于 system prompt） |
| `previous_response_id` | string | 上一轮响应 ID，用于多轮对话 |
| `reasoning` | object | 推理配置，如 `{"effort": "low"}` |
| `max_output_tokens` | integer | 最大输出 token 数 |
| `temperature` | number | 温度参数 |
| `tools` | array | 工具列表 |

### 响应

```json
{
  "id": "resp_09c3d284fe1506f70069eaf54bcb448195ac60e55c72eba519",
  "object": "response",
  "created_at": 1777005899,
  "model": "gpt-5.4",
  "status": "completed",
  "output": [
    {
      "id": "msg_09c3d284fe1506f70069eaf54c32ac8195a67f9c96b883a89d",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "Hello!",
          "annotations": []
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 10,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 6,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 16
  },
  "reasoning": {
    "effort": "none",
    "summary": null
  },
  "temperature": 1.0,
  "top_p": 0.98,
  "tool_choice": "auto",
  "tools": [],
  "incomplete_details": null,
  "error": null,
  "completed_at": 1777005900
}
```

### 输入数组与多模态内容

`input` 可以是字符串，也可以是 item 数组。常用 item 类型：

- `message`：`{ "type": "message", "role": "user", "content": [...] }`
- `function_call`：`{ "type": "function_call", "call_id": "...", "name": "...", "arguments": "..." }`
- `function_call_output`：`{ "type": "function_call_output", "call_id": "...", "output": ... }`
- `reasoning`：`{ "type": "reasoning", "summary": [...] }`

`message.content` 支持以下内容块：

- `input_text`：`{ "type": "input_text", "text": "..." }`
- `input_image`：`{ "type": "input_image", "image_url": "data:image/png;base64,..." }`
- `input_file`：`{ "type": "input_file", "file_id": "file-123" }` 或 `{ "type": "input_file", "file_data": "...", "filename": "..." }`

`input_image.image_url` 支持 data URL 或公网 URL，也可以用 `file_id` 引用已上传文件；`detail` 可选。

**多模态示例：**

```json
{
  "model": "gpt-5.4",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "描述这张图片" },
        { "type": "input_image", "image_url": "data:image/png;base64,..." }
      ]
    }
  ]
}
```

`function_call_output.output` 除了字符串，也可以是内容块数组（`input_text` / `input_image` / `input_file`），用于工具返回文本、图片或文件。

---

## 2. 流式请求（SSE）

### 请求

在请求中添加 `"stream": true`：

```json
{
  "model": "gpt-5.4",
  "input": "Say hello briefly.",
  "stream": true
}
```

### 响应格式

流式响应使用 SSE 协议，每行以 `data: ` 开头，后接 JSON。**注意：与 Chat Completions 不同，Responses API 的 SSE 没有独立的 `event:` 字段，事件类型通过 data JSON 中的 `type` 字段区分。**

#### 事件序列

**1. `response.created` — 响应创建，包含初始 response 对象**

```json
{
  "type": "response.created",
  "sequence_number": 0,
  "response": {
    "id": "resp_0bbd39cc...",
    "object": "response",
    "status": "in_progress",
    "output": [],
    "usage": null
  }
}
```

**2. `response.in_progress` — 响应处理中**

```json
{
  "type": "response.in_progress",
  "sequence_number": 1,
  "response": { "..." : "同上，status 为 in_progress" }
}
```

**3. `response.output_item.added` — 输出项（message）开始**

```json
{
  "type": "response.output_item.added",
  "sequence_number": 2,
  "output_index": 0,
  "item": {
    "id": "msg_0bbd39cc...",
    "type": "message",
    "role": "assistant",
    "status": "in_progress",
    "content": []
  }
}
```

**4. `response.content_part.added` — 内容块开始**

```json
{
  "type": "response.content_part.added",
  "sequence_number": 3,
  "output_index": 0,
  "content_index": 0,
  "part": {
    "type": "output_text",
    "text": "",
    "annotations": []
  }
}
```

**5. `response.output_text.delta` — 文本增量（主要数据帧）**

```json
{
  "type": "response.output_text.delta",
  "sequence_number": 4,
  "output_index": 0,
  "content_index": 0,
  "item_id": "msg_0bbd39cc...",
  "delta": "Hello"
}
```

**6. `response.output_text.done` — 文本输出完成**

```json
{
  "type": "response.output_text.done",
  "sequence_number": 6,
  "output_index": 0,
  "content_index": 0,
  "item_id": "msg_0bbd39cc...",
  "text": "Hello!"
}
```

**7. `response.content_part.done` — 内容块完成**

```json
{
  "type": "response.content_part.done",
  "sequence_number": 7,
  "output_index": 0,
  "content_index": 0,
  "item_id": "msg_0bbd39cc...",
  "part": {
    "type": "output_text",
    "text": "Hello!",
    "annotations": []
  }
}
```

**8. `response.output_item.done` — 输出项完成**

```json
{
  "type": "response.output_item.done",
  "sequence_number": 8,
  "output_index": 0,
  "item": {
    "id": "msg_0bbd39cc...",
    "type": "message",
    "role": "assistant",
    "status": "completed",
    "content": [{ "type": "output_text", "text": "Hello!", "annotations": [] }]
  }
}
```

**9. `response.completed` — 响应完成，包含完整 response 对象和 usage**

```json
{
  "type": "response.completed",
  "sequence_number": 9,
  "response": {
    "id": "resp_0bbd39cc...",
    "object": "response",
    "status": "completed",
    "output": [
      {
        "id": "msg_0bbd39cc...",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{ "type": "output_text", "text": "Hello!", "annotations": [] }]
      }
    ],
    "usage": {
      "input_tokens": 10,
      "input_tokens_details": { "cached_tokens": 0 },
      "output_tokens": 6,
      "output_tokens_details": { "reasoning_tokens": 0 },
      "total_tokens": 16
    },
    "completed_at": 1777005908
  }
}
```

---

## 3. 与 Chat Completions API 对比

| 特性 | Chat Completions | Responses API |
|------|-----------------|---------------|
| 端点 | `/v1/chat/completions` | `/v1/responses` |
| 输入字段 | `messages` | `input` |
| 系统提示 | `messages` 中 role=system | `instructions` 字段 |
| 输出字段 | `choices[].message` | `output[].content` |
| 多轮对话 | 客户端维护 messages 历史 | `previous_response_id` 引用上轮 |
| 流式文本增量 | `choices[].delta.content` | `response.output_text.delta` 事件的 `delta` 字段 |
| 流式结束标志 | `data: [DONE]` | `response.completed` 事件 |
| usage 字段名 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
| reasoning tokens | `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |

---

## 4. 网关使用方式

通过本网关调用 Responses API，将端点替换为网关地址即可：

```http
POST /llm/v1/responses
Authorization: Bearer YOUR_GATEWAY_TOKEN
Content-Type: application/json
```

请求体格式与 OpenAI 官方完全相同，网关负责鉴权、转发和计费记录。
