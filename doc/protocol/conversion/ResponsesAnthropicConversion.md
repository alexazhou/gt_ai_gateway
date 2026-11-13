# OpenAI Responses ↔ Anthropic Messages

本文描述网关当前实现中 OpenAI Responses（`ApiFormat.RESPONSES`，`responses`）与 Anthropic Messages（`ApiFormat.ANTHROPIC`，`anthropic`）的双向转换，包括请求体、非流式响应和流式事件。

协议自身的格式见 [Responses 协议](../OpenAiResponsesProtocol.md)和 [Anthropic 协议](../AnthropicProtocol.md)。另外两组转换见 [Chat Completions ↔ Anthropic](./ChatCompletionsAnthropicConversion.md)和 [Chat Completions ↔ Responses](./ChatCompletionsResponsesConversion.md)。网关如何选择协议、转发和记录响应，见[自动协议转换](../../usage/ProtocolConversion.md)。

## 1. 转换方向与入口

文中的箭头表示当前请求或响应数据的转换方向。转换器类名按**请求方向**命名；同一个实例负责将上游响应按反方向转换回客户端协议。

| 客户端 → 上游 | 转换器 | `convertRequest` | `convertResponse` / `convertStreamEvent` |
|---|---|---|---|
| Responses → Anthropic | `ResponsesToAnthropicConverter` | Responses → Anthropic | Anthropic → Responses |
| Anthropic → Responses | `AnthropicToResponsesConverter` | Anthropic → Responses | Responses → Anthropic |

客户端与上游协议相同时不创建转换器。下文仅描述跨协议转换；形状相近的字段不一定具有相同语义，尤其是 thinking 签名和 encrypted_content。

## 2. 请求体双向转换

### 2.1 Responses → Anthropic

| Responses 请求字段 | Anthropic 请求字段 | 当前处理 |
|---|---|---|
| `model` / `stream` / `temperature` / `top_p` | 同名字段 | 保留 |
| `instructions` | `system` | 优先使用；未提供时从 input 的 system / developer message 提取第一份非空文本 |
| 字符串 `input` | user message | 包装为 `messages[]` |
| user / assistant message | 同角色的 `messages[]` | 字符串 content 保留；文本块转换为 `text` |
| `input_text` / `output_text` | `text` 内容块 | 保留文本与普通图片块的顺序 |
| `input_image` | `image` 内容块 | data URL 转 base64 source，普通 URL 转 url source |
| `function_call` | assistant 的 `tool_use` 块 | `call_id` → `id`，`arguments` 解析为 `input` |
| `function_call_output` | user 的 `tool_result` 块 | `call_id` → `tool_use_id`；output 支持字符串和文本 / 图片数组 |
| `reasoning` input item | assistant 的 `thinking` 块 | 有非空 summary 数组时，summary 文本用换行拼接；encrypted_content 赋给 signature，语义限制见第 5.1 节 |
| `max_output_tokens` | `max_tokens` | 非零值保留，未设置时默认 `32768` |
| `tools[]` 中的 `function` | `tools[]` | 仅保留有名称的 function 工具；`parameters` → `input_schema` |
| `reasoning.effort` | `thinking` + `output_config` | 按第 2.4 节转换 |

连续的 function_call 合并成 assistant 的多个 tool_use；连续 function_call_output 合并成 user 的多个 tool_result。工具结果后紧跟普通 user 内容时，会合并到同一条 user 消息。

### 2.2 Anthropic → Responses

| Anthropic 请求字段 | Responses 请求字段 | 当前处理 |
|---|---|---|
| `model` / `stream` / `temperature` / `top_p` | 同名字段 | 保留 |
| `system` | `instructions` | 字符串保留；文本块数组用两个换行拼接 |
| user 的字符串 / text 块 | user message 的 `input_text` | 包装成 input item |
| user 的 `image` 块 | user message 的 `input_image` | base64 source 组装成 data URL，url source 保留 URL |
| assistant 的字符串 / text 块 | assistant message 的 `output_text` | 包装成独立 message item |
| assistant 的 `tool_use` 块 | `function_call` input item | `id` → `call_id`，`input` 序列化为 arguments |
| user 的 `tool_result` 块 | `function_call_output` input item | `tool_use_id` → `call_id`，content → output |
| assistant 的 `thinking` 块 | `reasoning` input item | thinking → summary，signature → encrypted_content，语义限制见第 5.1 节 |
| `max_tokens` | `max_output_tokens` | 保留 |
| `tools[]` | `tools[]` 中的 `function` | `input_schema` → `parameters` |
| `thinking` + `output_config` | `reasoning.effort` | 按第 2.4 节转换 |

