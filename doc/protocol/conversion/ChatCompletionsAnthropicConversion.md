# OpenAI Chat Completions ↔ Anthropic Messages

本文描述网关当前实现中 OpenAI Chat Completions（`ApiFormat.OPENAI`，`openai`）与 Anthropic Messages（`ApiFormat.ANTHROPIC`，`anthropic`）的双向转换，包括请求体、非流式响应和流式事件。

协议自身的格式见 [Chat Completions 协议](../OpenAiProtocol.md)和 [Anthropic 协议](../AnthropicProtocol.md)。另外两组转换见 [Chat Completions ↔ Responses](./ChatCompletionsResponsesConversion.md)和 [Responses ↔ Anthropic](./ResponsesAnthropicConversion.md)。网关如何选择协议、转发和记录响应，见[自动协议转换](../../usage/ProtocolConversion.md)。

## 1. 转换方向与入口

文中的箭头表示当前请求或响应数据的转换方向。转换器类名按**请求方向**命名；同一个实例负责将上游响应按反方向转换回客户端协议。

| 客户端 → 上游 | 转换器 | `convertRequest` | `convertResponse` / `convertStreamEvent` |
|---|---|---|---|
| Chat Completions → Anthropic | `OpenAIToAnthropicConverter` | Chat Completions → Anthropic | Anthropic → Chat Completions |
| Anthropic → Chat Completions | `AnthropicToOpenAIConverter` | Anthropic → Chat Completions | Chat Completions → Anthropic |

客户端与上游协议相同时不创建转换器。下文仅描述跨协议转换；字段对应关系不代表所有协议能力都能无损往返。

## 2. 请求体双向转换

### 2.1 Chat Completions → Anthropic

| Chat Completions 请求字段 | Anthropic 请求字段 | 当前处理 |
|---|---|---|
| `model` / `stream` / `temperature` / `top_p` | 同名字段 | 保留 |
| `messages[role=system].content` | `system` | 提取文本；多条 system 消息用两个换行拼接 |
| `messages[role=user/assistant].content`（字符串） | `messages[].content` | 保留；连续 user 内容合并 |
| `content[]` 中的 `text` | `content[]` 中的 `text` | 保留文本块 |
| `content[]` 中的 `image_url` | `content[]` 中的 `image` | data URL 拆成 base64 source，普通 URL 转为 url source |
| assistant 的 `reasoning_content` | assistant 的 `thinking` 块 | 放在文本和工具调用前；无法生成 `signature` |
| assistant 的 `tool_calls[]` | assistant 的 `tool_use` 块 | `id` / `name` 保留，`function.arguments` 解析为 `input` |
| `messages[role=tool]` | user 的 `tool_result` 块 | `tool_call_id` → `tool_use_id`，提取结果文本 |
| `max_tokens` / `max_completion_tokens` | `max_tokens` | 依次取两者的非零值，都未提供时默认 `32768` |
| `stop` | `stop_sequences` | 字符串包装为数组；数组保留 |
| `tools[].function` | `tools[]` | `name` / `description` 提到顶层，`parameters` → `input_schema` |
| `reasoning_effort`（兼容 `reasoning.effort`） | `thinking` + `output_config` | 按第 2.4 节转换 |

连续的 tool 结果转换为同一条 Anthropic user 消息中的多个 `tool_result`；紧随其后的普通 user 内容也会合并进该消息。例如：

```text
Chat Completions:
assistant: tool_calls(call_1, call_2)
tool: tool_call_id=call_1, content="result 1"
tool: tool_call_id=call_2, content="result 2"
user: "继续"

Anthropic:
assistant: [tool_use(call_1), tool_use(call_2)]
user: [tool_result(call_1), tool_result(call_2), text("继续")]
```

### 2.2 Anthropic → Chat Completions

