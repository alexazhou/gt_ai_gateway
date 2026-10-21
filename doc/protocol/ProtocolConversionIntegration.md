# 协议转换集成设计文档

> **历史设计稿**：本文记录初次引入协议转换时的集成方案，其中部分内容（如“Responses API 不参与转换”“图片只做占位处理”“仅支持 OpenAI ↔ Anthropic”“累积器按上游格式累积”）已被后续实现取代。当前转换行为请以 [MessageFormatConversion.md](./MessageFormatConversion.md)、[ResponsesAPIConversion.md](./ResponsesAPIConversion.md) 和 [ProtocolConversion.md](../usage/ProtocolConversion.md) 为准。

本文档描述将 `protocolConverter.ts` 集成到网关转发流程中的完整方案。在开发代码之前，需以此文档为准对齐实现逻辑。

---

## 1. 目标

将网关从**纯透传模式**升级为**支持协议转换模式**，使得：

- 客户端以 Anthropic 格式请求时，网关可以转发到 OpenAI 格式的上游（反之亦然）
- 上游响应自动转换回客户端格式返回
- 不需要协议转换的场景（客户端格式 = 上游格式）行为不变，完全兼容现有逻辑

---

## 2. 核心概念

### 2.1 新增术语

| 术语 | 定义 |
|------|------|
| **clientFormat** | 客户端请求使用的 API 格式，由路由入口决定（`OPENAI` / `ANTHROPIC`） |
| **upstreamFormat** | 上游服务使用的 API 格式，由 Vendor 配置决定（`OPENAI` / `ANTHROPIC`） |
| **需要转换** | `clientFormat !== upstreamFormat` |
| **透传模式** | `clientFormat === upstreamFormat`，行为与当前完全一致 |

### 2.2 当前 vs 新架构对比

```
当前架构（纯透传）：
Client (Anthropic) ──▶ Gateway ──▶ Upstream (Anthropic)
Client (OpenAI)     ──▶ Gateway ──▶ Upstream (OpenAI)

新架构（支持协议转换）：
Client (Anthropic) ──▶ Gateway ──转换──▶ Upstream (OpenAI)
Client (OpenAI)     ──▶ Gateway ──转换──▶ Upstream (Anthropic)
Client (OpenAI)     ──▶ Gateway ──透传──▶ Upstream (OpenAI)    ← 无变化
```

### 2.3 不在本次范围

- **Responses API 不参与转换**：Responses 格式与 OpenAI/Anthropic 结构差异大，不在本次双向转换范围内。`upstream_format` 为 `responses` 或 `clientFormat` 为 `responses` 时不做转换，透传处理。
- **Google 格式**：暂不涉及，预留 `ApiFormat.GOOGLE` 枚举位。

---

## 3. 数据模型变更

### 3.1 SgVendor 新增 `upstream_format` 字段

`vendor` 表新增 `upstream_format` 列：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `upstream_format` | `string` (nullable) | `null` | 上游 API 格式，取值为 `"openai"` / `"anthropic"`，`null` 表示与客户端格式一致（透传） |

**逻辑**：
- 如果 `upstream_format` 为 `null` 或空字符串 → `upstreamFormat = clientFormat`（透传）
- 如果 `upstream_format` 有值 → `upstreamFormat = ApiFormat.parse(upstream_format)`

### 3.2 Vendor URL 路由

当前 `SgVendor.getUrlByFormat(format)` 根据 format 返回对应 URL。集成后需要改为使用 `upstreamFormat` 获取上游 URL：

```typescript
// 当前
const url = vendor.getUrlByFormat(format);  // format = clientFormat

// 集成后
const url = vendor.getUrlByFormat(upstreamFormat);
```

---

## 4. 请求转换流程

### 4.1 流程图