Anthropic 同一条消息中的文本、工具调用与工具结果会拆成多个 Responses item。此方向按原内容块顺序输出；遇到 tool_result 时，先输出此前积累的普通 user 内容，再输出 function_call_output。

```text
Anthropic:
assistant: [text("我来查询"), tool_use(call_1)]
user: [tool_result(call_1, "结果"), text("继续")]

Responses:
message(role=assistant, output_text="我来查询")
function_call(call_id=call_1)
function_call_output(call_id=call_1, output="结果")
message(role=user, input_text="继续")
```

### 2.3 多模态与工具结果

| Responses 内容块 | Anthropic 内容块 | 双向映射 |
|---|---|---|
| `input_text`（反向也接受 `output_text`） | `text` | 文本保留 |
| `input_image.image_url` 为 data URL | `image.source: {type: "base64", media_type, data}` | 拆分 / 组装 base64 data URL |
| `input_image.image_url` 为普通 URL | `image.source: {type: "url", url}` | URL 保留 |

这些映射同样用于 `function_call_output.output[]` ↔ `tool_result.content[]`，图片留在工具结果内部。字符串工具结果双向保留为字符串。

Responses 图片仅有 `file_id` 而无 URL 时，网关无法解析文件，返回 400；`input_file` 也明确返回 400。Anthropic 图片缺少有效 source / data / URL，或目标 Anthropic 的 data URL 不是 base64 形式时，同样返回 400。

### 2.4 工具选择与思考配置

| Responses `tool_choice` | Anthropic `tool_choice` | 当前处理 |
|---|---|---|
| `"auto"` | `{type: "auto"}` | 双向映射 |
| `"required"` | `{type: "any"}` | 双向映射 |
| `{type: "function", name}` | `{type: "tool", name}` | 双向映射 |
| `"none"` | 不设置 | Responses → Anthropic 当前未生成显式禁用工具的配置 |

这组转换使用共享 `parseToolArguments`：工具参数必须是合法 JSON 对象，解析失败或结果不是对象时回退为 `{}`；原始无效参数不会保留。

思考配置的当前实现为 [thinkingConfig.ts](../../../src/util/protocolConverter/thinkingConfig.ts)：

| 来源配置 | 目标配置 |
|---|---|
| Responses `reasoning.effort: "none"` | Anthropic `thinking: {type: "disabled"}` |
| Responses 的 `minimal` / `low` / `medium` / `high` / `xhigh` | Anthropic `thinking: {type: "adaptive"}` + `output_config: {effort: 原档位}` |
| Anthropic `thinking.type=disabled` | Responses `reasoning: {effort: "none"}` |
| Anthropic `thinking.type=adaptive` | 使用 `output_config.effort`，未设置时为 `high` |
| Anthropic `thinking.type=enabled` | 根据旧 budget_tokens 换算 effort，见下表 |

| 旧 `thinking.budget_tokens` | Responses `reasoning.effort` |
|---|---|
| ≤ 0 | `none` |
| ≤ 1500 | `minimal` |
| ≤ 4000 | `low` |
| ≤ 7500 | `medium` |
| ≤ 12000 | `high` |
| > 12000 | `xhigh` |
| enabled 但未设置 budget | `high` |

旧文档中的“effort 转 enabled + 固定 budget”已不适用于当前输出：**转换到 Anthropic 时使用 adaptive + output_config.effort**。具体档位是否被模型接受由上游决定。此转换只映射配置，不能补回缺失的推理文本或签名。

## 3. 非流式响应双向转换

### 3.1 Anthropic → Responses

由 `ResponsesToAnthropicConverter.convertResponse` 处理。

| Anthropic 响应字段 | Responses 响应字段 | 当前处理 |
|---|---|---|
| `content[]` 中的 `text` | message item 的 `output_text` | 每个文本块生成一个 assistant message item |
| `content[]` 中的 `tool_use` | function_call item | id → call_id，input → JSON arguments |
| `content[]` 中的 `thinking` | reasoning item | thinking → summary，signature → encrypted_content |
| `stop_reason` | `status` | 当前统一生成 `completed`，未保留 max_tokens 等具体原因 |
| `id` / `model` | `id` / `model` | 非流式 response ID 当前保留传入 ID，未统一改成 resp_ 前缀 |
| 无对应字段 | `created_at` | 生成当前时间戳 |

output 按原 content 块顺序构造。不能因非流式能输出 reasoning item，就推断流式最终 response.completed 也包含完整 reasoning，见第 5.2 节。

