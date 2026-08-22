> 📋 变更专项设计：方案已拍板，待实施。目标「计费 usage 归一化（`SgRecord.usage` 按类存储）+ responseHandlerService 去重」。历史数据采用**方案 B**：`SgRecordUsage` 改为 Sutando 自定义 cast 类（参照 `SgVendorConfig`），类字段带存储版本号 `usage_version`，`toJSON()` 读侧按版本输出展示口径，不迁移存量。决策见 §3、§7。

# 计费 usage 归一化 + responseHandlerService 去重设计

## 1. 背景与问题

`src/service/responseHandlerService.ts`（612 行）包含 4 个响应处理函数，存在两对明显重复；对它们的收敛分析进一步暴露了计费 usage 的统计口径不一致。

### 1.1 responseHandlerService 的重复

| 重复位置 | 当前形态 |
|---|---|
| 两个非流式 handler（`handleChatNonStreamResponse` / `handleResponsesNonStreamResponse`） | 各 ~99 行，逻辑逐行一致，仅日志前缀与 `needsConversion` 判定方式不同 |
| 两个流式 handler（`handleChatStreamResponse` / `handleResponsesStreamResponse`） | SSE 消费循环（读流 → decode → splitEvents → parseEvent → convert → writeSSE）~110 行重复 |
| runInBackground 收尾逻辑 | 四分支中「请求中断 / 上游错误 / 流不完整」三个失败分支 100% 相同（~45 行重复两遍） |

### 1.2 计费 usage 的四点不一致

1. **解析器有两个**：`usageUtil.normalizeUsage(format, raw)` 与 `usageUtil.buildStreamUsageAccounting` 的 else 分支语义重叠，维护成本高、易漂移。
2. **落库 schema 不一致**：Anthropic 流式存原始累积 dict（含 `cache_write_tokens` 键），Anthropic 非流式存 SgRecordUsage（`cache_creation_tokens` 键）——同一协议两条路径字段名都对不上。
3. **accumulator 输出两种方言**：chat/anthropic accumulator 吐 OpenAI 键（`prompt_tokens` 等），responses accumulator 吐 Responses 键（`input_tokens` 等），消费方需各自处理。
4. **口径隐性**：「`prompt_tokens` 含不含缓存」在各路径靠巧合而非约定统一（详见 §3.2）。

## 2. 第一性原理：唯一性不变式

计费的本质：一次请求 = 一笔账，只关心「按价格档位各消耗多少 token、扣多少钱」。协议（OpenAI / Anthropic / Responses）只是同一个经济事实的三种**方言**。

> **唯一性不变式**：每个请求只产生**一份** token 记账（协议无关）；这份记账由**唯一一处**解析生成；由**唯一一个**函数定价；以**唯一一种** schema 落库。协议差异只允许存在于解析器边界以内——出了解析器，系统里就没有"格式"。

对应分层：

```
协议方言(raw usage) ──parser──▶ 统一记账 ──pricer──▶ cost
                                       └──JSON──▶ 落库 SgRecordUsage
```

## 3. 已拍板的语义决策

### 3.1 合并「计算模型」与「持久化模型」为单一结构

原设计中存在 `TokenUsage`（算账中间量）与 `SgRecordUsage`（落库 schema）两个结构。两者为**双射**（`inputTokens = prompt_tokens + cache_read_tokens`，其余字段一一对应），换算无损，因此**合并为唯一的 `SgRecordUsage`**，不再维护两套结构。

`SgRecordUsage` 参照 `SgVendorConfig` 模式改为 **Sutando 自定义 cast 类**（`extends CastsAttributes`），`SgRecord.usage` 按类读写（不再暴露字符串）——DB 列仍为 TEXT、存储串不变，读写一致性由 cast 类承担：

```ts
// @ts-expect-error Sutando .d.ts 声明 static get/set() 无参，运行时传 4 个实参
class SgRecordUsage extends CastsAttributes {
    version: number = 1;              // usage 存储版本（见 §7）：1=旧口径，2=OpenAI 总量口径
    prompt_tokens: number | null;     // 输入（内部恒为展示口径 = 非缓存输入）；缺失为 null、返回 0 为 0
    completion_tokens: number | null; // 输出；缺失为 null
    cache_read_tokens: number | null; // 命中缓存的输入（prompt_tokens 的子集）；缺失为 null
    cache_creation_tokens?: number | null; // 写入缓存（仅记录，不参与计费）；缺失为 null
    // constructor  —— 按版本完成「存储 → 展示」转换（见 §3.3），实例内部恒为展示口径
    // toJSON()     —— 直接输出内部字段，不再做版本判断；缺失值输出 null
    // toStorageJSON —— 展示 → 存储（v2 总量 + usage_version），供 set() / serializeStoredUsage 复用
    // static get   —— DB 串 → SgRecordUsage 实例（含 version 判定）
    // static set   —— 实例/对象 → 存储串
}
```