```
客户端请求 (clientFormat)
       │
       ▼
  路由入口（chatCompletions / anthropicMessages）
       │
       ▼
  确定 upstreamFormat（从 vendor.upstream_format 读取）
       │
       ├── clientFormat === upstreamFormat ──▶ 透传，不做任何转换
       │
       └── clientFormat !== upstreamFormat ──▶ 转换请求体
              │
              ▼
         convertRequestBody(body, clientFormat, upstreamFormat)
              │
              ├── Anthropic → OpenAI: convertAnthropicRequestToOpenAI()
              └── OpenAI → Anthropic: convertOpenAIRequestToAnthropic()
              │
              ▼
         构建上游请求（headers 按 upstreamFormat 设置）
              │
              ▼
         发送到上游
```

### 4.2 请求转换逻辑

调用 `protocolConverter.ts` 中的已有函数：

| 转换方向 | 函数 | 输入 | 输出 |
|---------|------|------|------|
| Anthropic → OpenAI | `convertAnthropicRequestToOpenAI(anthropicReq)` | Anthropic 请求 JSON 对象 | OpenAI 请求 JSON 对象 |
| OpenAI → Anthropic | `convertOpenAIRequestToAnthropic(openaiReq)` | OpenAI 请求 JSON 对象 | Anthropic 请求 JSON 对象 |

### 4.3 鉴权 Header 变更

当前 `sendRequest` 中鉴权 header 按 `format` 参数设置。集成后需改为按 `upstreamFormat` 设置：

```typescript
if (upstreamFormat === ApiFormat.ANTHROPIC) {
    finalHeaders.set("x-api-key", vendor.token);
    finalHeaders.set("anthropic-version", "2023-06-01");
} else {
    finalHeaders.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
}
```

### 4.4 stream_options 注入变更

当前只在 `format === ApiFormat.OPENAI` 时注入 `stream_options`。集成后改为 `upstreamFormat === ApiFormat.OPENAI`：

```typescript
if (upstreamFormat === ApiFormat.OPENAI) {
    // 注入 stream_options: {include_usage: true}
}
```

### 4.5 不转换的字段

以下字段在请求转换中不处理，由上游忽略或透传：
- `model` — 模型名称保持原样，需要客户端请求时使用上游支持的模型名
- `metadata` / 自定义扩展字段 — 不在标准映射中，不转换

### 4.6 转换失败处理

如果请求体转换失败（如缺少必要字段），直接返回 400 错误给客户端，不转发请求：

```typescript
try {
    convertedBody = convertRequestBody(body, clientFormat, upstreamFormat);
} catch (e) {
    return c.json({ error: `Request format conversion failed: ${e.message}` }, 400);
}
```

---

## 5. 响应转换流程（非流式）

### 5.1 流程图

```
上游响应 (upstreamFormat)
       │
       ├── 非流式 ──▶ 读取完整响应体
       │                  │
       │                  ├── clientFormat === upstreamFormat ──▶ 直接返回
       │                  │
       │                  └── clientFormat !== upstreamFormat ──▶ 转换响应体
       │                                                       │
       │                                       Anthropic→OpenAI: convertAnthropicResponseToOpenAI()
       │                                       OpenAI→Anthropic: convertOpenAIResponseToAnthropic()
       │                                                       │
       │                                                       ▼
       │                                                  返回转换后的响应
       │
       └── 流式 ──▶ 见第 6 节
```

### 5.2 非流式响应转换逻辑

| 转换方向 | 函数 | 说明 |
|---------|------|------|
| Anthropic → OpenAI | `convertAnthropicResponseToOpenAI(anthropicRes)` | 将 `content[]` 转为 `choices[0].message`，映射 `stop_reason` → `finish_reason` |
| OpenAI → Anthropic | `convertOpenAIResponseToAnthropic(openaiRes)` | 将 `choices[0].message` 转为 `content[]`，映射 `finish_reason` → `stop_reason` |

### 5.3 Token 统计转换

非流式响应中的 token 统计也需按客户端格式提取：

