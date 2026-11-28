# GitHub `1.9_dev` 协议转换 API 测试 Review

- Review 日期：2026-10-22
- 审查范围：`github/1.9_dev` 的 `tests/api/ai/protocol-conversion.test.ts`
- 关联 Review：`doc/tech/github_1.9_dev_review.md`（当前保存在 `stash@{0}`）

## 结论

当前 API 测试已有 18 个用例，已覆盖 OpenAI、Anthropic、Responses 三种协议的主要非流式转换、部分流式转换、OpenAI 与 Anthropic 的普通图片转换、两类工具结果图片转换，以及普通消息中的 `input_file` 和一类无效 Anthropic 图片 source 的拒绝。

此前协议转换 Review 中确认的核心修复，大部分已有单元测试保护；但其中若干关键边界尚未通过完整的网关请求链路验证。建议优先补充本文“最小补测集合”中的 6 个 API 用例。

## 现有覆盖

### 基础协议转换

- OpenAI 非流式请求 → Anthropic 上游 → OpenAI 响应；
- Anthropic 非流式请求 → OpenAI 上游 → Anthropic 响应；
- Responses 请求 → Anthropic 上游；
- Responses 请求 → OpenAI 上游；
- Anthropic 请求 → Responses 上游；
- OpenAI 流式请求 → Anthropic 上游；
- OpenAI 流式请求 → Responses 上游；
- Anthropic 流式请求 → OpenAI 上游。

### 图片与工具结果

- OpenAI 普通图片内容 → Anthropic image block；
- Anthropic 普通图片内容 → OpenAI `image_url` part；
- Responses 工具结果图片 → Anthropic `tool_result` 内的 image block；
- Anthropic 工具结果图片 → OpenAI 后续 user message 的 `image_url` part。

### 错误与路由

- Responses 普通 message content 中的 `input_file` → Anthropic 时返回 400；
- Responses 普通 message content 中的 `input_file` → OpenAI 时返回 400；
- Anthropic 普通 user message 中的无效 image source → OpenAI 时返回 400；
- 上游非 2xx 错误直接返回并记录失败；
- `allowed_formats` 路由选择；
- 由 OpenAI base URL 派生 Responses URL 后，Responses 客户端请求直接路由到 Responses 上游。

## API 测试缺口

### P1：`function_call_output` 中的 `input_file` 没有 API 级回归保护

单元测试已验证 `ResponsesToAnthropicConverter` 和 `ResponsesToOpenAIConverter` 在 `function_call_output.output` 中遇到 `input_file` 时会返回 400，但 API 测试只覆盖普通 message content。

应新增以下两个用例：

1. Responses → Anthropic：

```json
{
    "input": [{
        "type": "function_call_output",
        "call_id": "call_1",
        "output": [{
            "type": "input_file",
            "file_data": "AAAA",
            "filename": "report.pdf"
        }]
    }]
}
```

2. Responses → OpenAI：使用同一请求结构。

两种情况均应断言：

- HTTP 状态码为 400；
- 错误消息包含 `input_file`；
- `upstreamCaptureHelper` 中不存在对应请求，确保网关未把不完整数据发给上游。

该路径是此前 `input_file` 被静默转换为空工具结果的直接回归点，优先级最高。

### P1：工具结果中的无效 Anthropic 图片 source 缺少 API 级验证

现有 API 测试只验证普通 user message 中的无效图片 source。工具结果中的图片使用不同的转换入口，仍应通过完整链路验证。

建议构造：

```json
{
    "messages": [
        {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "toolu_1",
                "name": "read_image",
                "input": {}
            }]
        },
        {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": [{
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png"
                    }
                }]
            }]
        }
    ]
}
```

在 Anthropic → OpenAI 路径中断言：

- 返回 400；
- 错误消息包含 `source`；
- 没有请求发往上游。

### P1：OpenAI 工具结果后紧跟普通 user 内容的消息合并没有 API 级验证

`protocolConverterUtil.appendAnthropicMessage()` 已在单元测试中验证会合并连续 Anthropic user turn，但 API 测试未覆盖完整网关链路。

应以 OpenAI 客户端 → Anthropic 上游发送：

```text
assistant(tool_calls) → tool(result) → user(text 或 image)
```

并通过 `upstreamCaptureHelper` 断言上游最终收到：

```text
assistant(tool_use) → user([tool_result, text 或 image])
```

而不是：

```text
assistant(tool_use) → user(tool_result) → user(text 或 image)
```

该测试能避免未来在 sender、converter 调用或消息组装层发生回归后重新依赖上游服务自动合并连续 user turn。

### P1：Responses 多模态内容顺序没有 API 级验证

目前 `text → image → text` 的顺序保护只在 unit test 中覆盖。应在 API 层验证网关实际发送给上游的请求体。

建议请求内容为：

```json
[
    { "type": "input_text", "text": "先解释" },
    { "type": "input_image", "image_url": "data:image/png;base64,AAAA" },
    { "type": "input_text", "text": "再总结" }
]
```

至少新增两个方向：

1. Responses → OpenAI：断言捕获的 `messages[0].content` 严格为：

```json
[
    { "type": "text", "text": "先解释" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
    { "type": "text", "text": "再总结" }
]
```

2. Responses → Anthropic：断言捕获的 `messages[0].content` 严格为：

```json
[
    { "type": "text", "text": "先解释" },
    {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "AAAA"
        }
    },
    { "type": "text", "text": "再总结" }
]
```

不能只判断数组中存在图片，必须使用 `toEqual()` 判断完整内容和顺序。

## 后续增强项

### Responses 普通图片的 API 矩阵

已覆盖 OpenAI ↔ Anthropic 的普通图片，以及部分工具结果图片；但普通图片的以下 API 路径尚未验证：

| 客户端协议 | 上游协议 | 建议优先级 |
| --- | --- | --- |
| Responses | Anthropic | 高 |
| Responses | OpenAI | 高 |
| Anthropic | Responses | 中 |
| OpenAI | Responses | 中 |

前两项直接覆盖本次改动较多的 `ResponsesToAnthropicConverter` 和 `ResponsesToOpenAIConverter`，建议优先添加。

### 流式协议转换矩阵

已有流式覆盖：

- OpenAI → Anthropic；
- OpenAI → Responses；
- Anthropic → OpenAI。

未覆盖：

- Anthropic → Responses；
- Responses → Anthropic；
- Responses → OpenAI；
- 上述方向中工具调用、工具结果、上游 SSE error、usage 尾帧和 `[DONE]` / EOF 收尾行为。

这部分覆盖面较大，建议作为单独的“协议转换 API 矩阵”专项补充，而非阻塞本轮已有修复。

## 推荐最小补测集合

建议优先在 `tests/api/ai/protocol-conversion.test.ts` 中增加以下 6 个用例：

1. Responses `function_call_output.output` 中的 `input_file` → Anthropic：返回 400，且不请求上游；
2. Responses `function_call_output.output` 中的 `input_file` → OpenAI：返回 400，且不请求上游；
3. Anthropic 工具结果中的无效图片 source → OpenAI：返回 400，且不请求上游；
4. OpenAI `tool` 结果后紧跟 user text → Anthropic：上游只收到一条合并后的 user message；
5. Responses `text → image → text` → OpenAI：捕获上游请求并验证内容顺序；
6. Responses `text → image → text` → Anthropic：捕获上游请求并验证内容顺序。

这 6 项能够将此前 Review 中修复的关键行为从 converter 单元测试提升为网关 API 回归保护。

