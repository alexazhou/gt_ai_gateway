# 转 Anthropic 请求的缓存标记补全方案

## 1. 方案状态与基线

| 项目 | 内容 |
|---|---|
| 整理日期 | 2026-11-16 |
| 仓库 / 分支 | `gt_ai_gateway` / `1.9_dev` |
| 代码基线 | `4a7a16e12ecbac3ea5c20620947727b63545f3fe` |
| 状态 | **讨论方案，尚未实现** |
| 实现方式 | 直接在转换器生成 Anthropic 请求后补全缓存标记，复用一个公共工具函数 |
| 适用路径 | OpenAI Chat Completions → Anthropic；OpenAI Responses → Anthropic |

本文整理当前实现和建议方案，没有修改业务代码，也没有执行真实供应商缓存验证。断点优先级、源请求扩展字段及兼容供应商支持需要在实现时按本文边界确认。

## 2. 当前实现

当前两个请求转换器都重新构造 Anthropic 请求，**没有自动添加 `cache_control`**：

| 路径 | 当前代码 | 当前行为 |
|---|---|---|
| Chat → Anthropic | [OpenAIToAnthropicConverter.ts](../../src/util/protocolConverter/OpenAIToAnthropicConverter.ts)，`convertRequest` | system 为汇总后的字符串，messages / tools 重新构造；没有生成缓存断点 |
| Responses → Anthropic | [ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts)，`convertRequest` | instructions 和系统类 input 汇总为 system，消息和工具重新映射；没有生成缓存断点 |

同名的客户端兼容扩展字段目前也没有被这些重建逻辑显式保留。[anthropicTypes.ts](../../src/util/protocol/anthropicTypes.ts) 的 system、工具和内容块类型尚未声明缓存控制字段。

现有 [pluginService.ts](../../src/service/pluginService.ts) 的 Anthropic 分支处理追踪标记移除和 CCH 文本重写；这些处理没有添加缓存断点。Responses 插件注入的 `prompt_cache_key` 也没有被映射为 Anthropic 的缓存标记。

此前 [protocol_conversion_issues.md](./protocol_conversion_issues.md) 中 PC-001 / PC-011 的修复负责正确统计和转换上游返回的缓存用量；本方案负责请求侧的缓存标记。

## 3. 目标与范围

建议第一版为两条转 Anthropic 的请求路径默认补充显式缓存断点，覆盖工具定义、系统提示词和本轮完整输入前缀，提高后续请求复用稳定前缀的机会。

实现限定为：

- 在两个 `convertRequest` 完成请求构造后、返回前调用同一段公共逻辑。
- 自动补全使用 `cache_control: { "type": "ephemeral" }`。
- 不显式设置 `ttl`，使用目标协议默认短期缓存；第一版不增加 TTL 配置和复杂策略。
- 保持已有工具定义、消息顺序、文本、图片、工具结果及 thinking / signature 内容。
- 对已有合法标记保留原位置和设置，自动补全遵守断点总数限制。

直接发送 Anthropic 格式的同协议透传请求不属于本次新增补全范围。实际缓存由上游负责，网关不为此保存本地响应缓存。

## 4. 建议断点规则

### 4.1 三个候选位置

| 区域 | 自动标记位置 | 缓存目的 |
|---|---|---|
| `tools` | 最后一个工具定义对象 | 缓存稳定的工具定义前缀 |
| `system` | 最后一个可标记的 system 文本块 | 缓存系统提示词及其之前的内容 |
| `messages` | 最后一条 user 消息中最后一个可标记的内容块 | 为截至该位置的完整输入前缀建立缓存，供后续轮次复用 |

缓存断点作用于**截至该位置的输入前缀**，不是仅缓存被标记的一个块。工具定义和系统提示词通常较稳定，消息断点随对话推进到最后一条 user 消息，便于下轮复用此前输入。

三处都存在且没有已有标记时，最多自动新增三个断点。只存在部分区域时，仅对存在且可标记的区域补全。

### 4.2 字符串与内容块

字符串不能直接附加块级字段，补全前需要规范化目标位置：

