# 协议转换实现状态与剩余问题

## 1. 当前基线与结论

| 项目 | 当前状态 |
|---|---|
| 整理与复核日期 | 2026-11-16 |
| 仓库 / 分支 | `gt_ai_gateway` / `1.9_dev`，跟踪 `origin/1.9_dev` |
| 当前代码基线 | `4a7a16e12ecbac3ea5c20620947727b63545f3fe` |
| 版本 | v1.9.1-beta1 |
| 范围 | 六个协议转换器的请求、非流式与流式响应，相关累积器，原始上游用量收集、结算及思考凭据恢复调用链 |

当前 PC-001～PC-012 中，**9 项的原列举缺陷已修复，PC-003、PC-009 部分修复，PC-012 仍需明确历史思考兼容策略**。未完成项中有 **6 个已在当前代码复现的具体场景（5 个 P1、1 个 P2）**，另有来源绑定等代码确认的设计缺口；这些证据分别记录，不混合计数。

本文是两份原问题 / 复核文档合并后的唯一状态清单。保留原 PC 编号，把复核编号 PCR-001～PCR-006 归入相关 PC 条目；旧版本错误输出只作为修复前对照，已修复项不再作为当前待办。本文没有实施业务代码修复。

“已修复”表示原列举复现已有对应实现和回归断言，不表示该协议方向的所有字段、供应商行为和边界均已验证。“部分修复”表示旧缺陷已有处理，但同一主题仍有下文列出的未完成场景。

### 1.1 基线关系与证据范围

2026-11-16 已从远端拉取并切换到上述 `1.9_dev` 基线。在该分支重新执行 6 组边界复现和类型检查，6 个错误行为仍存在，类型检查通过。与初次复核的 master `d35438a18c182f9a1505b7039afc349b11297560` 对比，`src/`、`tests/`、`package.json`、`package-lock.json` 无差异；分支差异主要涉及 CLI、CI 和文档组织。

证据标记如下：

- **本地复现**：直接调用转换器，必要时串接累积器或下一轮请求转换，断言实际输出。
- **代码确认**：检查当前实现及调用链，没有独立执行该端到端场景。
- **待上游验证**：真实供应商验签、密文兼容性、接续效果或具体错误响应尚未调用验证。

### 1.2 实际转换方向

转换器类名表示请求方向，响应沿相反方向转换。例如，`AnthropicToOpenAIConverter` 的请求是 Anthropic 客户端 → Chat 上游，响应是 Chat 上游 → Anthropic 客户端。下文使用实际数据方向。

| 客户端 → 上游（请求） | 上游 → 客户端（响应） | 转换器 | 当前未完成条目 |
|---|---|---|---|
| Chat → Anthropic | Anthropic → Chat | [OpenAIToAnthropicConverter.ts](../../src/util/protocolConverter/OpenAIToAnthropicConverter.ts) | PC-012：历史摘要生成无签名 thinking |
| Anthropic → Chat | Chat → Anthropic | [AnthropicToOpenAIConverter.ts](../../src/util/protocolConverter/AnthropicToOpenAIConverter.ts) | PC-003-A：交错工具；PC-012：历史签名降级 |
| Chat → Responses | Responses → Chat | [OpenAIToResponsesConverter.ts](../../src/util/protocolConverter/OpenAIToResponsesConverter.ts) | PC-003-B：工具索引；PC-012：历史摘要丢弃 |
| Responses → Chat | Chat → Responses | [ResponsesToOpenAIConverter.ts](../../src/util/protocolConverter/ResponsesToOpenAIConverter.ts) | PC-012：reasoning 历史项跳过 |
| Responses → Anthropic | Anthropic → Responses | [ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts) | PC-009-B/C 及来源绑定边界 |
| Anthropic → Responses | Responses → Anthropic | [AnthropicToResponsesConverter.ts](../../src/util/protocolConverter/AnthropicToResponsesConverter.ts) | PC-009-A/D；别名比较及来源绑定边界 |

公共累积器还影响原生协议流：PC-009-B 的签名片段覆盖也发生在原生 Anthropic 累积器，PC-006 的修复包括原生 Responses reasoning / 工具字段建模。

当前分支实际存在的协议说明：

- [Chat / Anthropic 消息与转换说明](../protocol/MessageFormatConversion.md)
- [Responses / Anthropic 转换说明](../protocol/ResponsesAPIConversion.md)
- [协议转换使用说明](../usage/ProtocolConversion.md)
- [测试手册](../dev/TestManual.md)

这些协议说明仍有第 7 节列出的过时描述，具体当前状态以实现和本文证据为准。

## 2. 全量状态与当前待办

### 2.1 原 PC 编号状态