| Anthropic 请求字段 | Chat Completions 请求字段 | 当前处理 |
|---|---|---|
| `model` / `stream` / `temperature` / `top_p` | 同名字段 | 保留 |
| `system` | 首条 `messages[role=system]` | 字符串保留；文本块数组用两个换行拼接 |
| user / assistant 的字符串 `content` | `messages[].content` | 保留 |
| user 的纯文本块数组 | user 的字符串 `content` | 多个文本块用换行拼接 |
| user 的文本、图片混合数组 | user 的 `content[]` | 逐块转换，保留普通文本与图片的顺序 |
| `image.source` | `image_url.url` | base64 source 组装成 data URL，url source 保留 URL |
| assistant 的 `text` 块 | assistant 的 `content` | 用换行拼接；无文本时为 `null` |
| assistant 的 `thinking` 块 | assistant 的 `reasoning_content` | 用换行拼接；丢弃签名 |
| assistant 的 `tool_use` 块 | assistant 的 `tool_calls[]` | `input` JSON 序列化为 `function.arguments` |
| user 的 `tool_result` 块 | `messages[role=tool]` | `tool_use_id` → `tool_call_id`；图片另行处理，见下文 |
| `max_tokens` | `max_tokens` | 保留 |
| `stop_sequences` | `stop` | 保留 |
| `tools[]` | `tools[].function` | `input_schema` → `parameters` |
| `thinking` + `output_config` | `reasoning_effort` | 按第 2.4 节转换 |

**工具结果必须先于普通 user 内容。** 同一条 Anthropic user 消息包含 `tool_result` 和普通文本时，先输出所有 `role=tool` 消息，再输出普通 user 消息，保证它们紧跟对应的 assistant `tool_calls`。

Chat Completions 的 tool 结果在此转换实现中仅承载文本。`tool_result.content` 为数组时，文本用换行拼接进 tool 消息，图片放到这些 tool 消息之后的 user 消息中；若同时有普通 user 内容，图片追加在普通内容之后。只有图片的工具结果仍输出一条 `content: ""` 的 tool 消息。

```text
Anthropic:
assistant: [tool_use(call_1)]
user: [tool_result(call_1, [text("结果"), image]), text("继续")]

Chat Completions:
assistant: tool_calls(call_1)
tool: tool_call_id=call_1, content="结果"
user: [text("继续"), image_url]
```

### 2.3 工具选择

| Chat Completions `tool_choice` | Anthropic `tool_choice` | 转换说明 |
|---|---|---|
| `"auto"` | `{type: "auto"}` | 双向映射 |
| `"required"` | `{type: "any"}` | 双向映射 |
| `{type: "function", function: {name}}` | `{type: "tool", name}` | 双向映射 |
| `"none"` | 不设置 | Chat Completions → Anthropic 当前未生成显式禁用工具的配置 |

工具参数从字符串转换为对象时，合法 JSON 直接解析；解析失败时包装为 `{raw: 原字符串}`。这只是保留原始内容，不保证符合目标工具的 JSON Schema。

### 2.4 思考配置

当前共享实现为 [thinkingConfig.ts](../../../src/util/protocolConverter/thinkingConfig.ts)：

| 来源配置 | 目标配置 |
|---|---|
| Chat Completions `reasoning_effort: "none"` | Anthropic `thinking: {type: "disabled"}` |
| Chat Completions 的 `minimal` / `low` / `medium` / `high` / `xhigh` | Anthropic `thinking: {type: "adaptive"}` + `output_config: {effort: 原档位}` |
| Anthropic `thinking.type=disabled` | Chat Completions `reasoning_effort: "none"` |
| Anthropic `thinking.type=adaptive` | 使用 `output_config.effort`，未设置时为 `high` |
| Anthropic `thinking.type=enabled` | 将旧 `budget_tokens` 按阈值换算为 effort |

旧 budget 阈值为：`≤0 → none`、`≤1500 → minimal`、`≤4000 → low`、`≤7500 → medium`、`≤12000 → high`、`>12000 → xhigh`；enabled 未设置 budget 时取 `high`。

网关转换到 Anthropic 时已经输出 adaptive 配置。具体模型支持哪些 effort 档位、是否支持 adaptive，仍由上游模型决定。**思考配置的转换与历史 thinking 内容的转换是两件事**；开启思考不会补回缺失的签名。

## 3. 非流式响应双向转换

### 3.1 Anthropic → Chat Completions

由 `OpenAIToAnthropicConverter.convertResponse` 处理。

