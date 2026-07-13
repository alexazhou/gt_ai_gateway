# LLM API 使用指南

本文档介绍如何调用 Serverless AI Gateway 提供的 LLM API。网关支持两种主流协议：OpenAI 兼容协议和 Anthropic 兼容协议。

---

## 身份验证

所有对 LLM API 的请求都必须包含身份验证信息。网关通过用户 Token 来识别用户身份。

### 1. OpenAI 兼容协议 (Bearer Token)
在 HTTP Header 中添加 `Authorization` 字段：
```http
Authorization: Bearer YOUR_USER_TOKEN
```

模型列表端点同时支持 Bearer Token 和 `x-api-key`：

```http
GET /llm/v1/models
Authorization: Bearer YOUR_USER_TOKEN
```

### 2. Anthropic 兼容协议 (x-api-key 或 Bearer Token)
支持两种方式：
- 使用 `x-api-key` (推荐):
  ```http
  x-api-key: YOUR_USER_TOKEN
  ```
- 使用 `Authorization`:
  ```http
  Authorization: Bearer YOUR_USER_TOKEN
  ```

---

## API 端点

### 1. OpenAI 兼容端点
- **路径**: `/llm/v1/chat/completions`
- **方法**: `POST`
- **说明**: 遵循 OpenAI Chat Completions 规范，适用于大多数第三方客户端。

### 2. Anthropic 兼容端点
- **路径**: `/llm/v1/messages`
- **方法**: `POST`
- **说明**: 遵循 Anthropic Messages API 规范。

---

## 模型选择

在请求体的 `model` 字段中，必须填入**在网关后台配置的模型名称**。网关会根据此名称匹配对应的供应商（Vendor）和上游配置。

例如，如果你在后台配置了一个名为 `my-gpt-4` 的模型并关联到了某个 OpenAI 供应商，那么在请求时应使用 `"model": "my-gpt-4"`。

---

## 流式响应 (Streaming)

网关完整支持 SSE (Server-Sent Events) 流式响应。

- 当请求体中的 `stream` 字段为 `true` 时，网关会透传上游的流式数据。
- 网关会自动注入 `stream_options: { "include_usage": true }` (针对 OpenAI 格式)，以确保在流结束时能够获取到完整的 Token 统计信息。
- 网关会实时累积流式输出，并在会话结束时自动记录完整响应到数据库。

---

## 使用示例

### 1. 调用 OpenAI 兼容接口 (cURL)

```bash
curl http://localhost:8787/llm/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token-here" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role": "user", "content": "你好，请自我介绍一下。"}
    ],
    "stream": true
  }'
```

### 2. 调用 Anthropic 兼容接口 (cURL)

```bash
curl http://localhost:8787/llm/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-token-here" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-opus",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude!"}
    ]
  }'
```

---

## 错误处理

当请求失败时，网关会返回标准的 HTTP 状态码和 JSON 格式的错误信息：

| 状态码 | 说明 |
|------|------|
| 401 | 身份验证失败（Token 缺失或无效） |
| 404 | 模型不存在或供应商未找到 |
| 500 | 上游服务错误或网关内部异常 |

示例错误响应：
```json
{
  "error": "model not found"
}
```

---

## 注意事项

1. **Header 过滤**: 网关在转发请求给上游时，会过滤掉 `Authorization`、`x-api-key` 等敏感 Header，并替换为供应商配置的真实 API Key。
2. **日志记录**: 所有请求（包括请求体、响应体、Token 消耗、首字延迟等）都会被记录在网关数据库中，管理员可在后台查看。
3. **超时**: 默认超时时间遵循后端运行环境配置（通常为 30 秒至几分钟，取决于具体部署环境）。