| 编号 | 主题 | 当前状态 | 剩余工作或修复依据 |
|---|---|---|---|
| PC-001 | 用量口径、缓存与分段 usage | 已修复原列举缺陷 | [共享用量映射和原始上游结算](#pc-001) |
| PC-002 | 提前完成、incomplete 与终止状态 | 已修复原列举缺陷 | [合法终止与断流判定](#pc-002) |
| PC-003 | 输出项索引和工具内容块关联 | **部分修复** | [Chat → Anthropic 交错工具](#pc-003-a)、[Responses → Chat 工具索引](#pc-003-b) |
| PC-004 | 多轮工具历史被合并 | 已修复原列举缺陷 | [保留调用 / 结果轮次](#pc-004) |
| PC-005 | 多段文本 / reasoning 覆盖 | 已修复原列举缺陷 | [按顺序拼接非流式输出](#pc-005) |
| PC-006 | reasoning / 工具累积、最终快照和 getText | 已修复原列举缺陷 | [完整字段和分类型读取](#pc-006)；签名片段问题统一归 PC-009-B |
| PC-007 | developer、多条指令和 token 上限 | 已修复原列举缺陷 | [保留指令和上限优先级](#pc-007) |
| PC-008 | tool_choice=none 丢失 | 已修复原列举缺陷 | [显式禁用及反向映射](#pc-008) |
| PC-009 | 思考凭据来源与完整往返 | **部分修复** | [四个已复现场景及来源边界](#pc-009) |
| PC-010 | ID/model 一致性、item ID 重复 | 已修复原列举缺陷 | [稳定元数据和独立 ID](#pc-010) |
| PC-011 | Chat 非流式转 Anthropic 缓存口径 | 已修复原列举缺陷 | [非缓存输入和缓存子集](#pc-011) |
| PC-012 | Chat 参与的历史思考丢弃 / 降级 | **待确定兼容策略，当前行为仍存在** | [四个请求方向的处理策略](#pc-012) |

### 2.2 六个已复现场景及编号归并

P1 表示工具参数损坏、接续凭据丢失或合法历史回放被拒绝；P2 表示索引 / 归档结构错误。PC-012 暂按原 P2 跟踪，其真实上游拒绝风险待验证。来源绑定、部署密钥边界及响应模型名返回上游名等另以代码确认证据记录。

| 当前编号 | 原复核编号 | 优先级 | 当前错误行为 | 证据 |
|---|---|---|---|---|
| [PC-003-A](#pc-003-a) | PCR-001 | P1 | Chat → Anthropic 的交错工具参数串到当前块 | 转换器直接复现 |
| [PC-003-B](#pc-003-b) | PCR-006 | P2 | Responses → Chat 用 output_index 作为工具索引，产生空工具项 | 转换器 → Chat 累积器 |
| [PC-009-A](#pc-009-a) | PCR-002 | P1 | Responses → Anthropic 流式思考没有返回恢复凭据 | 转换器 → 累积器 → 请求恢复；与非流式对照 |
| [PC-009-B](#pc-009-b) | PCR-003 | P1 | signature_delta 只保存最后一段 | 转换器、原生累积器和下一轮恢复 |
| [PC-009-C](#pc-009-c) | PCR-004 | P1 | 同一路由请求别名与响应模型名不同，回放本地 400 | Responses 客户端 → Anthropic 上游的本地往返 |
| [PC-009-D](#pc-009-d) | PCR-005 | P1 | 非流式仅密文 reasoning 被丢弃 | 转换器直接复现 |

<a id="pc-003"></a>

## 3. PC-003：输出项与工具关联——部分修复

### 3.1 已完成的修复范围

原列举的三条路径已有修复：

- Responses 上游 → Anthropic 客户端：`AnthropicToResponsesConverter` 按 `output_index + content_index/summary_index` 建立 `blocksByKey`，并结合 item ID 定位，交错参数不再统一写入当前块。
- Anthropic 上游 → Responses 客户端：`ResponsesToAnthropicConverter` 用有序 `outputItems` 分配独立 output index，通过 `blockToItem` 让 added / delta / done 指向同一项。
- Chat 上游 → Responses 客户端：`ResponsesToOpenAIConverter` 为 reasoning、message、function_call 分配独立索引，最终快照遵循已发送的项顺序。

回归依据：[protocolConversionFixes.test.ts](../../tests/unit/protocolConverter/protocolConversionFixes.test.ts) 中 PC-003 的三个场景，以及 [streamBlockLifecycle.test.ts](../../tests/unit/protocolConverter/streamBlockLifecycle.test.ts)。以下两条其他方向仍未修复，因此本主题保持部分修复。

<a id="pc-003-a"></a>

### 3.2 PC-003-A：Chat → Anthropic 交错工具参数——待修复，P1

#### 触发条件与复现

通过 `ConverterFactory.create(ANTHROPIC, OPENAI)` 创建转换器，依次输入以下 Chat 工具增量。表中的对象对应 `choices[0].delta.tool_calls[0]`；续传只携带 `index`，不再携带 `id`。

| 顺序 | index | id / name | arguments |
|---|---|---|---|
| 1 | 0 | `call_a` / `A` | `{"a":` |
| 2 | 1 | `call_b` / `B` | `{"b":` |
| 3 | 0 | 不提供 | `1}` |
| 4 | 1 | 不提供 | `2}` |

随后输入 `finish_reason="tool_calls"` 和 `[DONE]`。将输出的 `input_json_delta.partial_json` 按 Anthropic block index 拼接：

```text
预期：block 0 = {"a":1}，block 1 = {"b":2}
实际：block 0 = {"a":， block 1 = {"b":1}2}
```

#### 原因与影响

代码位置：[AnthropicToOpenAIConverter.ts](../../src/util/protocolConverter/AnthropicToOpenAIConverter.ts)，`delta.tool_calls` 分支，基线约 449～500 行。

当前通过 `tc.id` 与 `currentToolCallId` 判断新工具；新工具到来时关闭当前块，后续参数增量仍写入 `contentBlockIndex`。逻辑没有使用 `tc.index` 找回原工具。

最近的块关闭修复解决了顺序输出的生命周期问题，但交错续传仍然错误：A 提前关闭且参数不完整，A 的后续片段被写入 B。客户端无法组装正确工具参数，存在 JSON 解析失败或工具执行参数错误的风险。

#### 修复建议与验收

维护 Chat tool index 到 Anthropic block 的稳定映射，独立保存每个工具的 ID、名称、参数及关闭状态。若目标客户端要求顺序块生命周期，应缓存交错片段后顺序输出，不能通过切换“当前工具”实现关联。

验收至少覆盖 A/B 交错续传、同一 chunk 内多个工具、续传不含 ID、文本后开始工具，以及工具先后结束。断言参数完整且不串块，每个 block 只关闭一次，关闭后不再发送该块的增量。

<a id="pc-003-b"></a>

### 3.3 PC-003-B：Responses → Chat 工具索引——待修复，P2

#### 触发条件与复现

通过 `ConverterFactory.create(OPENAI, RESPONSES)` 创建转换器，Responses 流先创建 reasoning（`output_index=0`），再创建 message（`output_index=1`），最后创建第一个 function_call（`output_index=2`），并发送其参数增量。

实际输出的 Chat 工具增量使用 `index=2`。串接 `OpenAIChatAccumulator` 后，`tool_calls` 有三个元素：

```json
[
    { "function": { "arguments": "" } },
    { "function": { "arguments": "" } },
    { "id": "call_a", "type": "function", "function": { "name": "A", "arguments": "{\"a\":1}" } }
]
```

预期只有一个完整工具项，第一个工具的 Chat 索引为 0。

#### 原因与影响

代码位置：

- [OpenAIToResponsesConverter.ts](../../src/util/protocolConverter/OpenAIToResponsesConverter.ts)，工具创建约 314 行、参数增量约 369 行，直接使用 `data.output_index`。
- [openaiChatAccumulator.ts](../../src/util/accumulator/openaiChatAccumulator.ts)，`tool_calls` 累积分支按 index 扩展数组并补齐空项。

Responses output index 统计全部输出项，Chat tool index 只统计工具，两个索引不能直接等同。当前客户端增量包含不连续工具索引，网关累积结果产生没有 ID / 名称的空工具项。不同客户端如何处理稀疏索引尚未逐一验证，本地归档结构错误已确认。

#### 修复建议与验收

为 function_call 单独分配从 0 开始的连续 Chat tool index，维护 output_index / item_id 到该索引的关联，工具创建和参数增量共用同一映射。

验收覆盖 reasoning / message 后出现工具、多个工具、不同输出类型交错，以及参数续传。同时检查转换事件和 Chat 累积结果，确保没有空工具项，工具 ID、名称和参数归属一致。

<a id="pc-009"></a>

## 4. PC-009：思考凭据来源与完整往返——部分修复

### 4.1 已实现的保护与适用范围

[protocolConverterUtil.ts](../../src/util/protocolConverter/protocolConverterUtil.ts) 已实现 `sealThinkingSignature` / `unsealThinkingSignature`。封包载荷包含版本、来源协议、可选模型、原始 thinking 和 signature，附带 HMAC；请求恢复检查完整性和来源协议，在双方提供模型时比较模型名。

请求方向已停止把不兼容的裸签名 / 密文直接改名交给目标协议：Responses → Anthropic 要求能解出的 Anthropic 来源封包；Anthropic → Responses 要求能解出的 Responses 来源封包。不合法封包或不匹配协议 / 模型会在本地返回 400。模型字段在载荷中仍是可选值，不能将当前实现描述为无条件绑定完整路由身份。

非流式 Anthropic thinking → Responses reasoning 已封包签名和原始 thinking；非流式 Responses reasoning → Anthropic thinking 在有摘要时也封包密文。相关回归见 [thinkingAndSeals.test.ts](../../tests/unit/protocolConverter/thinkingAndSeals.test.ts) 和 [protocolConversionFixes.test.ts](../../tests/unit/protocolConverter/protocolConversionFixes.test.ts)。这些回归没有覆盖以下四个已复现场景，PC-009 尚不能关闭。

<a id="pc-009-a"></a>

### 4.2 PC-009-A：流式 Responses 思考凭据丢失——待修复，P1

#### 触发条件与复现

通过 `ConverterFactory.create(ANTHROPIC, RESPONSES)` 创建转换器，输入正常 Responses reasoning 流：

1. `response.created`。
2. `response.output_item.added`，reasoning 项 `rs_0`、`output_index=0`。
3. `response.reasoning_summary_part.added`，`summary_index=0`。
4. `response.reasoning_summary_text.delta`，文本为 `think`。
5. `response.output_item.done`，同一项提供 `summary=[{type:"summary_text",text:"think"}]` 和 `encrypted_content="cipher"`。
6. `response.completed`，最终 output 包含该完整 reasoning 项。

实际输出中存在 thinking 文本，**没有任何 `signature_delta`**。串接 Anthropic 累积器后签名为空；客户端回传该 thinking 历史时，转换后的 Responses 输入为：

```json
{
    "type": "reasoning",
    "summary": [{ "type": "summary_text", "text": "think" }]
}
```

其中已没有 `encrypted_content`。同样的数据通过非流式 `convertResponse` 转换，则可生成封包签名并恢复出原始 `cipher`。

#### 原因与影响

代码位置：[AnthropicToResponsesConverter.ts](../../src/util/protocolConverter/AnthropicToResponsesConverter.ts)，`response.output_item.done` 分支，基线约 539～556 行。

此分支只关闭输出项关联的块，没有处理 reasoning 的 `encrypted_content`。终止事件也没有补回凭据。因此文本可展示，但依赖 opaque credential 的历史接续材料已经丢失。

这一缺陷发生在 Responses ↔ Anthropic 的可恢复包装路径，不能用 Chat 缺少原生签名通道解释。本地凭据丢失已确认；真实供应商失去凭据后的具体行为仍待验证。

#### 修复建议与验收

累积同一 reasoning 项的原始摘要和密文，在关联 thinking 块关闭前封包并输出 `signature_delta`。封包内容需要与后续恢复使用的原始材料保持对应，明确一个 reasoning 项有多个 summary part 时的表示方式，并防止 done / completed 重复发签名。

增加流式与非流式往返对照：客户端接收 thinking 和封包签名后，再次发送历史，恢复出的 `encrypted_content` 应与上游原值完全一致。覆盖多个 reasoning 项、多个摘要 part，以及 completed 仅作为最终快照的情况。

<a id="pc-009-b"></a>

### 4.3 PC-009-B：分段 thinking 签名被覆盖——待修复，P1

#### 触发条件与复现

向 `ConverterFactory.create(RESPONSES, ANTHROPIC)` 创建的转换器输入一个 thinking 块，先发送 thinking 文本 `think`，再发送两条同一 block 的增量：

```json
{ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "part1" } }
```

```json
{ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "part2" } }
```

随后正常关闭块和消息。结果如下：

| 检查位置 | 实际结果 | 预期结果 |
|---|---|---|
| Responses 最终 reasoning 封包解出的原始签名 | `part2` | `part1part2` |
| 原生 Anthropic 累积器保存的签名 | `part2` | `part1part2` |
| 下一轮恢复到 Anthropic 请求的签名 | `part2` | `part1part2` |

#### 原因与影响

代码位置：

- [ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts)，基线约 590～591 行：`item.signature = delta.signature || item.signature`。
- [anthropicAccumulator.ts](../../src/util/accumulator/anthropicAccumulator.ts)，基线约 165～167 行：直接赋值保存 `msg.delta.signature`。

两处都将增量当作完整值覆盖。即使 HMAC 封包及验签成功，也只能证明网关封包没有再次变化，无法修复封包前已被截断的上游签名。下一轮请求带回的材料已与原始签名不同，存在上游验签失败风险；真实错误响应尚未验证。

#### 修复建议与验收

按 block index 独立累积签名片段，block 结束时再完成封包。原生累积器也需要明确多个 thinking 块的签名归属，避免简单修改为全消息拼接后将不同块的凭据混合。

验收覆盖单段、多段、空片段和多个 thinking 块。分别检查客户端最终项、累积结果和下一轮请求，确认每个块的原始 thinking / signature 对应关系完整。

<a id="pc-009-c"></a>

### 4.4 PC-009-C：模型别名导致合法历史回放被拒绝——待修复，P1

#### 触发条件与复现

配置的上游请求模型名称与上游响应返回的实际名称不同，例如 `alias` 对应 `actual-version`，两轮使用同一个供应商和同一路由。

通过 `ConverterFactory.create(RESPONSES, ANTHROPIC, "alias")` 创建转换器：

1. 第一轮 Anthropic 响应返回 `model="actual-version"`、thinking `think`、签名 `native-sig`。
2. 非流式转换产生带封包 `encrypted_content` 的 Responses reasoning 项。
3. 第二轮请求仍使用配置名称 `model="alias"`，将该 output 项回传为 input。

实际：`convertRequestBody` 在本地返回 **400**，凭据校验失败。对照请求改为 `model="actual-version"` 后，可以恢复 `native-sig`。

这不是跨模型或跨供应商回放实验，而是同一路由下请求别名与响应实际名称不同的本地复现。

#### 原因与影响

相关代码：

- [ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts)，非流式封包约 359～362 行：绑定 `upstreamRes.model`；请求解封约 210～218 行：校验请求传入的 `targetModel`。
- [senderService.ts](../../src/service/senderService.ts)，约 182～189 行：协议转换前将请求模型替换为 `vendorModelName`。
- [AnthropicToResponsesConverter.ts](../../src/util/protocolConverter/AnthropicToResponsesConverter.ts)，非流式封包也使用 `upstreamRes.model`，请求恢复使用 `req.model`，存在同类名称比较边界；本轮未单独执行反向别名复现。

当前比较的是两个可能不同的模型名称字符串，缺少路由身份和别名兼容上下文。结果是第一轮正常返回，第二轮被网关自身拒绝。

补充：上述 400 来自 `create(RESPONSES, ANTHROPIC, "alias")` 直接构造转换器（此时 `requestModel` 才是客户端名）。真实 `senderService` 流程会在解封前把 `req.model` 替换成 `vendorModelName`，且 `updateModel` 写入的也是 vendor 名，因此 seal 与 unseal 在真实链路中都按 vendor 名匹配，本节的 400 主要反映转换器直连构造下的行为。响应侧 `model` 字段统一返回客户端请求名的整体问题与修复范围见 [4.7](#pc-009-model)。

#### 修复建议与验收

将稳定的供应商 / 上游模型路由身份传入转换器和封包逻辑，明确配置别名与实际响应模型的兼容关系。保留模型及来源约束，不能简单删除模型校验来解决别名问题。

验收覆盖模型名一致、别名对应实际版本名、不同模型拒绝、不同供应商拒绝、流式与非流式回放。具体绑定范围应结合真实上游接续约束确定。

<a id="pc-009-d"></a>

### 4.5 PC-009-D：仅密文 reasoning 被静默丢弃——待修复，P1

#### 触发条件与复现

通过 `ConverterFactory.create(ANTHROPIC, RESPONSES)` 创建转换器，非流式 Responses 响应只包含以下 reasoning 项：

```json
{
    "id": "rs_empty",
    "type": "reasoning",
    "summary": [],
    "encrypted_content": "opaque-cipher"
}
```

实际：转换后的 Anthropic `content=[]`，整个 reasoning 项及接续密文被丢弃。如果响应同时包含普通文本，文本仍会返回，但密文同样无法保留。

#### 原因与影响

代码位置：[AnthropicToResponsesConverter.ts](../../src/util/protocolConverter/AnthropicToResponsesConverter.ts)，reasoning 的非流式转换约 273～285 行。

只有 `thinkingText` 非空时才建立 thinking 块。可见摘要与 opaque credential 是不同材料，没有摘要不代表没有需要保留的接续信息。此场景已列在历史 PC-009 的验收要求中，当前仍未满足。

#### 修复建议与验收

为只有密文的 reasoning 定义可恢复包装方式，并验证该表示是否符合目标 Anthropic 客户端的协议和回传行为。不能直接假定空 thinking 块一定合法。如果无法支持，应明确拒绝或采用已定义的兼容策略，避免成功返回时静默丢弃凭据。

验收覆盖 `summary=[]`、摘要缺失、有摘要且有密文、有摘要但无密文，以及仅 reasoning / reasoning 与文本混合。每种情况都应断言客户端表示和下一轮恢复行为。

### 4.6 代码确认的来源、密钥与元数据边界

当前封包没有供应商 / 账号 / endpoint 身份。[ConverterFactory.ts](../../src/util/protocolConverter/ConverterFactory.ts) 只接收协议和 requestModel，[senderService.ts](../../src/service/senderService.ts) 创建转换器时也未提供上游来源上下文。同协议、同模型名称不能证明凭据对另一个具体供应商兼容，来源绑定应结合 PC-009-C 一起设计。

默认 HMAC 密钥是源码中的固定值，可由 `THINKING_SIGNATURE_SECRET` 覆盖。代码将默认机制定位为重打包完整性检查和发现意外篡改；它不能提供强客户端伪造防护。尚未验证部署环境中的自定义密钥注入，以及多进程 / 多 isolate 的实际接续行为。文档应分别说明封包完整性、路由兼容性和供应商自身验签，不能将三者等同。

另有一处已知元数据一致性边界：[ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts) 的 thinking `content_block_start` 分支，约 529 行，`output_item.added.encrypted_content` 使用初始裸 signature，而 item.done / completed 使用封包版本。初始块提供签名时，两阶段表示不一致；该行为经代码确认，没有计入六组复现。应统一按约定省略未完成凭据或输出合法包装，避免客户端误用 added 中的值。

供应商兼容性、完整往返后的真实验签、密钥部署及上述初始签名场景仍待专门验证。

<a id="pc-009-model"></a>

### 4.7 响应模型名应返回客户端请求名——代码确认，待修复

#### 现状与复现

真实调用链中，转换器响应侧使用的 `requestModel` 不是客户端请求名，而是 vendor 模型名：

- [senderService.ts](../../src/service/senderService.ts)，约 182～189 行：协议转换前将 `body.model` 替换为 `vendorModelName`。
- 同文件约 225～230 行：转换后再次解析 `upstreamBody` 的 `model`（仍为 vendor 名），`converter.updateModel(requestModel)` 写入的即该值。

因此响应方向两条路径返回给客户端的 `model` 都是上游侧名称：

| 路径 | 当前 `model` 来源 | 说明 |
|---|---|---|
| 流式 | `this.requestModel`（= `vendorModelName`） | 六个转换器的 `response.completed` / `message_delta` 等分支 |
| 非流式 | `upstreamRes.model` | 六个转换器的 `convertResponse`，如 [ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts) 约 377 行 |

当客户端请求 `alias`、路由映射到 vendor `actual-version` 时，客户端在流式与非流式下看到的都是 `actual-version`，拿不回自己请求的 `alias`。这既是响应元数据一致性问题（与 PC-010 同类），也是 PC-009-C 里"请求别名与响应实际名称不同"的根源。

#### 设计决策

统一为：**返回给客户端的 `model` 即客户端请求的模型名**（`modelConfig.name`），不随 vendor 名或 `upstreamRes.model` 变化。

#### 修复范围

1. [senderService.ts](../../src/service/senderService.ts)：把 `converter.updateModel(...)` 的入参从"转换后解析出的 vendor 名"改为 `modelConfig.name`（客户端请求名）。
2. 六个转换器非流式响应的 `model: upstreamRes.model` 统一改为 `this.requestModel`。
3. 非流式封包绑定 `{ model: upstreamRes.model }`（[ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts) 约 362 行、[AnthropicToResponsesConverter.ts](../../src/util/protocolConverter/AnthropicToResponsesConverter.ts) 约 282 行）统一改为 `this.requestModel`。

#### 联动与边界

封包 round-trip 目前依赖 seal 与 unseal 都用 vendor 名才匹配：unseal 在 `convertRequestBody` 里查 `req.model`，该值已被 senderService 替换为 vendor 名。若只把 seal 改为客户端名、unseal 仍查 vendor 名，下一轮回放会开始报 400。因此 unseal 侧必须同步改为校验客户端名——要么在解封前不替换 model，要么把客户端名单独传入解封逻辑。这再次印证转换器需要稳定的"客户端模型名 / 上游模型名 / 路由身份"上下文，不能只靠一个被替换过的 `requestModel`。

统一为客户端名后，响应与封包不再反映上游实际模型名，"来源绑定"（供应商 / 账号 / endpoint 身份）仍按第 4.6 节作为独立缺口处理。

<a id="pc-012"></a>

## 5. PC-012：请求历史中的思考丢弃 / 降级——待确定策略

本项发生在请求方向，客户端将上轮推理作为历史重新提交。当前字段行为已由代码确认，未计入六个本地复现场景：

| 请求方向 | 当前行为 | 代码位置 |
|---|---|---|
| Chat → Responses | assistant 的 `reasoning_content` 未读取，普通 content / tool_calls 保留 | [OpenAIToResponsesConverter.ts](../../src/util/protocolConverter/OpenAIToResponsesConverter.ts) 的 `convertRequest` |
| Responses → Chat | reasoning input item 被显式跳过 | [ResponsesToOpenAIConverter.ts](../../src/util/protocolConverter/ResponsesToOpenAIConverter.ts) 的请求 reasoning 分支 |
| Chat → Anthropic | `reasoning_content` 生成没有 signature 的 thinking 块 | [OpenAIToAnthropicConverter.ts](../../src/util/protocolConverter/OpenAIToAnthropicConverter.ts)，约 64～68 行 |
| Anthropic → Chat | thinking 变为 `reasoning_content`，原始 signature 丢失 | [AnthropicToOpenAIConverter.ts](../../src/util/protocolConverter/AnthropicToOpenAIConverter.ts) 的 assistant 请求分支 |

Chat → Anthropic 当前会生成：

```json
{ "type": "thinking", "thinking": "历史推理摘要" }
```

Chat 缺少原生签名 / 密文通道，展示摘要不能通过改名变成可验证的接续凭据。应选择拒绝、文本降级或按声明丢弃的策略，优先处理无签名 thinking 块。该块存在真实上游拒绝风险，具体是否返回 400 尚未调用供应商验证。

Responses ↔ Anthropic 已有受限的封包往返机制，但仍存在第 4 节的问题，不能继续写成“既不丢也不误用”。

验收应分别断言四个请求方向：摘要如何处理、原始凭据是否支持恢复、不支持时是否按声明处理；不应发送冒充原生接续材料的无签名 thinking。

## 6. 已修复条目的当前实现与正确结果

本节压缩保留修复前问题及当前证据。旧版本错误输出是历史对照，当前任务列表仅包含第 3～5 节的未完成工作。除另有标注，测试依据为 [protocolConversionFixes.test.ts](../../tests/unit/protocolConverter/protocolConversionFixes.test.ts) 的对应 PC 场景。

<a id="pc-001"></a>

### 6.1 PC-001：用量口径、缓存及分段合并——已修复

共享 [protocolConverterUtil.ts](../../src/util/protocolConverter/protocolConverterUtil.ts) 保存原始 usage，逐字段合并，缺失字段保留旧值，显式 0 更新旧值；目标协议字段在合并后派生。当前网关约定的输入总量包含缓存读取，Anthropic 非缓存 input 映射到 Chat / Responses 时加回 cache read，`total_tokens = 输入总量 + 输出量`。

| 场景 | 修复前问题 | 当前正确结果 / 回归断言 |
|---|---|---|
| Chat → Responses：prompt 100、cached 90、output 5 | total 被重复加缓存，得到 195 | input 100、cached 90、output 5、total 105 |
| Anthropic → Responses：input 10、cache read 90、output 5，流式及非流式 | input 总量仍为 10，非流式缓存明细缺失 | input 100、cached 90、output 5、total 105 |
| Anthropic → Chat：缓存只在 message_start 提供 | 最终缓存丢失，prompt / total 偏小 | prompt 100、cached 90、output 5、total 105 |
| Chat → Anthropic：prompt 先到，cached 明细后到 | 非缓存 input 未重算，错误保留为 100 | input 10、cache read 90、output 5 |

[usageUtil.ts](../../src/util/protocolUtil/usageUtil.ts) 的 `UpstreamUsageCollector` 已在转换前收集原始上游用量。[responseHandlerService.ts](../../src/service/responseHandlerService.ts) 的 `settleStreamResult` 优先按原始 `upstreamUsage` 和 `upstreamFormat` 归一化计费，上游没有用量时才回落到客户端累积器的统一用量。客户端累积器仍负责客户端响应归档和完整性判断，原始用量收集不替代终止 / 错误判定。

现有联合回归对非缓存输入 10、缓存读取 90、输出 5，使用每百万 token 输入 10 元、缓存读取 1 元、输出 20 元，正确费用为 **0.00029 元**。旧版本地错误计算的 0.00019 元属于修复前证据，不能作为当前扣费结论；未执行真实余额扣减。

缓存写入仍按 [billing_usage_accounting_design.md](../design/2026-08-22-billing-usage-unify/billing_usage_accounting_design.md) 约定仅记录、不参与当前三档价格计费。各目标协议可表示的客户端缓存明细与原始上游计费用量应分别检查，不能把未收取缓存写入费用当作本轮新缺陷。

<a id="pc-002"></a>

### 6.2 PC-002：合法终止、incomplete 与尾随 usage——已修复

修复前，usage 到达即可触发 completed，后续内容可能重新创建 response；Chat length / Anthropic max_tokens 被当成 completed，原生 Responses 累积器忽略 incomplete。

当前实现：

- Chat → Responses 的 usage 只合并用量；`finish_reason` 保存结束证据，在 `[DONE]` 或已有 finish 的干净 EOF 时收尾，终止标记保证幂等，并接收尾随 usage。
- Chat `length` / Anthropic `max_tokens` 映射为 Responses incomplete，保留 `max_output_tokens` 原因；Responses incomplete 可转换为 Chat length / content_filter，或 Anthropic 对应停止原因。
- 原生 [responsesAccumulator.ts](../../src/util/accumulator/responsesAccumulator.ts) 保存 incomplete 快照并标记协议流完成，保留已有内容及 usage；failed / error 仍走失败路径。

合法 incomplete 表示流按协议结束但生成被截断，与缺少终止证据的断流不同。相关回归包括中间 usage、后续内容、尾随缓存、length、Anthropic max_tokens、原生 incomplete 和幂等 EOF。真实转发 / 记录 / 余额场景需要按集成或 API 测试分类验收，不能仅以转换器断言替代。

<a id="pc-004"></a>

### 6.3 PC-004：多轮工具调用历史——已修复

修复前，`call_1 → result_1 → call_2 → result_2` 被折叠为一条 assistant 的两个调用，再跟一条 user 的两个结果，依赖关系丢失。

当前 [ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts) 只收集连续的调用或连续的结果，在阶段变化时 flush。回归断言输出角色顺序为 `assistant → user → assistant → user`。一轮并行调用、结果后普通 user 文本及中间 assistant 内容仍应保留在后续回归矩阵中。

<a id="pc-005"></a>

### 6.4 PC-005：非流式多段文本与推理——已修复

修复前，Responses → Chat 逐项赋值导致只保留最后一段文本 / reasoning。当前 [OpenAIToResponsesConverter.ts](../../src/util/protocolConverter/OpenAIToResponsesConverter.ts) 按顺序收集 `messageTexts` / `reasoningTexts`：同一 message 内 text part 直接拼接，跨 message / reasoning 项用换行连接。

回归用 `first`、`second` 两个文本 part 得到 `firstsecond`，两个 reasoning 项 `r1`、`r2` 得到 `r1\nr2`，工具调用仍单独保留。本项不代表 Chat 历史 reasoning 请求转换已经支持，后者见 PC-012。

<a id="pc-006"></a>

### 6.5 PC-006：累积字段、最终快照与 getText——已修复

原列举缺陷包括：Anthropic → Responses 的最终 output 遗漏 reasoning；Responses 累积器不保存 summary / encrypted_content 或 function_call 的 name / call_id / arguments；`getText()` 假设第一项有 content，在 reasoning 位于首项时抛错。

当前转换器使用同一有序 `outputItems` 生成 item.done 与 completed / incomplete，保留 reasoning 和工具项。[responsesAccumulator.ts](../../src/util/accumulator/responsesAccumulator.ts) 按输出类型建模，处理摘要、工具参数的 delta / done，合并 item 最终字段；`getText()` 仅读取 message 且验证 content 数组。

相关回归同时检查 completed 前的增量状态、工具字段、最终快照和仅 reasoning 时的安全文本读取。完整 completed output 的原样保存与增量字段累积是两个验证层次，当前实现已补齐增量及中间读取。分段签名覆盖另归 PC-009-B，不重复统计为一个 PC-006 待办。

<a id="pc-007"></a>

### 6.6 PC-007：系统指令和 token 上限——已修复

修复前，Chat developer 被丢弃、Responses 多条系统指令只保留第一条、Chat 两条转换路径未采用一致的现代 token 上限优先级。

当前 Chat → Responses 保留 developer 原生角色；转 Anthropic 时有序汇总 system / developer，Responses 的 instructions 与系统类 input 一并保留。Chat 上限优先读取 `max_completion_tokens`，再读 `max_tokens`。两者为 17 和 100 时，目标上限为 17；零上限的回归明确断言拒绝，避免 `||` 把 0 当缺失后替换为默认值。

回归对 Responses `instructions="top"`、developer `second`、system `third` 得到 `top\n\nsecond\n\nthird`。后续应持续覆盖各字段单独出现及混合出现时的指令顺序与约束。

<a id="pc-008"></a>

### 6.7 PC-008：显式禁用工具——已修复

修复前，带 tools 的 Chat / Responses `tool_choice="none"` 转为 Anthropic 时遗漏约束。当前生成 `{ "type": "none" }`，反向 Anthropic → Chat / Responses 映射为 `"none"`，协议类型已覆盖该选项。

回归使用实际带 tools 的请求检查约束，历史“none 时应为 undefined”的断言不再是验收标准。具体兼容供应商对 none 的支持仍未逐一调用验证，应按目标能力确定兼容策略。

<a id="pc-010"></a>

### 6.8 PC-010：响应元数据及输出项 ID——已修复

修复前，Responses → Chat 的首 chunk 和后续 chunk 使用不同 ID / model，Anthropic → Responses 非流式同类型多个项重复使用 ID。

当前从 response.created 保存上游 ID / model，后续 Chat chunk 复用；非流式输出项采用独立 item 序号，回归断言多个 text / thinking 项 ID 不重复。此处是响应元数据一致性修复，凭据恢复中的模型别名问题仍见 PC-009-C。

<a id="pc-011"></a>

### 6.9 PC-011：Chat 非流式转 Anthropic 缓存口径——已修复

通过 `ConverterFactory.create(ANTHROPIC, OPENAI)`，输入 Chat usage：prompt 100、cached 90、completion 5。当前非流式输出为 `input_tokens=10`、`cache_read_input_tokens=90`、`output_tokens=5`，与同一完整 usage 的流式转换一致。缓存字段缺失与显式 0 保持区别，使用与 PC-001 相同的共享映射。

修复前错误主要影响客户端响应与归档 `response_data`，当时网关非流式计费仍从原始上游 usage 提取；不能将旧客户端字段错误推断为实际费用翻倍。本轮确认该客户端转换已修复，没有执行真实余额实验。

## 7. 仍需同步的协议说明文档

以下内容经当前分支代码对照确认过时，不计入六个代码复现场景；本清单已改用该分支实际存在的链接。

| 文档位置 | 当前文档问题 | 应按实现调整 |
|---|---|---|
| [MessageFormatConversion.md](../protocol/MessageFormatConversion.md)，约 543～549 行及第 7 节 | 图示 / 文字仍将客户端 Accumulator 同时作为记录、计费来源 | 补独立原始上游 usage 收集分支，说明按 upstreamFormat 优先结算及无 usage 时回落到累积器的条件 |
| [ResponsesAPIConversion.md](../protocol/ResponsesAPIConversion.md)，约 230 行 | reasoning 的 encrypted_content 仍被描述为直接映射成 Anthropic signature | 区分原生密文与网关恢复凭据，说明封包、协议 / 模型检查、裸材料拒绝，以及 PC-009 尚未完成的边界 |

## 8. 验证记录与未验证范围

### 8.1 当前基线及既有回归证据

| 验证 | 基线 / 结果 |
|---|---|
| 最新开发分支的六组边界复现 | `1.9_dev` / `4a7a16e`：复核及本次合并时均执行，6 组断言确认第 2.2 节的错误行为仍存在 |
| TypeScript 检查 | `1.9_dev` / `4a7a16e`：`npm run backend:test:type` 通过 |
| 协议转换器、累积器及 usageUtil 的选定 Node 套件 | master / `d35438a`：20 个文件、431 个用例全部通过；与当前基线相关源码 / 测试 / 依赖无差异，开发分支未重复运行该套件 |
| 测试生命周期 | 上述选定套件正常 teardown，测试数据库清理、相关端口释放 |
| 本次文档合并 | 对照当前实现和回归断言，检查合并后的编号、链接、格式及内容归属；不作为新增业务测试或代码修复 |

选定套件及类型检查的项目命令：

```sh
npm run backend:test:node -- tests/unit/protocolConverter tests/unit/util/accumulator tests/unit/util/protocolUtil/usageUtil.test.ts
npm run backend:test:type
```

初次选定 Node 测试使用 Node v24.3.0，与本机已安装的 better-sqlite3 原生模块兼容，生命周期按项目 global setup / teardown 执行。当前文档合并没有业务代码变化，不重复启动同一套本地服务测试。

六组临时脚本断言确认的是当前错误输出，不是修复后的正确行为验收，也没有加入正式测试目录。输入、实际和预期结果已写入第 3～4 节，后续正式回归不应依赖本地临时脚本。

### 8.2 历史证据的适用范围

v1.9.0 审查基线为 `1ceef94034502654a00abce4b23d66e54e1ea138`，协议代码沿用 `5dc3ad16580245bf8f7061c38cb44b2059c91bc2`。当时全量 Node 测试 108 个文件、1226 个用例以及类型检查、前端构建通过，但未覆盖旧缺陷。

该历史审查先记录 15 组转换复现，补充后为 16 组，另有累积器和计费函数验证；后续一次脚本检查记录 24 组行为，包含重复验证，不能与前述数量相加，也不等于新增正式测试。这些结果仅用于追溯旧缺陷，不表示当前分支已完成全量验收。

历史文档中尚未更新的测试断言清单已被当前对应回归取代。后续应维护正确协议结果作为断言，并增加本清单剩余边界，不能继续按旧版错误输出验收。

### 8.3 尚未执行的验证

- 当前基线的后端全量 Node 测试、Worker 测试和前端构建。
- 真实供应商签名校验、密文兼容性、同路由别名及多轮接续接口调用。
- 真实请求落库、费用对照与余额扣减实验。
- 各客户端对稀疏工具索引、仅密文 reasoning 表示及初始裸签名元数据的具体处理。

本轮没有复现新的费用计算或余额扣减错误，也没有以“测试通过”证明上述未验证项已经完成。

## 9. 后续修复与完成标准

### 9.1 建议批次

1. **工具关联**：PC-003-A/B。按源工具 index / item ID 建立映射，工具增量和累积结果联合验证。
2. **凭据完整传递**：PC-009-A/B/D。覆盖流式 / 非流式、多个块、多个签名片段及仅密文处理。
3. **来源及模型兼容**：PC-009-C、第 4.6 节及第 4.7 节。确定稳定路由身份、别名映射、密钥配置及不兼容来源拒绝规则，统一响应 `model` 返回客户端请求名，补可信上游验签。
4. **历史摘要策略**：PC-012。明确四个方向的拒绝、文本降级或按声明丢弃行为。
5. **文档与回归同步**：修正第 7 节的说明，剩余边界加入正式回归，再执行项目要求的提交前检查。

### 9.2 剩余验收清单

- [ ] PC-003-A：A/B 交错参数完整且不串块，内容块按约定关闭，关闭后没有增量。
- [ ] PC-003-B：Chat 工具索引从 0 连续分配，最终累积没有空工具项。
- [ ] PC-009-A：Responses → Anthropic 流式封包可在下一轮恢复，与非流式行为一致。
- [ ] PC-009-B：签名片段按块完整累积，原始 thinking / signature 一一对应。
- [ ] PC-009-C：同一路由别名合法回放，不兼容模型 / 来源按策略拒绝。
- [ ] PC-009-D：仅密文 reasoning 有明确且经目标协议验证的表示或拒绝策略。
- [ ] 来源 / 密钥边界明确，added / done / completed 中的凭据表示遵循同一契约。
- [ ] 响应 `model` 统一返回客户端请求名（`modelConfig.name`），流式与非流式一致，不随 vendor 名或 `upstreamRes.model` 变化。
- [ ] PC-012：Chat 历史摘要按声明处理，不冒充可验证的原生 thinking 凭据。
- [ ] 六个剩余场景加入正式测试，分别断言客户端事件、累积结果和下一轮请求。
- [ ] 合法 incomplete、真实断流、原始上游用量和响应归档保持既有正确行为。
- [ ] 协议说明同步当前计费及封包规则，真实供应商结果与本地证据分别记录。

修改转换器后，应保持现有协议及累积器单元回归，增加转换器 → 累积器联合验证；转发、记录和余额验收按 [TestManual.md](../dev/TestManual.md) 放入集成 / API 测试。用户授权提交时，按项目规范执行 `npm run backend:test:node`、`npm run backend:test:type` 和 `npm run frontend:build`；Worker 模式交由 CI。本文不执行提交。

## 10. 能力与维护边界

六个工厂分支存在，不表示每个协议字段或供应商扩展都已覆盖。后续记录应明确请求、非流式、流式增量 / done / 终止、客户端归档及原始用量各层的证据。

`input_file` 当前在相关跨协议内容转换中明确返回 400；内置工具、previous_response_id 等能力应按实际目标协议及供应商支持范围维护，不在本文推断为全部支持。已实现的图片转换、工具图片处理和无效图片明确报错不列为剩余缺陷。

后续修改本清单时，以当前提交和正式验收更新状态，保持 PC 编号稳定；已修复项更新正确行为及证据，未完成项保留最小复现、影响和验收要求。
