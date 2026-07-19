# 协议转换功能说明

## 背景

网关同时支持多种客户端协议和多种上游协议。客户端请求的协议不一定和上游模型服务支持的协议一致，因此发送请求前需要按模型和供应商配置选择上游协议，并在必要时执行协议转换。

当前涉及的协议格式由 `ApiFormat` 定义：

| 格式 | 说明 |
|------|------|
| `openai` | OpenAI Chat Completions |
| `anthropic` | Anthropic Messages |
| `responses` | OpenAI Responses API |

协议转换发生在 `senderService` 中。网关先根据客户端协议和供应商支持的协议解析出上游协议；如果两者不同，就通过 `ConverterFactory.create(clientFormat, upstreamFormat)` 创建转换器。

## 转换器命名语义

转换器名称使用 `clientToServer` 语义，也就是类名描述的是请求方向：

```text
客户端协议 -> 上游协议
```

例如：

```text
OpenAIToAnthropicConverter
```

表示客户端使用 OpenAI Chat Completions，请求会被转换成 Anthropic Messages 后发给上游。

同一个转换器也负责返回方向的转换，但方法职责不同：

| 方法 | 方向 | 说明 |
|------|------|------|
| `convertRequest()` | 客户端协议 -> 上游协议 | 转换请求体 |
| `convertResponse()` | 上游协议 -> 客户端协议 | 转换非流式响应 |
| `convertStreamEvent()` | 上游 SSE event -> 客户端 SSE event | 转换流式响应事件 |

因此转换器不是两个单向转换器的组合，而是以一次网关请求为单位，封装该请求链路中“去程请求”和“回程响应”的协议适配逻辑。

## 支持矩阵

当前 `ConverterFactory` 支持以下跨协议转换：

| 客户端协议 | 上游协议 | 转换器 | 状态 |
|------------|----------|--------|------|
| `openai` | `anthropic` | `OpenAIToAnthropicConverter` | 已支持 |
| `anthropic` | `openai` | `AnthropicToOpenAIConverter` | 已支持 |
| `responses` | `anthropic` | `ResponsesToAnthropicConverter` | 已支持 |
| `anthropic` | `responses` | `AnthropicToResponsesConverter` | 已支持 |
| 相同协议 | 相同协议 | 无转换器 | 直接透传 |
| `responses` | `openai` | 无 | 暂不支持 |
| `openai` | `responses` | 无 | 暂不支持 |

如果客户端协议和上游协议不同，但工厂无法创建转换器，网关会返回不支持协议转换的错误。

## 请求转换流程

请求进入网关后，主要流程如下：

1. 根据客户端 endpoint 确定 `clientFormat`。
2. 根据模型和供应商配置解析 `upstreamFormat`。
3. 如果选中的上游配置了 `vendor_model_id`，先替换请求体中的模型名。
4. 先按客户端协议执行请求插件。
5. 如果 `clientFormat !== upstreamFormat`，创建转换器并执行 `convertRequestBody()`。
6. 转换后更新转换器中的请求模型名，用于流式响应补充模型字段。
7. 如果上游协议是 OpenAI 且请求是流式，注入 `stream_options.include_usage = true`。
8. 如果发生过协议转换，再按上游协议执行请求插件。
9. 将最终请求体发送到上游。

这意味着插件可能在两个阶段运行：

| 阶段 | 协议视角 | 用途 |
|------|----------|------|
| 转换前 | 客户端协议 | 处理客户端原始请求 |
| 转换后 | 上游协议 | 处理最终发给供应商的请求 |

## 非流式响应转换

非流式响应由 `handleNonStreamResponse()` 或 `handleResponsesNonStreamResponse()` 处理。

如果本次请求发生了协议转换，网关会对上游响应调用转换器的 `convertResponse()`，把响应转换回客户端请求的协议格式，再写入：

- HTTP 响应体
- 请求记录的 `response_data`
- 请求记录的 usage 和 cost

如果上游返回非 2xx 错误，网关不会尝试把错误强行转换成成功协议对象，而是记录上游响应内容并标记请求失败。

## 流式响应转换

流式响应以 SSE 为单位转换。`BaseConverter.convertStreamEvent()` 负责解析单条 SSE data，并委托具体转换器生成客户端协议事件。