### 3.3 版本转换收敛在 constructor；各字段区分 null 与 0

- **版本口径转换只在构造时发生**：`constructor` 依据 `version` 把存储值归一为展示口径（v2 的 `prompt_tokens` 总量 → 非缓存输入 = 总量 − `cache_read_tokens`；v1 存量原样保留）。此后 `toJSON()` 直接输出内部字段，不含任何版本分支。
- **写侧反向**：`toStorageJSON()` 由展示口径还原 v2 存储串（`prompt_total = 非缓存输入 + 缓存读取`），`serializeStoredUsage` 统一走这里。
- **null 与 0 区分**：上游未返回某字段 → 存/展示为 `null`；明确返回 0 → 存/展示为 `0`。`normalizeUsage` 的计价数字仍按 `缺失 = 0` 计算扣费，与落库字段的 null 语义解耦。

### 3.2 `prompt_tokens` 口径：按 OpenAI 原生语义

统一记录里 `prompt_tokens` = **输入总量（含缓存命中）**，`cache_read_tokens` 为其子集。依据两家协议的原始语义：

| 协议 | 原生输入字段 | 是否含缓存命中 | 缓存部分字段 |
|---|---|---|---|
| OpenAI (Chat / Responses) | `prompt_tokens` / `input_tokens` | **含** | `prompt_tokens_details.cached_tokens` |
| Anthropic | `input_tokens` | **不含** | `cache_read_input_tokens` |

（该语义已由 `usageUtil.normalizeUsage` 现有实现佐证：OPENAI 分支做 `max(0, prompt − cache)` 的减法、ANTHROPIC 分支做 `input_tokens + cache_read_input_tokens` 的加法。）

口径确定的两个直接后果：

- **pricer 的 `(prompt_tokens − cache_read_tokens)` 扣减必须保留**（而非合并时"消失"）——因为 `prompt_tokens` 是总量，扣减恰好是 `calculateCost` 现有签名的原样逻辑，pricer 一行不改。
- 由此，`normalizeUsage` 各分支的 `recordUsage.prompt_tokens` 由"非缓存数"改为"总量"（详见 §4.2）。

## 4. 目标设计

### 4.1 保留且只保留一个 parser —— `normalizeUsage`

各协议原生 usage → `SgRecordUsage`（`prompt_tokens` 为总量口径）：

| 协议 | `record.prompt_tokens` | `record.cache_read_tokens` |
|---|---|---|
| OpenAI | 原生 `prompt_tokens` 直接取 | `prompt_tokens_details.cached_tokens` |
| Responses | 原生 `input_tokens` 直接取 | `input_tokens_details.cached_tokens` |
| Anthropic | `input_tokens` **+** `cache_read_input_tokens` | `cache_read_input_tokens` |

### 4.2 代码改动点

**`src/util/protocol/usageUtil.ts`**
- `normalizeUsage`：
  - OPENAI / RESPONSES 分支：`recordUsage.prompt_tokens` 由 `max(0, promptTokens − cacheReadTokens)` 改为 `promptTokens`（总量）。
  - ANTHROPIC 分支：`recordUsage.prompt_tokens` 由 `input_tokens` 改为 `input_tokens + cache_read_input_tokens`。
  - （可选）OPENAI 分支顺带补读 `cache_write_tokens` → `recordUsage.cache_creation_tokens`，统一落库键名。
- **删除 `buildStreamUsageAccounting`**。其 OPENAI 行为与 `normalizeUsage(OPENAI)` + `calculateCost` 完全一致；Anthropic else 分支被 accumulator 归一化取代（见 4.3）。

**`src/util/accumulator/*`（三者对外统一吐 OpenAI 口径的键）**
- `openaiChatAccumulator`：已符合，**不动**。
- `responsesAccumulator`：`input_tokens → prompt_tokens`、`output_tokens → completion_tokens`、`input_tokens_details.cached_tokens → cache_read_tokens`。
- `anthropicAccumulator`：`accumulateUsage` 使 `prompt_tokens = input_tokens + cache_read_input_tokens`。
  - ⚠️ 跨 chunk 合并坑：若不同 chunk 分别带 `input_tokens` 与 `cache_read_input_tokens`，现 `?? prev` 链会相互覆盖/归零。稳妥做法：在 `accumulateUsage` 里分开合并「input 基数」与「cache_read」两个量，读取/输出时再求和。

