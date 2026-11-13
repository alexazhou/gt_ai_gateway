# OpenAI Chat Completions ↔ OpenAI Responses

本文描述网关当前实现中 OpenAI Chat Completions（`ApiFormat.OPENAI`，`openai`）与 OpenAI Responses（`ApiFormat.RESPONSES`，`responses`）的双向转换，包括请求体、非流式响应和流式事件。

协议自身的格式见 [Chat Completions 协议](../OpenAiProtocol.md)和 [Responses 协议](../OpenAiResponsesProtocol.md)。另外两组转换见 [Chat Completions ↔ Anthropic](./ChatCompletionsAnthropicConversion.md)和 [Responses ↔ Anthropic](./ResponsesAnthropicConversion.md)。网关如何选择协议、转发和记录响应，见[自动协议转换](../../usage/ProtocolConversion.md)。

## 1. 转换方向与入口

文中的箭头表示当前请求或响应数据的转换方向。转换器类名按**请求方向**命名；同一个实例负责将上游响应按反方向转换回客户端协议。

| 客户端 → 上游 | 转换器 | `convertRequest` | `convertResponse` / `convertStreamEvent` |
|---|---|---|---|
| Chat Completions → Responses | `OpenAIToResponsesConverter` | Chat Completions → Responses | Responses → Chat Completions |
| Responses → Chat Completions | `ResponsesToOpenAIConverter` | Responses → Chat Completions | Chat Completions → Responses |

客户端与上游协议相同时不创建转换器。两者都属于 OpenAI API，但 messages / input、choices / output 和 SSE 事件结构不同，需要完整的协议转换。

## 2. 请求体双向转换

### 2.1 Chat Completions → Responses

| Chat Completions 请求字段 | Responses 请求字段 | 当前处理 |
|---|---|---|
| `model` / `stream` / `temperature` / `top_p` | 同名字段 | 保留 |
| `messages[role=system].content` | `instructions` | 仅处理字符串；多条 system 消息用一个换行拼接 |
| user 的字符串 `content` | user message 的 `content: [{type: "input_text", text}]` | 包装为 input item |
| user 的 `text` / `image_url` 内容块 | user message 的 `input_text` / `input_image` | 逐块转换，保留顺序；图片 URL 保留 |
| assistant 的字符串 `content` | assistant message 的 `content: [{type: "output_text", text}]` | 与工具调用拆成独立 item |
| assistant 的 `tool_calls[]` | `input[]` 中的 `function_call` | `id` → `call_id`，函数名称和参数字符串保留 |
| `messages[role=tool]` | `input[]` 中的 `function_call_output` | `tool_call_id` → `call_id`，字符串 content → output |
| `max_tokens` | `max_output_tokens` | 保留；当前未使用 `max_completion_tokens` 兜底 |
| `tools[].function` | `tools[]` | 提到顶层的 `name` / `description` / `parameters`，类型为 `function` |
| `reasoning_effort` | `reasoning.effort` | 归一化 effort 档位，见第 2.4 节 |

当前该请求方向**未将 assistant 历史 `reasoning_content` 转成 reasoning input item**。配置中的 effort 会映射，历史推理文本不会跟随映射。

### 2.2 Responses → Chat Completions

| Responses 请求字段 | Chat Completions 请求字段 | 当前处理 |
|---|---|---|
| `model` / `stream` / `temperature` / `top_p` | 同名字段 | 保留 |
| `instructions` | 首条 system message | 保留 |
| 字符串 `input` | user message | 包装为 `messages[]` |
| `input[]` 中的 system / developer message | system message | 提取文本；可与 instructions 生成的 system 消息并存 |
| user / assistant message 的字符串 `content` | 同角色 message 的 `content` | 保留 |
| `input_text` / `output_text` 内容块 | `text` 内容块或字符串 content | 纯文本时用换行拼接；有图片时保留内容块数组 |
| `input_image` | `image_url` | 保留 `image_url`（兼容 `url`） |
| `function_call` | assistant 的 `tool_calls[]` | 连续调用合并；可与相邻 assistant 文本合并 |
| `function_call_output` | `messages[role=tool]` | `call_id` → `tool_call_id`；字符串或文本数组转为 tool 内容 |
| `reasoning` input item | 无对应输入项 | 当前跳过，包括 summary 和 encrypted_content |
| `max_output_tokens` | `max_tokens` | 保留 |
| `tools[]` 中的 `function` | `tools[].function` | 仅保留有名称的 function 工具，其他工具类型过滤掉 |
| `reasoning.effort` | `reasoning_effort` | 归一化 effort 档位 |

两种协议的工具调用关联都使用调用 ID；Responses 的 `function_call.id` 是 item ID，不能代替 `call_id` 来关联工具结果。