| upstreamFormat → clientFormat | prompt 字段 | completion 字段 |
|-------------------------------|-------------|----------------|
| Anthropic → OpenAI | `input_tokens` → `prompt_tokens` | `output_tokens` → `completion_tokens` |
| OpenAI → Anthropic | `prompt_tokens` → `input_tokens` | `completion_tokens` → `output_tokens` |

### 5.4 Content-Type 和 HTTP 状态码

- **Content-Type**：始终设为 `application/json`
- **HTTP 状态码**：保持上游返回的状态码不变（即使转换失败也不修改状态码）
- 响应转换仅影响 body 内容，不影响 HTTP 状态码

---

## 6. 响应转换流程（流式）

### 6.1 核心方案

使用 `protocolConverter.ts` 中的流式转换器，逐事件转换后转发给客户端：

```
上游 SSE 事件 (upstreamFormat)
       │
       ▼
  SSE 事件解析（逐行解析 data/event/id）
       │
       ├── clientFormat === upstreamFormat ──▶ 直接 stream.writeSSE() 转发
       │
       └── clientFormat !== upstreamFormat ──▶ 流式转换器处理
              │
              │  Anthropic → OpenAI:
              │    AnthropicToOpenAIStreamConverter.convert(data, eventType)
              │    → 产出 0~N 个 OpenAI chunk 的 data 字符串
              │
              │  OpenAI → Anthropic:
              │    OpenAIToAnthropicStreamConverter.convert(data)
              │    → 产出 0~N 个 Anthropic 事件的 {data, event} 对象
              │
              ▼
         逐事件 stream.writeSSE() 转发给客户端
```

### 6.2 流式转换器类

```typescript
// Anthropic → OpenAI 流式转换
class AnthropicToOpenAIStreamConverter {
    private model: string;
    private id: string;
    private contentIndex: number;
    private currentBlockType: string | null;
    private currentToolUse: { id: string; name: string; inputJson: string } | null;
    
    /**
     * 输入：Anthropic SSE 事件的 data 和 event type
     * 输出：0~N 个 OpenAI chunk 的 JSON 字符串数组（不含 [DONE]）
     * 当 Anthropic 流结束时，额外产出 [DONE]
     */
    convert(data: string, eventType: string): string[];
}

// OpenAI → Anthropic 流式转换
class OpenAIToAnthropicStreamConverter {
    private model: string;
    private id: string;
    private blockIndex: number;     // 当前 content block 索引
    private contentBlockStarted: boolean;
    private currentBlockType: string | null;  // "text" | "thinking" | "tool_use"
    private toolCalls: Map<number, { id: string; name: string; arguments: string }>;
    
    /**
     * 输入：OpenAI SSE 事件的 data 字符串（可能为 [DONE]）
     * 输出：0~N 个 Anthropic SSE 事件的 {data: string, event: string} 对象数组
     */
    convert(data: string): Array<{data: string, event: string}>;
}
```

### 6.3 流式转换的关键事件映射

#### Anthropic → OpenAI

| Anthropic 事件 | 产出 OpenAI 事件 | 说明 |
|---------------|-----------------|------|
| `message_start` | 1 个 chunk: `{role: "assistant"}` | 初始化 model/id |
| `content_block_start` (text) | 1 个 chunk: `{content: ""}` | 开始文本块 |
| `content_block_start` (thinking) | 1 个 chunk: `{reasoning_content: ""}` | 开始思考块 |
| `content_block_start` (tool_use) | 1 个 chunk: `{tool_calls: [{...}]}` | 开始工具调用 |
| `content_block_delta` (text_delta) | 1 个 chunk: `{content: "..."}` | 文本增量 |
| `content_block_delta` (thinking_delta) | 1 个 chunk: `{reasoning_content: "..."}` | 思考增量 |
| `content_block_delta` (input_json_delta) | 1 个 chunk: `{tool_calls: [{function: {arguments: "..."}}]}` | 工具参数增量 |
| `content_block_stop` | 无产出（或 tool_use 关闭时产出空 chunk） | 块结束 |
| `message_delta` (stop_reason + usage) | 1 个 chunk: `{finish_reason: "stop"}` + usage | 流结束标记 |
| `message_stop` | `data: [DONE]` | 流结束 |