**`src/model/sgRecord.ts`（usage 按类存储，参照 `SgVendor` / `SgVendorConfig`）**
- `SgRecordUsage` 改为 Sutando 自定义 cast 类（见 §3.1）。
- `SgRecord.usage` 类型 `string | null` → `SgRecordUsage | null`；`casts` 增加 `usage: SgRecordUsage`。
- 读路径：`find/get` 时 cast `get` 自动产出实例，`toData()` / `c.json()` 序列化时自动调用实例 `toJSON()`（展示口径），`recordController.serializeRecord` **无需改动**。
- 写路径：`recordManager.update` 用裸 `query().update()` **不走 cast**，所以写侧不能依赖 `set()`——`responseHandlerService` 统一经 `usageUtil.serializeStoredUsage(recordUsage)` 产出**含 `usage_version: 2` 的存储串**再写入（`usage: null` 的失败分支不变）。

**`src/service/responseHandlerService.ts`（去重，调用方零改动）**

- 抽内部共享函数：
  - `handleNonStreamResponse(c, upstreamRes, record, model, user, options)`：收敛两个非流式 handler，`options` 携带 converter / upstreamFormat / 日志前缀。
  - `runSseLoop(c, upstreamRes, stream, opts)`：收敛 SSE 消费循环，返回 `{ accumulator, firstTokenTime, failedCode, streamErrorData }`；`opts` 携带 accumulator 工厂、converter、日志前缀。
  - `finalizeStreamResult(...)`：收敛 runInBackground 收尾。三个失败分支原样搬入；「成功」分支因 §4.2 的归一化不再需要按协议区分——统一为 `normalizeUsage(OPENAI, accumulator.getUsage())` + `calculateCost`。
- 保留 4 个公开导出的函数名作为薄封装，`senderService` 调用点不变。

**`src/util/protocolConverter/OpenAIToAnthropicConverter.ts`（顺带修复，见 §6）**
- 流式 `message_delta` 输出补 `prompt_tokens_details.cached_tokens`，不再丢失上游 Anthropic 的 cache 信息。

### 4.3 pricer 不变

`calculateCost(model, promptTokens, outputTokens, cacheReadTokens)` **签名与逻辑保持不变**（`prompt_tokens − cache_read` 的口径扣减已在内部）：

```
cost = (promptTokens − cacheReadTokens)/UNIT × input
     + cacheReadTokens/UNIT × cache_read
     + outputTokens/UNIT × output
```

`cache_creation_tokens`（缓存写入）保持「仅记录、不参与计费」——价格模型 `SgModel.prices` 仅有 input / output / cache_read 三档。

## 5. 行为变化清单

| 路径 | 落库 `prompt_tokens` 的变化 | 金额影响 |
|---|---|---|
| chat stream OpenAI | 非缓存数 → 总量 | 无（扣减移到计价端，公式不变） |
| chat stream Anthropic | 非缓存数 + 原始 dict → 总量 + SgRecordUsage schema | 无 |
| responses stream | 非缓存数 → 总量 | 无 |
| 全部 non-stream | 非缓存数 → 总量 | 无 |
| `responseHandlerService` | 结构去重，公开 API 不变 | 无 |

- 客户端契约不受影响：流式响应已实时透传，改动仅涉及内部记录（`response_data` / `usage`）与计费中间过程。
- **API 响应接口变化**：`record.usage` 由 JSON 字符串变为**对象**（`SgRecordUsage.toJSON()` 的展示口径）。前端为此**仅做机械改动**——`RecordTable.vue` / `Record/Detail.vue` 去掉 `JSON.parse(record.usage)`、`types/record.ts` 的 `usage` 类型由 `string | null` 改为对象类型；展示数字与逻辑不变（§7.3 注解了 `toJSON` 保证新旧记录展示口径一致）。

## 6. 顺带修复的计费缺口

1. **`OpenAIToAnthropicConverter` 流式丢失 cache 信息**：`message_delta` 只输出 `prompt_tokens / completion_tokens`，未带 `prompt_tokens_details.cached_tokens`。即「客户端 OpenAI ← 上游 Anthropic」的流式请求，cache 部分误按 0 扣费。修复：流式 output 补 `cached_tokens`。
2. **cache 写入不计费的显式决策**：Anthropic `cache_creation_input_tokens` 目前在部分路径有记录但不参与计价（价格模型无此档）。统一后明确为"仅记录"，后续若要扩展价格模型再加档。

## 7. 历史数据与展示（已拍板：方案 B —— 存储版本号 + 后端按版本读取）

归一化后 `records.usage.prompt_tokens` 由"非缓存数"变为"总量"（OpenAI 口径）。对存量记录**不迁移**，采用版本标记 + 后端读取归一化。

### 7.1 存储版本标记