```text
Chat Completions:
assistant: content="我来查询", tool_calls(call_1, call_2)
tool: tool_call_id=call_1, content="result 1"
tool: tool_call_id=call_2, content="result 2"

Responses:
message(role=assistant, output_text="我来查询")
function_call(call_id=call_1)
function_call(call_id=call_2)
function_call_output(call_id=call_1, output="result 1")
function_call_output(call_id=call_2, output="result 2")
```

### 2.3 多模态与工具结果

普通 user 消息的 `text → image → text` 顺序在两个方向保留。Chat Completions `image_url.url` 与 Responses `input_image.image_url` 直接映射，URL 可以是远程地址或 data URL；图片 `detail` 当前不保留。

Responses `function_call_output.output` 可以是内容块数组。转到 Chat Completions 时，`input_text` / `output_text` 用换行拼接进 tool 消息，图片先收集，在所有连续 tool 消息之后输出一条 user 图片消息。仅含图片的结果仍生成 `content: ""` 的 tool 消息，以保留调用与结果的配对。

Chat Completions → Responses 时，tool 的字符串 content 保留为 output；当前实现不会将非字符串 tool content 映射为内容块数组。

### 2.4 工具选择与思考配置

| Chat Completions | Responses | 当前处理 |
|---|---|---|
| `tool_choice: "auto"` / `"required"` / `"none"` | 同值 `tool_choice` | 双向保留 |
| `tool_choice: {type: "function", function: {name}}` | `tool_choice: {type: "function", name}` | 双向调整名称的嵌套层级 |
| `reasoning_effort` | `reasoning: {effort}` | 双向映射 `none` / `minimal` / `low` / `medium` / `high` / `xhigh` |

当前配置转换只输出 effort；Responses 的 `reasoning.summary` 等选项不会因此保留，也不会自动补充 `include: ["reasoning.encrypted_content"]`。

## 3. 非流式响应双向转换

### 3.1 Responses → Chat Completions

由 `OpenAIToResponsesConverter.convertResponse` 处理，将 output 展平为一个 choice。

| Responses 响应字段 | Chat Completions 响应字段 | 当前处理 |
|---|---|---|
| message item 中的 `output_text.text` | `choices[0].message.content` | 当前逐项覆盖，最终保留最后一个 output_text |
| reasoning item 的 `summary[].text` | `choices[0].message.reasoning_content` | 单个 item 内用换行拼接；多个非空 reasoning item 时保留最后一个 |
| function_call item | `choices[0].message.tool_calls[]` | `call_id` 优先作为调用 ID；名称和参数字符串保留 |
| output 含 function_call | `finish_reason: "tool_calls"` | 否则为 `stop`；未完整映射 response status |
| `created_at` / `model` | `created` / `model` | 保留，缺失时分别使用当前时间 / 请求模型 |
| `id` | `id` | 改为 `chatcmpl-` 前缀 |

`encrypted_content` 无对应 Chat Completions 字段，转换后丢失。多个文本 item 当前不会拼接成完整 content，这是实现限制。

### 3.2 Chat Completions → Responses

由 `ResponsesToOpenAIConverter.convertResponse` 处理，仅取 `choices[0]`。

| Chat Completions 响应字段 | Responses 响应字段 | 当前处理 |
|---|---|---|
| `message.content` | message item 的 `output_text` | 生成 assistant message item |
| `message.reasoning_content` | reasoning item 的 `summary` | 生成一个 `summary_text`；没有 encrypted_content |
| `message.tool_calls[]` | function_call items | 调用 ID → call_id；另生成 `fc_` item ID |
| `finish_reason` | `status` | 当前统一为 `completed`，包括 length / content_filter |
| `id` / `model` | `id` / `model` | 当前非流式 response ID 保留传入 ID，未统一改为 `resp_` 前缀 |
| 无对应字段 | `created_at` | 生成当前时间戳 |

非流式输出项按文本、reasoning、工具调用的顺序构造，不代表原始内容的生成顺序。ID 的格式调整也不提供 Responses 服务端的会话接续能力。

### 3.3 Usage

| Chat Completions usage | Responses usage | 转换 |
|---|---|---|
| `prompt_tokens` | `input_tokens` | 双向映射 |
| `completion_tokens` | `output_tokens` | 双向映射 |
| `total_tokens` | `total_tokens` | 保留；Responses → Chat Completions 缺失时用输入 + 输出兜底 |
| `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` | 双向映射 |
| `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` | 非流式双向映射 |

当前 Chat Completions → Responses 非流式路径仅在明细非零时输出对应 details；反方向则在来源字段存在时保留。

## 4. 流式事件双向转换

Chat Completions 使用 `data: {json}` chunk，以 `[DONE]` 结束；Responses 按 JSON `type` 区分事件，正常结束事件为 `response.completed`。转换到 Responses 时，还需维护 item ID、output index、参数 / 文本缓冲和 `sequence_number`。

### 4.1 Responses → Chat Completions

由 `OpenAIToResponsesConverter.convertStreamEvent` 处理。