#### OpenAI → Anthropic

| OpenAI 事件 | 产出 Anthropic 事件 | 说明 |
|------------|-------------------|------|
| 首个 chunk (delta.role) | `message_start` | 初始化 |
| `delta.content` 首次出现 | `content_block_start` + `content_block_delta` | 开始文本块 |
| `delta.content` 后续 | `content_block_delta` (text_delta) | 文本增量 |
| `delta.reasoning_content` 首次 | `content_block_start` + `content_block_delta` | 开始思考块 |
| `delta.reasoning_content` 后续 | `content_block_delta` (thinking_delta) | 思考增量 |
| `delta.tool_calls` 首次 | `content_block_start` + `content_block_delta` | 开始工具调用 |
| `delta.tool_calls` 后续 | `content_block_delta` (input_json_delta) | 工具参数增量 |
| `finish_reason != null` | `content_block_stop` + `message_delta` | 块关闭 + 结束原因 |
| `data: [DONE]` | `message_stop` | 流结束 |

### 6.4 流式转换的 SSE 累积（Accumulator）

> **已过时（2026-10-21）**：当前 Accumulator 按**客户端协议**累积，跨格式时消费的是 `convertStreamEvent` 转换后的事件；本节“按上游格式累积”的表述仅反映当时设计，现状见 [MessageFormatConversion.md](./MessageFormatConversion.md) 第 5 / 10 节。

流式转换模式下，`SSEAccumulator` 仍然需要按**上游格式**累积，用于记录和计费：

```typescript
// 累积器始终按上游格式累积（保持现有逻辑不变）
const accumulator = new SSEAccumulator(upstreamFormat === ApiFormat.ANTHROPIC ? "anthropic" : "openai");
```

### 6.5 首个 Token 时间记录

需要在**转换后**的客户端格式事件中判断首个 token 时间：

| clientFormat | 判断条件 |
|-------------|---------|
| OpenAI | 第一个非 `[DONE]` 事件的 `choices[0].delta.content` 或 `choices[0].delta.reasoning_content` 有值 |
| Anthropic | `content_block_delta` 事件中 `delta.type === "text_delta"` 或 `delta.type === "thinking_delta"` |

简化处理：由于流式转换中首个有意义 token 的事件与上游格式对应保留，可以在解析上游 SSE 时保持当前逻辑（使用上游格式的事件来判断），因为时间差异可忽略。

### 6.6 流结束信号

| clientFormat | 流结束信号 |
|-------------|----------|
| OpenAI | `data: [DONE]` |
| Anthropic | `event: message_stop` |

转换器负责将上游的流结束信号转换为目标格式的流结束信号。

---

## 7. sendRequest 函数签名变更

### 7.1 当前签名

```typescript
async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    vendor: SgVendor,
    format: ApiFormat,
    body: string,
): Promise<Response>
```

### 7.2 新签名

```typescript
async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    vendor: SgVendor,
    clientFormat: ApiFormat,     // 重命名：客户端格式
    upstreamFormat: ApiFormat,   // 新增：上游格式
    body: string,
): Promise<Response>
```

### 7.3 gatewayController 变更

```typescript
// chatCompletions 入口
const clientFormat = ApiFormat.OPENAI;
const upstreamFormat = vendor.getUpstreamFormat() ?? clientFormat;
return sender.sendRequest(c, user, modelConfig, vendor, clientFormat, upstreamFormat, body);

// anthropicMessages 入口
const clientFormat = ApiFormat.ANTHROPIC;
const upstreamFormat = vendor.getUpstreamFormat() ?? clientFormat;
return sender.sendRequest(c, user, modelConfig, vendor, clientFormat, upstreamFormat, body);
```

