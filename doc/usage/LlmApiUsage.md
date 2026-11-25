# LLM API 使用指南

本文档介绍如何调用 Serverless AI Gateway 提供的 LLM API。网关支持 OpenAI Chat Completions、OpenAI Responses API 和 Anthropic Messages 三种主流协议。

---

## 身份验证

所有对 LLM API 的请求都必须包含身份验证信息。网关通过用户 Token 来识别用户身份并校验账号状态（若账号被禁用将返回 `403`）。

所有 LLM 端点均支持以下两种认证方式：

### 1. Bearer Token

```http
Authorization: Bearer YOUR_USER_TOKEN
```

### 2. x-api-key

```http
x-api-key: YOUR_USER_TOKEN
```

如果请求同时包含两种认证 Header，网关优先使用 `Authorization`。

> **多租户视角切换（可选）**：当系统开启多租户隔离时，请求默认归属调用方用户所在的租户；系统管理员（Root 或 `main` 租户管理员）可通过请求头 `X-Tenant-ID: <tenant_id>` 显式指定目标租户视角。

---

## API 端点

### 1. 模型列表端点
- **路径**: `/llm/v1/models`
- **方法**: `GET`
- **说明**: 返回当前租户下可用（含 `main` 租户跨租户共享）的模型列表，遵循 OpenAI Models 列表格式。

### 2. OpenAI Chat Completions 兼容端点
- **路径**: `/llm/v1/chat/completions`
- **方法**: `POST`
- **说明**: 遵循 OpenAI Chat Completions 规范，适用于大多数第三方客户端。

### 3. Anthropic Messages 兼容端点
- **路径**: `/llm/v1/messages`
- **方法**: `POST`
- **说明**: 遵循 Anthropic Messages API 规范。

### 4. OpenAI Responses API 兼容端点
- **路径**: `/llm/v1/responses`
- **方法**: `POST`
- **说明**: 遵循 OpenAI Responses API 规范。

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

当请求失败时，网关会返回标准的 HTTP 状态码，并按照当前端点对应的协议格式（OpenAI / Anthropic / Responses）返回结构化 JSON 错误信息：

| 状态码 | 说明 |
|------|------|
| 400 | 请求参数错误（如缺少 `model` 字段、JSON 格式非法、多租户 Header 非法等） |
| 401 | 身份验证失败（Token 缺失或无效） |
| 403 | 权限不足（用户被禁用 `User disabled`、模型已停用 `model disabled`、命中访问控制规则或跨租户越权） |
| 404 | 模型不存在（`model not found`）或无可用上游供应商 |
| 413 | 请求体超过大小限制 |
| 429 | 命中限流规则（同时附带 `Retry-After` 响应头） |
| 500 | 上游服务错误或网关内部异常 |

OpenAI / Responses 协议错误响应示例：
```json
{
  "error": {
    "message": "model not found",
    "type": "invalid_request_error",
    "param": null,
    "code": "model_not_found"
  }
}
```

Anthropic 协议错误响应示例：
```json
{
  "type": "error",
  "error": {
    "type": "not_found_error",
    "message": "model not found"
  }
}
```

---

## 注意事项

1. **Header 过滤**: 网关在转发请求给上游时，会过滤掉 `Authorization`、`x-api-key` 等敏感 Header，并替换为供应商配置的真实 API Key。
2. **日志记录**: 所有请求（包括请求体、响应体、Token 消耗、首字延迟等）都会被记录在网关数据库中，管理员可在后台查看。
3. **超时**: 默认超时时间遵循后端运行环境配置（通常为 30 秒至几分钟，取决于具体部署环境）。
