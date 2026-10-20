# 自动协议转换 (Automatic Protocol Conversion)

Serverless AI Gateway 的核心特性之一是**透明且自动的协议转换**。它允许你在不需要修改客户端代码的情况下，跨越不同供应商的 API 格式壁垒，使用同一种接口规范调用所有的 LLM（大语言模型）。

---

## 什么是自动协议转换？

目前网关支持的 API 规范主要有三种：
1. **OpenAI Chat Completions** (`/v1/chat/completions`)
2. **Anthropic Messages** (`/v1/messages`)
3. **OpenAI Responses** (`/v1/responses`)

通常情况下，如果你在项目中同时使用了 GPT-4 和 Claude 3，你需要准备两套 SDK，编写两套完全不同的组装参数和解析响应（包括解析复杂的 SSE Stream 流）的代码。

**自动协议转换**意味着：网关在中间做了一层“翻译器”。你可以**全部使用 OpenAI 的规范（SDK）**来发送请求，即使用户请求的模型是 Claude 3（Anthropic 格式），网关也会自动将请求实时转换为 Anthropic 需要的格式，并把 Anthropic 的响应实时转换为 OpenAI 的格式返回给你。这一切对客户端完全透明。

---

## 什么时候会自动发生转换？

转换过程是**全自动、实时发生**的，基于你在请求时所使用的 **请求端点（Endpoint）** 和 **后台模型实际支持的协议** 之间的差异触发。

### 触发条件矩阵：

| 客户端请求的端点 | 后台模型实际支持的协议 | 网关的行为 | 结果 |
| :--- | :--- | :--- | :--- |
| `/llm/v1/chat/completions` (OpenAI) | **OpenAI** | 透传 | 不做转换，直接代理请求。 |
| `/llm/v1/chat/completions` (OpenAI) | **Anthropic** | **触发转换** | 请求转为 Anthropic，响应转为 OpenAI。 |
| `/llm/v1/chat/completions` (OpenAI) | **Responses** | **触发转换** | 请求转为 Responses，响应转为 OpenAI。 |
| `/llm/v1/messages` (Anthropic) | **Anthropic** | 透传 | 不做转换，直接代理请求。 |
| `/llm/v1/messages` (Anthropic) | **OpenAI** | **触发转换** | 请求转为 OpenAI，响应转为 Anthropic。 |
| `/llm/v1/messages` (Anthropic) | **Responses** | **触发转换** | 请求转为 Responses，响应转为 Anthropic。 |
| `/llm/v1/responses` (Responses) | **Responses** | 透传 | 不做转换，直接代理请求。 |
| `/llm/v1/responses` (Responses) | **OpenAI** | **触发转换** | 请求转为 OpenAI，响应转为 Responses。 |
| `/llm/v1/responses` (Responses) | **Anthropic** | **触发转换** | 请求转为 Anthropic，响应转为 Responses。 |

简单来说：**只要客户端使用的协议，与实际提供模型的供应商协议不一致，就会自动触发双向转换。**

---

## 如何判断后台模型实际支持哪些协议？

网关在判断一个模型“实际支持什么协议”时，会按照以下优先级进行判断：

1. **优先级一：供应商模型中显式配置的协议（强制指定）**
   在管理后台的“供应商模型”设置中，你可以为某个特定模型显式指定其支持的协议（如 `OpenAI` 或 `Anthropic`）。如果配置了此项，网关将**优先且无条件地**认为该模型支持你设定的协议。
2. **优先级二：供应商配置中存在的协议 URL（默认行为）**
   如果在“供应商模型”中没有单独指定协议，网关会**自动根据其归属供应商所填写的 API URL** 来进行判断。
   - 如果该供应商配置了 `OpenAI API URL`，则认为该供应商下的所有模型默认支持 OpenAI 协议。
   - 如果该供应商配置了 `Anthropic API URL`，则认为默认支持 Anthropic 协议。
   - 如果填写了多种协议 URL，则说明该供应商原生支持多协议。客户端请求的协议刚好是其中之一时，网关会直接透传，避免不必要的转换开销。

---

## 如何使用？

使用自动协议转换**不需要任何额外的配置**，它是开箱即用（Out-of-the-box）的。

你只需要做到一点：**在客户端按照你选定的协议格式，传入正确的模型名称。**

### 示例场景：使用 OpenAI 官方 SDK 调用 Claude 3