---

## 8. sendRequest 内部逻辑变更

### 8.1 完整流程伪代码

```typescript
async function sendRequest(c, user, modelConfig, vendor, clientFormat, upstreamFormat, body) {
    // 1. 确定是否需要转换
    const needConvert = clientFormat !== upstreamFormat;
    
    // 2. 请求体转换（如果需要）
    let upstreamBody = body;
    if (needConvert) {
        try {
            upstreamBody = convertRequestBody(body, clientFormat, upstreamFormat);
        } catch (e) {
            return c.json({ error: `Request conversion failed: ${e.message}` }, 400);
        }
    }
    
    // 3. 创建记录（使用原始 body）
    const record = await recordService.create(user.id, modelConfig.id, body);
    
    // 4. 构建上游请求 headers（按 upstreamFormat 设置鉴权）
    // ... 现有逻辑，但 format 改为 upstreamFormat ...
    
    // 5. stream_options 注入（按 upstreamFormat 判断）
    if (upstreamFormat === ApiFormat.OPENAI) {
        // 注入 stream_options
    }
    
    // 6. 发起上游请求，URL 使用 upstreamFormat
    const url = vendor.getUrlByFormat(upstreamFormat);
    
    // 7. 处理响应（传入 clientFormat, upstreamFormat, needConvert）
    if (format === ApiFormat.RESPONSES) {
        // Responses API 不转换，透传处理（保持现有逻辑）
    } else if (isStream) {
        return handleStreamResponse(c, upstreamRes, record, modelConfig, user, clientFormat, upstreamFormat, needConvert);
    } else {
        return handleNonStreamResponse(c, upstreamRes, record, modelConfig, user, clientFormat, upstreamFormat, needConvert);
    }
}
```

### 8.2 convertRequestBody 辅助函数

```typescript
function convertRequestBody(body: string, clientFormat: ApiFormat, upstreamFormat: ApiFormat): string {
    const bodyJson = JSON.parse(body);
    let converted;
    
    if (clientFormat === ApiFormat.ANTHROPIC && upstreamFormat === ApiFormat.OPENAI) {
        converted = convertAnthropicRequestToOpenAI(bodyJson);
    } else if (clientFormat === ApiFormat.OPENAI && upstreamFormat === ApiFormat.ANTHROPIC) {
        converted = convertOpenAIRequestToAnthropic(bodyJson);
    } else {
        throw new Error(`Unsupported conversion: ${clientFormat} → ${upstreamFormat}`);
    }
    
    return JSON.stringify(converted);
}
```

---

## 9. handleStreamResponse 变更

### 9.1 变更概要

在原 `handleStreamResponse` 基础上增加流式转换逻辑。核心变化：

1. 新增参数 `clientFormat`, `upstreamFormat`, `needConvert`
2. 累积器仍按上游格式累积（不改变）
3. SSE 事件转发前，如果 `needConvert`，调用流式转换器转换后逐事件转发
4. 流结束信号按客户端格式发送

### 9.2 流式转换器初始化

```typescript
// 在 handleStreamResponse 内
let streamConverter: AnthropicToOpenAIStreamConverter | OpenAIToAnthropicStreamConverter | null = null;

if (needConvert) {
    if (upstreamFormat === ApiFormat.ANTHROPIC) {
        // Anthropic 上游 → OpenAI 客户端
        streamConverter = new AnthropicToOpenAIStreamConverter();
    } else {
        // OpenAI 上游 → Anthropic 客户端
        streamConverter = new OpenAIToAnthropicStreamConverter();
    }
}
```

### 9.3 事件转发逻辑