- system 字符串转换为一个 text 块组成的数组，原文本保持不变。
- 最后一条 user 的非空字符串 content 转换为一个 text 块组成的数组。
- 已经是内容块数组时保留块的顺序及字段，只在选中的块上增加标记。
- 空 system、空 content、空工具列表不生成占位文本或无意义断点。

只规范化需要加标记的位置，避免为缓存处理改写其他历史消息的表示。

### 4.3 工具结果与 thinking

Anthropic 的工具返回是 user 消息中的 `tool_result` 块，因此消息规则同时覆盖普通提问和工具结果回传。

建议在最后一个合适的 `tool_result` 外层块上设置标记，保持其 `tool_use_id`、content 字符串 / 内容数组及图片数据不变。多个工具结果的顺序和前置 assistant 工具调用必须保持原样。

可标记内容类型以目标协议确认的 text、image、tool_result 等为准，第一版只处理已确认支持的位置。**不直接给 thinking 块增加 `cache_control`**，不改其明文或 signature，也不为寻找缓存位置重新排序内容。

如果最后一条 user 消息没有可标记块，则跳过消息断点；仍可补全工具和系统区域。请求以 assistant 预填内容结束时，本方案仍选择最后一条 user，不自动标记末尾 assistant。

### 4.4 已有标记、数量预算与幂等

建议按 Anthropic 显式缓存断点的总数上限处理，第一版按最多四个断点设计；实现前确认目标接口及兼容供应商的实际限制。

补全过程建议如下：

1. 统计协议允许位置中已有的标记，并保留其原值。
2. 候选位置已有合法标记时不重复添加、不覆盖 TTL 等设置。
3. 没有足够剩余预算时，建议按“消息断点 → system → tools”的顺序补充；这是有限预算时的第一版建议优先级。
4. 已有合法标记已占满预算时不再添加。已有标记非法或超过目标上限时，应明确拒绝，避免静默删除客户端配置。
5. 同一个请求重复调用补全逻辑，结果应相同，不增加新断点或重复包裹 text 数组。

统计时只检查协议支持的缓存字段位置。工具 JSON Schema、工具入参、工具结果业务 JSON 或文本中的同名 `cache_control` 不应被当作断点。

Chat / Responses 标准字段与 Anthropic 块级标记没有直接等价关系，不能把 `prompt_cache_key` 简单改名为断点。若第一版接受客户端明确提供的 Anthropic 兼容扩展标记，转换阶段必须显式映射并验证这些字段，再由公共逻辑补全；仅在最终请求上调用函数无法找回转换时已丢弃的字段。扩展字段支持范围需要实现前明确。

## 5. 转换后请求示例

下面展示建议补全后的 Anthropic 请求形状，**不是当前代码已经生成的结果**。示例有工具、system 和普通 user 消息，共三个断点：

```json
{
    "model": "claude-model",
    "max_tokens": 1024,
    "tools": [
        {
            "name": "lookup",
            "description": "查询指定条目",
            "input_schema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string" }
                },
                "required": ["key"]
            },
            "cache_control": { "type": "ephemeral" }
        }
    ],
    "system": [
        {
            "type": "text",
            "text": "系统提示词",
            "cache_control": { "type": "ephemeral" }
        }
    ],
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "用户当前问题",
                    "cache_control": { "type": "ephemeral" }
                }
            ]
        }
    ]
}
```

## 6. 代码落点建议

| 文件 | 建议职责 |
|---|---|
| [OpenAIToAnthropicConverter.ts](../../src/util/protocolConverter/OpenAIToAnthropicConverter.ts) | 原有 Chat 请求映射结束后，调用缓存标记公共函数 |
| [ResponsesToAnthropicConverter.ts](../../src/util/protocolConverter/ResponsesToAnthropicConverter.ts) | 原有 Responses 请求映射结束后，调用同一函数 |
| [protocolConverterUtil.ts](../../src/util/protocolConverter/protocolConverterUtil.ts) | 提供同步补全函数，处理候选位置、字符串规范化、已有标记、数量预算和幂等性 |
| [anthropicTypes.ts](../../src/util/protocol/anthropicTypes.ts) | 为工具、system 和受支持内容块补充缓存控制类型，明确 thinking 不作为自动标记位置 |