- 新写入的 `usage` JSON 携带版本号 **`usage_version: 2`**；
- 存量记录无该字段 → 视为 **v1**。

### 7.2 版本语义

| 版本 | `prompt_tokens` 口径 | `cache_read_tokens` | 判定 |
|---|---|---|---|
| v1（存量） | 非缓存输入 | 缓存读取（与 prompt 并列） | JSON 无 `usage_version` 字段 |
| v2（新写入） | 输入总量（含缓存） | `prompt_tokens` 的子集 | `usage_version: 2` |

### 7.3 后端按版本读取：`static get()` → constructor 归一，`toJSON()` 直接输出

`usage` 按类存储后，版本归一化收在 **`static get()` → `constructor`**（见 §3.3）：读路径（`record.toData()` → `c.json()`）把 DB 串经 cast 产出的实例直接序列化，`recordController.serializeRecord` 无需额外代码（已确认：`statsController` 不读 usage，仅返回简化字段）。

```ts
// 构造时完成存储 → 展示转换（v2 总量 → 非缓存输入；v1 原样），缺失字段为 null
constructor(data?: Partial<SgRecordUsage>) {
    ...
    this.version = data.version ?? 1;
    if (this.version >= 2 && data.prompt_tokens != null) {
        this.prompt_tokens = data.cache_read_tokens != null
            ? Math.max(0, data.prompt_tokens - data.cache_read_tokens)
            : data.prompt_tokens;
    } else {
        this.prompt_tokens = data.prompt_tokens ?? null;
    }
    this.completion_tokens = data.completion_tokens ?? null;
    this.cache_read_tokens = data.cache_read_tokens ?? null;
    this.cache_creation_tokens = data.cache_creation_tokens ?? null;
}

// toJSON() 直接输出内部展示口径字段，不含版本分支；缺失输出 null
// toStorageJSON() 反向还原 v2 存储串（prompt_total = 非缓存输入 + 缓存读取）
```

- `static get()` 解析存储串并判定版本：含 `usage_version: 2` → v2；否则 v1。`version` 仅构造时使用，`toJSON()` 不输出版本号。
- 前端得到的是**展示口径对象**（非缓存 `prompt_tokens` + 独立 `cache_read_tokens`，缺失为 `null`、返回 0 为 `0`），因此 `RecordTable.vue` 的 `prompt (+ cacheRead)` 与缓存命中率计算（`total = prompt + cacheRead`）逻辑不变，只需把 `JSON.parse(record.usage)` 改为直接使用对象，并把「缺失」判断从 `undefined` 扩展为同时接受 `null`。

### 7.4 非目标 / 注意

- **不改写存量行**——这是选方案 B 而非迁移的首位原因。
- `usage_version` 为存储层内部字段；前端只见展示口径对象，见不到版本号。
- 未来若新增聚合 usage 的读取方（如统计导出），必须经 `SgRecord` 模型（cast）读取，禁止直接 `JSON.parse(usage 字符串)`，避免新旧口径混算。

## 8. 涉及面、风险与验证

- **改动文件**：`src/util/protocol/usageUtil.ts`、`src/model/sgRecord.ts`（`SgRecordUsage` 改 cast 类 + `usage` 注册 cast）、3 个 accumulator、`src/service/responseHandlerService.ts`（写侧改用 `serializeStoredUsage`）、`src/util/protocolConverter/OpenAIToAnthropicConverter.ts`、前端 `RecordTable.vue` / `Record/Detail.vue` / `types/record.ts`（去 JSON.parse + 对象类型）。`recordController.serializeRecord` **不改**。存量数据**不迁移**、DB 列不变。
- **测试影响**：`tests/unit/service/senderService.test.ts` 中 `normalizeUsage` / `buildStreamUsageAccounting` 两个单测需同步（`buildStreamUsageAccounting` 删除、`normalizeUsage` 断言随口径更新）；新增 `SgRecordUsage` cast 的 v1/v2 `toJSON` 读取归一化单元测试（v1 原样 / v2 还原非缓存 / null 处理）。
- **行为保持**：所有路径**金额不变**；流式客户端收到的响应不变；API 的 `usage` 由字符串变对象（展示口径），**新旧记录展示一致**；仅存储层新记录带 `usage_version: 2` 且 `prompt_tokens` 为总量。
- **验证**：后端 node 模式测试 + `npm run backend:test:type` + 前端构建；针对 OpenAI / Anthropic / Responses × 流式 / 非流式各跑一次请求，比对扣费金额、落库 usage 存储串与 API 展示口径。

## 9. 相关文档

- [GEMINI.md（编程规范）](../../GEMINI.md)
- [ROADMAP.md](../ROADMAP.md)
- [设计文档规范](../设计文档规范.md)