假设你在网关后台配置了：
- **供应商**：支持并配置了 Anthropic 协议
- **模型**：名称为 `claude-3-opus-20240229`，绑定到上述供应商

你在客户端代码中，**完全可以使用 OpenAI 的官方 SDK**：

```python
import openai

client = openai.Client(
    base_url="https://<your-gateway-url>/llm/v1",
    api_key="<gateway-user-token>" # 在网关生成的普通用户 Token
)

response = client.chat.completions.create(
    model="claude-3-opus-20240229", # 直接填写后台配置的 Anthropic 模型名称
    messages=[
        {"role": "user", "content": "你好，请用一句话介绍你自己。"}
    ],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### 背后的魔法：
1. **客户端**发出了标准的 OpenAI `chat/completions` 请求。
2. **网关**接管请求，发现模型 `claude-3-opus-20240229` 绑定的供应商实际支持的是 Anthropic 协议。
3. **网关**将请求体的 `messages`、`model`、`stream` 等字段无缝映射为 Anthropic `/v1/messages` 接口规范，并附带真正的 Anthropic API Key 发送给上游。
4. **上游 (Anthropic)** 开始源源不断地返回 SSE 事件流（如 `message_start`, `content_block_delta` 等）。
5. **网关**实时拦截这些 Anthropic 事件，将它们翻译为标准的 OpenAI SSE `chunk`（如 `chunk.choices[0].delta.content`）。
6. **客户端**完美接收到流式输出，完全不知道背后实际调用的是 Anthropic。

### 示例场景二：高级用法（强制协议转换）

在某些特殊场景下，供应商的某个模型可能只支持特定的协议（例如：该供应商的大部分模型同时支持 OpenAI 和 Anthropic 双协议，但是某一个特定的模型只支持 OpenAI 协议）。

此时，你可以利用上述的**“优先级一”**，在后台的**添加/编辑供应商模型**弹窗中，**手动设置该模型所支持的协议类型**为 `OpenAI`。

一旦这样设置：
- 即使你的客户端使用的是标准的 Anthropic `messages` SDK 发起请求，网关在对比时，会发现客户端请求(Anthropic)与供应商模型强制指定的协议(OpenAI)不一致。
- 网关会立即**强制触发协议转换**，把你的 Anthropic 请求转成 OpenAI 格式发送给第三方渠道！

这赋予了你在对接各种协议不规范的第三方渠道时，极大的灵活性与掌控力。

---

## 支持转换的特性清单

在协议转换过程中，网关不仅转换了基础的文本，还对一些高级特性提供了深度适配：

- **基础对话结构**: `system` prompt 映射、`messages` 角色 (`user`/`assistant`) 的转换与合并。
- **参数映射**: `max_tokens`, `temperature`, `top_p` 等生成参数的对齐。
- **流式传输 (SSE Stream)**: 实时、低延迟的双向事件流解析与重组。
- **多模态 (Vision / Image)**: 三种协议之间的消息图片互转，支持 base64 / data URL / 公网 URL：
  - OpenAI `image_url` ↔ Anthropic `image`（base64 / url source）
  - OpenAI `image_url` ↔ Responses `input_image`
  - Anthropic `image` ↔ Responses `input_image`
  - 工具结果中的图片同样支持：Anthropic `tool_result` 内容数组、Responses `function_call_output.output` 内容数组
  - OpenAI 的 `tool` 消息协议上只支持文本，工具结果图片会被拆分到后续 user 消息
- **工具调用 (Function Calling / Tool Use)**: 支持将 OpenAI 规范的 `tools` 和 `tool_choice` 转译为 Anthropic 的 `tools` 规范。能够正确解析模型返回的 `tool_calls`，并支持客户端将 `tool` 角色的结果回传。

## 注意事项

虽然网关尽最大努力保证协议转换的无缝兼容，但受限于不同 API 规范的底层设计差异，可能会有极少数边界情况的差异（例如某些特定供应商的实验性参数不兼容）。对于绝大多数标准对话、流式输出、图片识别和工具调用，自动转换都是稳定可靠的。

### 已知限制

- `input_image.file_id`、`input_file` 等需要 OpenAI 侧文件解析的内容无法转换为其他协议，会明确返回 400
- 非 base64 的 data URL 在转换为 Anthropic 时会返回 400
- `image_url.detail` 等非通用字段在部分转换方向会被丢弃
- 少数供应商对内容块顺序或字段有额外要求，如遇问题请保留实际请求体用于排查