公共逻辑不承担格式转换、路由选择或计费职责，不读取数据库配置，按照项目默认导出规范在转换器中直接调用。核心规则只维护一份，两个转换器不分别实现断点选择。

既有请求插件继续按现有顺序处理最终请求，本功能不通过插件注册或配置开关接入。应检查已有 system 文本重写逻辑对数组表示的兼容性。

## 7. 兼容性、命中与计费边界

### 7.1 支持范围

第一版以目标上游支持 Anthropic 显式 Prompt Caching 为前提。兼容供应商是否接受相关字段、块类型及数量限制，需在实现前确认；不能以“支持 Anthropic 消息格式”推断其全部缓存能力都相同。

本方案没有新增供应商能力配置。如果存在不接受这些字段的实际路由，应先明确适用范围，再确定是否需要最小的路由约束，避免把未验证的兼容行为写成已支持。

### 7.2 标记不保证命中

缓存命中还取决于上游要求的最小长度、缓存有效期、账户 / 路由范围，以及后续输入是否保持相同前缀。动态 system 文本、变化的工具定义、历史裁剪等会改变前缀。

第一版不在网关估算最小缓存 token 长度，也不生成额外随机标识。缓存是否写入和命中，以目标上游返回的真实 usage 为准。

### 7.3 用量记录与价格策略

新增标记后，应继续从原始上游 usage 读取 `cache_creation_input_tokens` 和 `cache_read_input_tokens`，保持 [protocol_conversion_issues.md](./protocol_conversion_issues.md) 中已经修复的用量口径及结算链路。

网关当前按 [billing_usage_accounting_design.md](../design/2026-08-22-billing-usage-unify/billing_usage_accounting_design.md) 的约定记录缓存写入，不单独收取缓存写入费用；模型价格仍为 input / output / cache_read 三档。本方案没有修改该价格策略，上游实际收费与网关计价需要分别理解。

## 8. 验收与任务清单

### 8.1 关键测试场景

| 场景 | 预期 |
|---|---|
| Chat 的 system 字符串和 user 字符串 | 转为 text 块并加标记，文本逐字一致 |
| Responses 的 instructions、function tools 和 user input | 与等价 Chat 请求使用相同的三个候选位置 |
| 多条 system / developer 指令 | 原有汇总顺序不变，在最终 system 块加标记 |
| 文本 / 图片混合消息 | 内容顺序和图片字段保持不变，在最后可标记块加标记 |
| 多个工具结果回传 | tool_use_id、结果内容及调用 / 结果轮次不变，标记所选 tool_result 外层块 |
| 历史存在 thinking / signature | 不增加 thinking 缓存字段，不改原始凭据 |
| 空 system、空内容、无工具 | 不生成占位块和无意义标记 |
| 候选位置已有合法标记 | 保留位置和设置，按剩余预算补充 |
| 已有标记占满或超过上限 | 占满时不新增；非法 / 超限按选定校验规则明确处理 |
| 工具 schema / 业务数据包含 cache_control | 不误统计为协议断点 |
| 同一请求重复补全 | 输出幂等，标记数量及内容不变化 |
| 真实支持缓存的上游 | 请求被接受，读取实际写入 / 命中 usage；不同轮次与最小长度条件分别验证 |

### 8.2 实施任务

- [ ] 确认目标上游支持的缓存位置、数量及默认有效期。
- [ ] 明确客户端兼容扩展标记的接收 / 保留范围。
- [ ] 增加 Anthropic 缓存控制类型和公共补全函数。
- [ ] 两个转换器直接调用，保持原有请求约束和内容。
- [ ] 验证字符串规范化、工具结果、已有标记预算及幂等性。
- [ ] 补转换器回归和上游请求体检查，确认插件后最终发送的标记仍有效。
- [ ] 在可信上游环境验证请求接受、写入 / 命中 usage 和后续前缀复用。
- [ ] 实施后更新方案状态与验证基线，按项目规范执行提交前检查。

当前上述任务均未作为本次文档工作实施。文档中的请求示例和验收预期是设计目标，不是实际缓存命中证据。