| Anthropic 响应字段 | Chat Completions 响应字段 | 当前处理 |
|---|---|---|
| `content[]` 中的 `text.text` | `choices[0].message.content` | 直接拼接所有 text；无文本时为 `null` |
| `content[]` 中的 `thinking.thinking` | `choices[0].message.reasoning_content` | 拼接 thinking 文本；不保留 `signature` |
| `content[]` 中的 `tool_use` | `choices[0].message.tool_calls[]` | 保留调用 ID / 名称，序列化 `input` |
| `stop_reason` | `choices[0].finish_reason` | 按第 3.3 节映射 |
| `usage.input_tokens` / `usage.output_tokens` | `usage.prompt_tokens` / `usage.completion_tokens` | 使用原字段值；两者相加生成 `total_tokens` |
| `id` / `model` | `id` / `model` | ID 改为 `chatcmpl-` 前缀，model 保留 |
| 无对应字段 | `object` / `created` | 生成 `chat.completion` 和当前时间戳 |

### 3.2 Chat Completions → Anthropic

由 `AnthropicToOpenAIConverter.convertResponse` 处理，仅取 `choices[0]`。

| Chat Completions 响应字段 | Anthropic 响应字段 | 当前处理 |
|---|---|---|
| `message.reasoning_content` | `content[]` 中的 `thinking` | 放在文本前；不带签名 |
| `message.content` | `content[]` 中的 `text` | 包装成文本块 |
| `message.tool_calls[]` | `content[]` 中的 `tool_use` | 解析工具参数为 `input` |
| `finish_reason` | `stop_reason` | 按第 3.3 节映射 |
| `usage.prompt_tokens` / `usage.completion_tokens` | `usage.input_tokens` / `usage.output_tokens` | 非流式路径直接使用原字段值 |
| `id` / `model` | `id` / `model` | ID 改为 `msg_` 前缀，model 保留 |