| Responses 上游事件 | Chat Completions 客户端事件 / 处理 |
|---|---|
| `response.created` | 首个 assistant chunk，使用该事件中的 response ID 和模型 |
| `response.output_item.added (function_call)` | 初始化 `delta.tool_calls[]`，使用来源 output_index 作为调用 index |
| `response.output_text.delta` | `delta.content` |
| `response.function_call_arguments.delta` | 按来源 output_index 输出 `delta.tool_calls[].function.arguments` |
| `response.reasoning_summary_text.delta` | `delta.reasoning_content` |
| `response.output_text.done` / `response.function_call_arguments.done` / `response.reasoning_summary_text.done` | 忽略完整快照，避免重复输出增量 |
| `response.completed` | 结束 chunk（有工具调用则为 tool_calls，否则 stop）+ usage-only chunk + `[DONE]` |
| `error` / `response.failed` | 转成带 `error` 的错误事件 |

此方向流式 usage 保留 cached_tokens 和 reasoning_tokens。内容块边界、summary 分段边界和 encrypted_content 不传给 Chat Completions 客户端。

### 4.2 Chat Completions → Responses

由 `ResponsesToOpenAIConverter.convertStreamEvent` 处理。

| Chat Completions 上游 chunk | Responses 客户端事件 / 处理 |
|---|---|
| 首个有效 chunk | `response.created` + `response.in_progress` |
| 首次非空 `delta.content` | `response.output_item.added (message)` + `response.content_part.added` |
| `delta.content` | `response.output_text.delta` |
| 首次非空 `delta.reasoning_content` | `response.output_item.added (reasoning)` + `response.reasoning_summary_part.added` |
| `delta.reasoning_content` | `response.reasoning_summary_text.delta` |
| 新 `delta.tool_calls` | `response.output_item.added (function_call)` |
| 工具参数增量 | `response.function_call_arguments.delta`，按调用 index 累积 |
| `finish_reason` | 暂存结束原因，发出文本 / reasoning / 工具参数的 done 事件和相应 item 收尾 |
| 最终 usage 帧 | 构造完整 output 和 usage，发出 `response.completed` |
| `[DONE]` | 若尚未 completed，则用已累积状态兜底完成；已完成时不重复发送 |
| 上游 `error` | 转成 Responses `error` 事件 |

若上游已发送 `finish_reason`，随后干净 EOF 但省略 `[DONE]` 且尚未完成，`onUpstreamEnd()` 会补发收尾。超时或异常断开不按此规则处理。

流式路径当前保留 cached_tokens，但 Chat Completions → Responses 未完整携带 reasoning_tokens 明细，不能把第 3.3 节的非流式映射直接等同于流式行为。

## 5. 转换限制

- Responses 的 `previous_response_id`、`store`、`include` 等服务端状态与选项未映射到 Chat Completions；跨协议多轮请求需要客户端提供完整历史。
- 历史 reasoning 在两个请求方向均未完整传递；响应方向的 reasoning summary 映射只保留可见文本，无法无损保留加密推理内容。
- `input_file` 转到 Chat Completions 明确返回 400；仅提供 `input_image.file_id` 而没有 URL 的图片也返回 400。
- Responses 内置工具（例如 web_search、image_generation）、对应输出 item、refusal、annotations 等未完整映射；function 工具以外的请求工具会被过滤。
- Chat Completions → Responses 当前只提取 system 消息，未处理 developer 消息、assistant 内容块数组、`max_completion_tokens` 和 `stop` 等字段。
- 非流式 Responses → Chat Completions 当前只保留最后一个文本片段；反方向仅取第一个 choice。
- `length` / `content_filter` / Responses incomplete 状态和原因未完整双向映射。`completed` 只表示当前转换器生成的状态，不能据此恢复来源协议的所有结束原因。
- 转换器构造目标请求和响应；未列出的字段不保证保留。原始 Responses reasoning 格式见 [Responses 协议](../OpenAiResponsesProtocol.md)。

## 6. 实现入口

| 文件 | 作用 |
|---|---|
| [OpenAIToResponsesConverter.ts](../../../src/util/protocolConverter/OpenAIToResponsesConverter.ts) | Chat Completions 请求转 Responses；Responses 响应转 Chat Completions |
| [ResponsesToOpenAIConverter.ts](../../../src/util/protocolConverter/ResponsesToOpenAIConverter.ts) | Responses 请求转 Chat Completions；Chat Completions 响应转 Responses |
| [thinkingConfig.ts](../../../src/util/protocolConverter/thinkingConfig.ts) | effort 档位归一化 |
| [protocolConverterUtil.ts](../../../src/util/protocolConverter/protocolConverterUtil.ts) | Responses 内容提取与工具参数处理 |
| [ConverterFactory.ts](../../../src/util/protocolConverter/ConverterFactory.ts) | 按客户端 / 上游协议选择转换器 |