```typescript
// 在 SSE 事件循环中，现有 "转发给客户端" 位置修改：

if (needConvert && streamConverter) {
    // 转换模式：逐事件转换后转发
    if (upstreamFormat === ApiFormat.ANTHROPIC) {
        // Anthropic → OpenAI
        const chunks = (streamConverter as AnthropicToOpenAIStreamConverter).convert(data, eventType);
        for (const chunk of chunks) {
            await stream.writeSSE({ data: chunk });
        }
        // message_stop 事件 → 发送 [DONE]
        if (eventType === "message_stop") {
            await stream.writeSSE({ data: "[DONE]" });
        }
    } else {
        // OpenAI → Anthropic
        if (data === "[DONE]") {
            const events = (streamConverter as OpenAIToAnthropicStreamConverter).convert(data);
            for (const evt of events) {
                await stream.writeSSE({ data: evt.data, event: evt.event });
            }
        } else {
            const events = (streamConverter as OpenAIToAnthropicStreamConverter).convert(data);
            for (const evt of events) {
                await stream.writeSSE({ data: evt.data, event: evt.event });
            }
        }
    }
} else {
    // 透传模式：直接转发（现有逻辑）
    await stream.writeSSE({ data, event: eventType || undefined, id: id || undefined });
}
```

---

## 10. handleNonStreamResponse 变更

### 10.1 变更概要

1. 新增参数 `clientFormat`, `upstreamFormat`, `needConvert`
2. 先从上游响应体提取 token 统计（按上游格式提取）
3. 如果 `needConvert`，转换响应体后返回给客户端；否则直接返回

### 10.2 伪代码

```typescript
async function handleNonStreamResponse(c, upstreamRes, record, modelConfig, user, clientFormat, upstreamFormat, needConvert) {
    const responseText = await upstreamRes.text();
    const statusCode = upstreamRes.status as StatusCode;
    
    // 从上游响应中提取 token 统计（按上游格式的字段名）
    let promptTokens = null, outputTokens = null;
    try {
        const responseJson = JSON.parse(responseText);
        if (upstreamFormat === ApiFormat.ANTHROPIC) {
            promptTokens = responseJson.usage?.input_tokens ?? null;
            outputTokens = responseJson.usage?.output_tokens ?? null;
        } else {
            promptTokens = responseJson.usage?.prompt_tokens ?? null;
            outputTokens = responseJson.usage?.completion_tokens ?? null;
        }
    } catch (e) { /* ... */ }
    
    // 保存原始响应到数据库（始终保存上游格式的响应，用于调试）
    // ...
    
    // 转换响应体（如果需要）
    let clientResponseText = responseText;
    if (needConvert && statusCode >= 200 && statusCode < 300) {
        try {
            const responseJson = JSON.parse(responseText);
            let converted;
            if (upstreamFormat === ApiFormat.ANTHROPIC) {
                // 上游返回 Anthropic 格式，客户端需要 OpenAI 格式
                converted = convertAnthropicResponseToOpenAI(responseJson);
            } else {
                // 上游返回 OpenAI 格式，客户端需要 Anthropic 格式
                converted = convertOpenAIResponseToAnthropic(responseJson);
            }
            clientResponseText = JSON.stringify(converted);
        } catch (e) {
            console.error("[senderService] Response conversion failed, falling back to original:", e);
            // 转换失败时回退到返回原始响应
        }
    }
    
    c.status(statusCode);
    c.res.headers.set("Content-Type", "application/json");
    return c.text(clientResponseText);
}
```

---

## 11. 错误处理

### 11.1 请求转换失败

- 返回 HTTP 400，`{ "error": { "message": "Request format conversion failed: <reason>", "type": "invalid_request_error" } }`
- 格式按客户端格式返回（Anthropic 格式的错误 / OpenAI 格式的错误）

### 11.2 响应转换失败