当没有文本、思考或工具调用时，生成一个空 text 块。非流式两个方向目前都没有完整映射缓存 token 明细，计费侧按上游原始 usage 解析，见[响应处理与记录](../../usage/ProtocolConversion.md#响应处理与记录)。

### 3.3 结束原因

| Chat Completions `finish_reason` | Anthropic `stop_reason` | 当前行为 |
|---|---|---|
| `stop` | `end_turn` | 双向映射 |
| `length` | `max_tokens` | 双向映射 |
| `tool_calls` | `tool_use` | 双向映射 |
| `stop` | `stop_sequence` | Anthropic → Chat Completions 归为 `stop`，反向不恢复具体 stop sequence |
| `content_filter` | `end_turn` | Chat Completions → Anthropic 丢失过滤原因 |

未识别的结束原因分别回退为 `stop` / `end_turn`。

## 4. 流式事件双向转换

Chat Completions 使用 `data: {json}` chunk，以 `data: [DONE]` 结束；Anthropic 使用 `event: 事件名` + `data: {json}`，以 `message_stop` 结束。转换器会补齐目标协议所需的开始、内容块和终止事件。

### 4.1 Anthropic → Chat Completions

由 `OpenAIToAnthropicConverter.convertStreamEvent` 处理。

| Anthropic 上游事件 | Chat Completions 客户端事件 / 处理 |
|---|---|
| `message_start` | 首个 chunk：`delta.role=assistant`；保存 ID、model 和输入 token 数 |
| `content_block_start (thinking)` | `delta.reasoning_content=""` |
| `content_block_start (tool_use)` | `delta.tool_calls[]`，初始化调用 index、ID 和名称 |
| `content_block_delta (text_delta)` | `delta.content` |
| `content_block_delta (thinking_delta)` | `delta.reasoning_content` |
| `content_block_delta (input_json_delta)` | `delta.tool_calls[].function.arguments`，按调用 index 输出参数增量 |
| `content_block_delta (signature_delta)` | 无对应通道，忽略 |
| `content_block_start (text)` / `content_block_stop` | 不生成对应事件 |
| `message_delta` | 输出结束 chunk，映射 `stop_reason`，附带输入 / 输出 token usage |
| `message_stop` | `data: [DONE]` |
| `error` 或带 `error` 的数据 | 返回 `event: error`，保留上游错误数据 |

### 4.2 Chat Completions → Anthropic

由 `AnthropicToOpenAIConverter.convertStreamEvent` 处理。

| Chat Completions 上游 chunk | Anthropic 客户端事件 / 处理 |
|---|---|
| 首个有效 chunk | `message_start`，初始 usage 为 0 |
| 首次出现非空 `delta.reasoning_content` | `content_block_start (thinking)` + `thinking_delta` |
| 后续 `delta.reasoning_content` | `content_block_delta (thinking_delta)` |
| 首次出现非空 `delta.content` | 必要时关闭 thinking 块；生成 `content_block_start (text)` + `text_delta` |
| 后续 `delta.content` | `content_block_delta (text_delta)` |
| 新工具调用的 `delta.tool_calls` | 关闭前一内容块，生成 `content_block_start (tool_use)` |
| 工具参数增量 | `content_block_delta (input_json_delta)` |
| `finish_reason` | 关闭内容块并暂存 `stop_reason`；此时尚不发送 `message_stop` |
| 结束 chunk 或尾随 `choices: []` 中的 usage | 累积最终 usage，等待 `[DONE]` |
| `data: [DONE]` | `message_delta`（结束原因和最终 usage）+ `message_stop` |

等待尾随 usage 可避免丢失某些兼容上游在 `finish_reason` 之后才发送的 token 数。此流式方向将 `prompt_tokens - cached_tokens` 写入 Anthropic `input_tokens`，缓存数写入 `cache_read_input_tokens`；这与第 3.2 节的非流式直接映射不同。

如果上游已发送 `finish_reason`，随后干净关闭连接但省略 `[DONE]`，`onUpstreamEnd()` 会补发终止事件。超时、异常断开或没有结束证据的流不按此规则补齐。

## 5. 转换限制

### 5.1 Thinking 签名与多轮工具调用

`reasoning_content` 是部分 Chat Completions 兼容实现提供的文本扩展，不能承载 Anthropic 的原始 thinking 签名。

Anthropic → Chat Completions 时，thinking 文本保留下来，`signature` 和 `redacted_thinking` 无法保留；Chat Completions → Anthropic 时，只能重建无签名的 thinking 块。流式路径同样不生成 `signature_delta`。

因此，经一次跨协议往返后，即使客户端原样回传 `reasoning_content`，也无法恢复原始签名。需要原始 thinking / signature 的 Anthropic 多轮工具调用可能被上游拒绝。原生回传规则见 [Anthropic thinking 与 signature](../AnthropicProtocol.md)。这类场景宜使用与上游一致的协议；网关当前没有会话签名缓存还原机制。

### 5.2 内容与字段覆盖范围

- 图片支持 URL 和 base64。缺少有效 URL、Anthropic source 不完整，或转换到 Anthropic 的 data URL 不是 base64 时，返回 400。
- 普通 user 消息的文本 / 图片顺序保留；工具结果图片拆到后续 user 消息后，不再保留其在原 tool_result 内的位置。
- Chat Completions → Anthropic 当前仅提取 `system` 角色作为系统提示；`developer` 角色未映射。
- assistant 的文本、思考和工具调用会按目标字段重组，不能恢复原内容块的全部边界和交错顺序。
- 多 choice、旧 `function_call`、`cache_control`、图片 `detail` 等能力或字段未完整映射。转换器构造目标请求，未列出的来源字段不保证保留。
- `tool_choice: "none"` 在转换到 Anthropic 时仅被省略，不能保证上游禁用工具。

## 6. 实现入口

| 文件 | 作用 |
|---|---|
| [OpenAIToAnthropicConverter.ts](../../../src/util/protocolConverter/OpenAIToAnthropicConverter.ts) | Chat Completions 请求转 Anthropic；Anthropic 响应转 Chat Completions |
| [AnthropicToOpenAIConverter.ts](../../../src/util/protocolConverter/AnthropicToOpenAIConverter.ts) | Anthropic 请求转 Chat Completions；Chat Completions 响应转 Anthropic |
| [thinkingConfig.ts](../../../src/util/protocolConverter/thinkingConfig.ts) | effort、adaptive 和旧 budget 配置换算 |
| [protocolConverterUtil.ts](../../../src/util/protocolConverter/protocolConverterUtil.ts) | 图片 source / URL 转换、内容提取与消息合并 |
| [ConverterFactory.ts](../../../src/util/protocolConverter/ConverterFactory.ts) | 按客户端 / 上游协议选择转换器 |