基本流程：

```text
读取上游 chunk
  -> 切分 SSE event
  -> parseEvent()
  -> converter.convertStreamEvent()
  -> 写给下游客户端
  -> accumulator 累积客户端协议状态和完整响应
  -> 流结束后统一落库
```

流式转换有两个关键原则：

1. 转换器只负责协议事件转换，不负责落库和扣费。
2. accumulator 负责理解客户端协议语义，包括完成、错误、usage 和完整响应。

当前普通 OpenAI / Anthropic 流使用 `SSEAccumulator`；Responses 流使用 `ResponsesAccumulator`。

## Responses 流式累积

Responses API 的流式事件会被喂给 `ResponsesAccumulator`。它会处理以下事件：

| 事件 | 作用 |
|------|------|
| `response.created` / `response.in_progress` | 初始化响应元信息 |
| `response.output_item.added` | 初始化 output item |
| `response.content_part.added` | 初始化 content part |
| `response.output_text.delta` | 累积文本增量 |
| `response.output_text.done` | 用完整文本覆盖增量结果 |
| `response.output_item.done` | 用最终 output item 覆盖 |
| `response.completed` | 用完整 response 覆盖最终响应，并标记完成 |
| `event:error` / `type:error` / `response.failed` | 标记上游业务错误 |

Responses 流结束后，网关根据 accumulator 状态统一落库：

| 状态 | 落库结果 |
|------|----------|
| completed | `status=success`，保存完整 response、usage、cost |
| errored | `status=failed`，`failed_code=upstream_error`，保存错误 payload |
| 无完成也无错误 | `status=failed`，`failed_code=stream_incomplete` |

## 流式失败状态

流式请求最终只会进入一个终态。当前失败码包括：

| failed_code | 含义 |
|-------------|------|
| `client_disconnected` | 下游客户端断开，写入客户端失败 |
| `upstream_disconnected` | 上游连接异常，读取上游失败 |
| `upstream_error` | 上游返回协议层业务错误，例如 SSE `event:error` |
| `stream_incomplete` | 上游正常 EOF，但没有收到完成事件或错误事件 |

状态优先级为：

```text
client_disconnected > upstream_disconnected > upstream_error > success > stream_incomplete
```

例如 Responses 客户端转 Anthropic 上游时，如果上游返回：

```text
event: error
data: {"type":"error","error":{"type":"rate_limit_error","code":"1302","message":"rate limited"}}
```

网关会把本次请求记录为：

```text
status = failed
failed_code = upstream_error
response_data = 上游错误 payload
```

这类情况不是 `stream_incomplete`，因为上游已经明确返回了业务错误。

## Usage 和计费

usage 以客户端协议的最终响应为准：

| 客户端协议 | usage 来源 |
|------------|------------|
| OpenAI Chat | 最终累计的 OpenAI usage |
| Anthropic Messages | 最终累计的 Anthropic usage |
| Responses API | `ResponsesAccumulator.getUsage()`，也就是最终 response 的 `usage` |

转换器需要保证 usage 字段在协议间正确映射。例如 Anthropic 的缓存命中 token：

```json
{
  "cache_read_input_tokens": 18944
}
```

转换到 Responses 后应体现为：

```json
{
  "input_tokens_details": {
    "cached_tokens": 18944
  }
}
```

落库前再通过统一的 usage normalize 逻辑转换成记录表使用的 token 字段，并据此计算 cost。

## 相关测试

协议转换相关测试主要分布在：

| 路径 | 覆盖内容 |
|------|----------|
| `tests/unit/protocolConverter/` | 各转换器的请求、非流式响应、流式事件转换 |
| `tests/util/sseAccumulator.test.ts` | OpenAI / Anthropic 普通流累积 |
| `tests/util/responsesAccumulator.test.ts` | Responses 流累积、完成和错误状态 |
| `tests/util/sseEvent.test.ts` | SSE 事件解析、完成和错误识别 |
| `tests/api/ai/stream-failure.test.ts` | 流式异常终态落库 |
| `tests/api/ai/protocol-conversion.test.ts` | API 层协议转换路径 |

新增或修改协议转换逻辑时，至少需要覆盖对应转换器单元测试，并按影响面补充 API 层测试。