### 3.2 Responses → Anthropic

由 `AnthropicToResponsesConverter.convertResponse` 处理。

| Responses 响应字段 | Anthropic 响应字段 | 当前处理 |
|---|---|---|
| message item 的 `output_text` | `content[]` 中的 text | 按 output / content 遍历顺序输出 |
| function_call item | `content[]` 中的 tool_use | call_id 优先作为调用 ID，arguments 解析为 input |
| reasoning item 的 `summary[].text` | `content[]` 中的 thinking | 单个 item 内用换行拼接；只有非空思考文本时生成块 |
| reasoning 的 `encrypted_content` | thinking 的 `signature` | 直接赋值，存在语义风险，见第 5.1 节 |
| output 含 function_call | `stop_reason: "tool_use"` | 否则为 end_turn；未完整映射 status / incomplete_details |
| `id` / `model` | `id` / `model` | ID 改为 msg_ 前缀，model 保留 |

### 3.3 Usage

| 方向 | 当前非流式映射 |
|---|---|
| Responses → Anthropic | `input_tokens - cached_tokens` → input_tokens（下限 0）；cached_tokens → cache_read_input_tokens；output_tokens 保留 |
| Anthropic → Responses | input_tokens / output_tokens 直接映射，两者相加为 total_tokens；此路径未完整映射缓存 token |