- **非流式**：回退到返回原始上游响应，同时在日志中记录转换失败信息
- **流式**：如果流式转换中发生异常，尽量优雅断流——记录错误日志，向客户端发送一个错误事件后结束流
- 不影响计费（累积器仍按上游格式工作）

### 11.3 上游本身返回错误

- 不做转换，直接透传错误响应（保持行为与当前一致）
- 仅在上游响应状态码为 2xx 时才尝试响应体转换

---

## 12. 数据库记录策略

### 12.1 请求记录

- `record.request_data` 始终保存**客户端原始请求体**（转换前的）
- 这样可以在出问题时还原客户端视角

### 12.2 响应记录

- `record.response_data` 保存**累积器累积的完整响应**（上游格式）
- 累积器按上游格式工作，保持现有逻辑不变

### 12.3 Token 统计

- `record.prompt_tokens` / `record.output_tokens` 按上游格式的字段名提取
- 这些是计费依据，必须准确反映上游返回的值

---

## 13. 测试计划

### 13.1 单元测试

已由 `protocolConverter.test.ts` 覆盖 28 个用例，确保转换函数本身的正确性。

### 13.2 集成测试场景

| 场景 | clientFormat | upstreamFormat | 流式 | 预期 |
|------|-------------|---------------|------|------|
| 1. 透传 OpenAI | openai | openai | 否 | 与当前行为一致 |
| 2. 透传 Anthropic | anthropic | anthropic | 否 | 与当前行为一致 |
| 3. Anthropic→OpenAI 非流式 | anthropic | openai | 否 | 请求和响应都正确转换 |
| 4. OpenAI→Anthropic 非流式 | openai | anthropic | 否 | 请求和响应都正确转换 |
| 5. Anthropic→OpenAI 流式 | anthropic | openai | 是 | SSE 事件逐个转换，[DONE] 正确发送 |
| 6. OpenAI→Anthropic 流式 | openai | anthropic | 是 | SSE 事件逐个转换，message_stop 正确发送 |
| 7. 转换失败回退 | anthropic | openai | 否 | 格式错误的请求返回 400 |
| 8. 上游错误透传 | anthropic | openai | 否 | 上游返回 4xx/5xx 时直接透传 |

---

## 14. 实施步骤

| 步骤 | 内容 | 负责人 |
|------|------|--------|
| Step 1 | SgVendor 模型新增 `upstream_format` 字段 + 数据库 migration | 小程 |
| Step 2 | `sendRequest` 函数签名变更，增加 `clientFormat` / `upstreamFormat` 参数 | gateway_dev |
| Step 3 | `gatewayController` 三个入口读取 `upstream_format` 并传参 | 小程 |
| Step 4 | 请求体转换逻辑（convertRequestBody）集成到 `sendRequest` | 小程 |
| Step 5 | 非流式响应转换逻辑集成到 `handleNonStreamResponse` | 小程 |
| Step 6 | 流式响应转换逻辑集成到 `handleStreamResponse` | gateway_dev |
| Step 7 | 错误处理与回退逻辑 | 两人一起 |
| Step 8 | 集成测试 | gateway_test |

> **注意**：Step 2 由我来做（签名变更涉及整体框架），Step 6 流式转换逻辑较复杂也由我来。其余步骤小程来。

---

## 15. 已知限制与后续优化

1. **image 内容块转换不完整**：当前 Anthropic 的 `image` 块转 OpenAI 时只做了占位处理，完整 `image_url` 格式支持需后续补齐
2. **thinking 的 signature 字段**：非流式转换中已保留，流式 `signature_delta` 在 Anthropic→OpenAI 方向暂不映射（OpenAI 无对应字段）
3. **模型名称**：客户端需自行使用上游支持的模型名，网关不自动映射模型名
4. **Responses API 不参与转换**：若 `upstream_format` 或 `clientFormat` 为 `responses`，直接透传
5. **只支持 OpenAI ↔ Anthropic 双向转换**：Google 等其他格式暂不支持