Anthropic 的 input_tokens 与 cache_read_input_tokens 是分开的统计项，Responses 的 input_tokens 通常包含缓存输入。因此，上述两个方向当前并非严格对称。非流式计费使用上游原始 usage，见[响应处理与记录](../../usage/ProtocolConversion.md#响应处理与记录)。

## 4. 流式事件双向转换

Responses 按 JSON `type` 区分事件，以 `response.completed` 正常结束；Anthropic 使用 `event: 事件名` + `data: {json}`，以 `message_stop` 结束。一个来源事件可能转换成多个目标事件。

### 4.1 Anthropic → Responses

由 `ResponsesToAnthropicConverter.convertStreamEvent` 处理。

| Anthropic 上游事件 | Responses 客户端事件 / 处理 |
|---|---|
| `message_start` | `response.created` + `response.in_progress`；保存 model、ID 和输入 usage |
| `content_block_start (text)` | 必要时生成 `response.output_item.added (message)`；生成 `response.content_part.added` |
| `content_block_delta (text_delta)` | `response.output_text.delta`，累积文本 |
| `content_block_stop (text)` | `response.output_text.done` + `response.content_part.done`；message item 在 message_stop 收尾 |
| `content_block_start (tool_use)` | `response.output_item.added (function_call)` |
| `content_block_delta (input_json_delta)` | `response.function_call_arguments.delta`，按调用 index 累积 |
| `content_block_stop (tool_use)` | `response.function_call_arguments.done` + `response.output_item.done` |
| `content_block_start (thinking)` | `response.output_item.added (reasoning)` + `response.reasoning_summary_part.added` |
| `content_block_delta (thinking_delta)` | `response.reasoning_summary_text.delta` |
| `content_block_delta (signature_delta)` | 保存 signature，不产生单独的目标增量事件 |
| `content_block_stop (thinking)` | summary text / part done + reasoning output_item.done（包含 encrypted_content） |
| `message_delta` | 更新 usage；当前未保留所有 stop_reason 语义 |
| `message_stop` | 关闭仍开放的 message item，构造最终 output / usage，发出 `response.completed` |
| `error` | 返回 `event: error`，保留上游错误数据 |

该流式路径会将 cache_read_input_tokens 写入 Responses cached_tokens，total_tokens 为 input_tokens + cache_read_input_tokens + output_tokens；当前 input_tokens 本身仍使用 Anthropic 的非缓存输入值，尚未完整统一统计口径。

### 4.2 Responses → Anthropic

由 `AnthropicToResponsesConverter.convertStreamEvent` 处理。

| Responses 上游事件 | Anthropic 客户端事件 / 处理 |
|---|---|
| `response.created` | `message_start`，映射 response ID 和初始 usage |
| `response.output_item.added (message)` | `content_block_start (text)` |
| `response.output_text.delta` | `content_block_delta (text_delta)` |
| `response.output_item.done (message)` | `content_block_stop` |
| `response.output_item.added (function_call)` | `content_block_start (tool_use)` |
| `response.function_call_arguments.delta` | `content_block_delta (input_json_delta)` |
| `response.function_call_arguments.done` | `content_block_stop`；随后 function_call item.done 不重复关闭 |
| `response.output_item.added (reasoning)` | `content_block_start (thinking)`，不带 signature |
| `response.reasoning_summary_text.delta` | `content_block_delta (thinking_delta)` |
| `response.output_item.done (reasoning)` | `content_block_stop`，当前没有 signature_delta |
| `response.output_text.done` / `response.content_part.done` | 不重复输出完整文本 |
| `response.completed` | `message_delta`（结束原因与最终 usage）+ `message_stop` |
| `error` / `response.failed` | 转成 Anthropic `error` 事件 |

最终 usage 将 input_tokens 扣除 cached_tokens 后写入 Anthropic input_tokens，缓存数写入 cache_read_input_tokens。结束原因根据最终 output 是否有 function_call 判为 tool_use / end_turn。

两种协议的终止事件携带结束原因、usage 或完整 response，缺失时视为截断；转换器不会仅凭 EOF 伪造成功终止。

## 5. 转换限制

### 5.1 Thinking 签名与 encrypted_content

Anthropic signature 与 OpenAI encrypted_content 属于不同上游的验证 / 加密机制，不能交叉验证。当前代码在请求和非流式响应中做了字段赋值：

```text
Anthropic thinking.thinking   ↔ Responses reasoning.summary[].text
Anthropic thinking.signature ↔ Responses reasoning.encrypted_content
```

第一行仅传递可见文本；Responses summary 不等于完整思考过程。第二行只是当前实现的字段搬运，**不表示两种密文兼容**：把 OpenAI encrypted_content 用作 Anthropic signature，或把 Anthropic signature 发给 OpenAI，都可能被上游拒绝。

流式行为也不对称：Anthropic → Responses 的 reasoning item.done 携带签名映射值；Responses → Anthropic 当前只转 summary 文本，没有恢复 signature 或生成 signature_delta。只有 encrypted_content、没有 summary 的 reasoning item，在转换到 Anthropic 时也可能被丢弃。

需要无损接续原始思考的多轮工具调用，应使用与上游一致的协议。Anthropic 原生回传规则见 [thinking 与 signature](../AnthropicProtocol.md)，Responses 原始 reasoning 格式见 [Responses 协议](../OpenAiResponsesProtocol.md)。

### 5.2 最终快照与内容顺序

Anthropic → Responses 流式路径会发出 reasoning 的增量和 item.done，但当前 `response.completed.output` 只组装文本与 function_call，未包含已生成的 reasoning item。消费增量、item.done 或仅消费最终快照的客户端会得到不同的推理内容。

Responses → Anthropic 请求转换会把 reasoning 附到前一个 assistant 内容数组末尾，或新建 assistant 消息；它未统一修复 thinking 的位置，也未清理末尾悬挂的 thinking。目标模型有内容顺序要求时，可能拒绝该历史消息。

当前流式转换还依赖内容块 / item 按顺序到来，没有完整保留 Responses 的多个 content_index、summary_index 或任意交错 item 的语义。

### 5.3 其他未覆盖能力

- Responses `previous_response_id`、`store`、`include`、`reasoning.summary` 等选项未完整转换；跨协议多轮需要显式提供历史。
- Responses 内置工具与对应 output item 未完整映射，转换到 Anthropic 的请求只保留有名称的 function 工具。
- Anthropic `redacted_thinking`、`cache_control`、`stop_sequences` 等字段未完整映射到 Responses。
- `tool_choice: "none"` 转到 Anthropic 时只省略配置，不能保证禁用工具。
- max_tokens、incomplete、过滤和失败等结束状态未完整双向映射；流式 error / response.failed 有单独的错误事件处理。
- 转换器构造目标请求和响应；未列出的字段不保证保留。

## 6. 实现入口

| 文件 | 作用 |
|---|---|
| [ResponsesToAnthropicConverter.ts](../../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts) | Responses 请求转 Anthropic；Anthropic 响应转 Responses |
| [AnthropicToResponsesConverter.ts](../../../src/util/protocolConverter/AnthropicToResponsesConverter.ts) | Anthropic 请求转 Responses；Responses 响应转 Anthropic |
| [thinkingConfig.ts](../../../src/util/protocolConverter/thinkingConfig.ts) | effort、adaptive 和旧 budget 配置换算 |
| [protocolConverterUtil.ts](../../../src/util/protocolConverter/protocolConverterUtil.ts) | 图片转换、内容提取、工具参数与消息合并 |
| [ConverterFactory.ts](../../../src/util/protocolConverter/ConverterFactory.ts) | 按客户端 / 上游协议选择转换器 |
