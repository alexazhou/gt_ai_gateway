# 上游失败的识别与 failover 现状

> 状态：现状说明（2026-10-20 复核，v1.8.8 及之后的 1.9_dev 分支）。第 3 节为已修复内容；
> 第 4 节记录各缺口的修复状态：4.1 / 4.2 仍未实现，4.3 已由 `d8468a7` 修复。
> 关联：`doc/design/2026-07-04-multi-upstream-object-storage-billing/` 下的
> `step2_technical.md`、`model_multi_upstream_routing_design.md`、
> `request_record_and_activity_design.md`、`upstream_failover_last_error_design.md`

## 1. 起因

用户反馈：某个上游持续失败，但网关"每次都还是命中第一个上游"，且客户端只看到流被截断、
拿不到任何错误信息。

排查后发现不是单一缺陷，而是**「一次上游失败」在四个环节上的判定口径不一致**：记账、转发、
切换、冷却各自只看自己那部分信号，而 SSE 协议把大量上游故障藏在 HTTP 200 的响应体里，
导致"只看 HTTP 状态码"的判据集体失效。

## 2. 一次上游失败要经过的四个环节

| 环节 | 实现在哪 | 判定依据 |
|------|---------|---------|
| 转发给客户端 | `responseHandlerService.runSSELoop` | 见 §3.2（已改为旁路，不再拦截） |
| 记进 record | `responseHandlerService`（流式 / 非流式两条路径） | 见 §3.1、§3.3 |
| 同请求切换上游 | `senderService.sendRequest` 的 `while` 循环 | `!response.ok` + 网络异常 |
| 标记健康冷却 | `upstreamHealthService` ← 仅 `senderService.sendRequest` 一处调用 | `shouldMarkFailure(status)` |

四个环节里，**后两个至今只认 HTTP 层**：`senderService` 拿到 200 + `text/event-stream`
就直接把响应交给 `responseHandlerService` 并 return，循环随即结束——第二个上游从来没有进入过候选。

## 3. 已修复

### 3.1 上游报错被记成成功并计费（`3fc47da`）

累加器里 `errored` 与 `completed` 是两个互不约束的布尔，而收尾时 `finalizeStreamResult`
**先判 `completed`、再判失败码**。于是"上游明确报错 + 尾随终止标记"（`[DONE]` /
`message_stop` / `response.completed`）会被判定为成功，按已累积的 usage 计费。

修复：把"已出过错就不算完成"的守卫下沉到 `AccumulatorBase.markCompleted()` 一处，
覆盖全部完成入口（含以后新增的）；同时把错误判据从 `error !== undefined` 收紧为
`error != null`，避免上游报文里显式的 `error: null` 被误判为错误。

守卫**只拦 `errored`**：客户端断开、上游超时只写循环层的 `failedCode`、不置 `errored`，
因此"客户端已拿到完整结果后断开"仍然按成功记账（有专门用例钉住）。

### 3.2 客户端收不到错误帧（`e91cf41`）

原实现里 `runSSELoop` 一旦发现累加器报错，就在 `writeEventToClient` **之前** `break`，
错误帧被静默丢弃。此时 HTTP 状态码已经是 200，SSE 响应体是唯一的错误通道，客户端因此只能
看到一条被截断的流。

修复：**累加器降级为旁路观察者**——它仍然记录流状态（供收尾判定成败），但不再决定某一帧是否
转发。转换器产出什么就下发什么，上游的 `response.failed` / `event: error` 原样到达客户端。
记账不受影响：失败码照常在循环里记录。

附带修复：循环原本没有"逻辑上已经结束"的概念，只认"物理上读不到数据"。收到终止标记或错误后
仍会继续读上游，上游若不主动关连接，客户端要等到空闲超时（`upstream_stream_idle_timeout_ms`，
默认 180s）才拿到流结束，收尾落库（含成功计费）也被拖到那时。现在收尾条件成立即
`cancel()` 上游 reader 并跳出循环。

### 3.3 非流式 200 + 失败体被记成成功（`1919d3b`）

非流式路径只按 HTTP 状态码判成败，上游若用 `200 + {"status":"failed", ...}` 或
`200 + {"error":{...}}` 返回，会被记成 `status=success`、`failed_code` 留空、活动时间线
记"请求成功"——失败信息其实一直躺在 `response_data` 里，只是状态字段与它矛盾。

修复：按协议各自的失败形态判定（新增 `src/util/protocol/upstreamFailureUtil.ts`，
以 `upstreamFormat` 分发，写法对齐 `usageUtil.normalizeUsage`）：

| 协议 | 失败判据 | 错误码来源 |
|------|---------|-----------|
| Responses | `status === "failed"`，或错误事件体 `{type:"error"}` | `error.code` / `code` |
| OpenAI | `error != null` | `error.code` → 回退 `error.type` |
| Anthropic | `type === "error"` 或 `error != null` | `error.type`（该协议无 `code` 字段） |

`status: "incomplete"`（被 `max_output_tokens` 等截断）属正常返回，**不算失败**。

为什么不能放进转换器：转换器只在 `clientFormat !== upstreamFormat` 时才创建，
而同协议场景恰恰最可能出现 200 + 失败体，因此判定必须能脱离转换器工作。

响应本身仍按上游原样透传（HTTP 200 + 失败体），不擅自改成 5xx，保持客户端看到的协议语义不变。

## 4. 缺口与修复状态

### 4.1 流内错误不触发同请求切换（未实现）

**现状**：切换判据只覆盖 HTTP 层。SSE 流内错误（HTTP 200 + `response.failed`）不会切换，
第二个上游不会进入本次请求的候选。

**为什么不能简单加个判断**：流一旦开始向客户端下发，就无法回退——已经发出去的 token 收不回来，
重试会导致输出重复或错乱。

**唯一可行的做法是「先窥视后建流」**：在创建 SSE 响应之前，先把上游流读到一个缓冲区，直到
出现第一个**内容** delta（此时才开始转发，零额外延迟——这一段本来就要等），或出现终止 / 错误
事件（此时不建流，抛可重试错误回到外层循环）。失败发生在内容之前时（如本次反馈的
`sequence_number: 4`）切换是透明的；一旦有内容已下发，就只能按失败收场。

注意不能拿 `accumulator.isOutputStarted()` 当"还没输出内容"的守卫：它是 TTFT 语义，
三个协议都在很靠前的事件就置位（Anthropic 的 `message_start`、OpenAI 的 role chunk、
Responses 的 `response.output_item.added`），都早于真正的内容 delta，与"是否已有内容
发给客户端"不是一回事——拿它做守卫会得到永不触发的分支。

### 4.2 流内错误不写健康冷却（未实现）

**现状**：`upstreamHealthService.markFailure` 全项目只有 `senderService.sendRequest` 一处调用；
流内错误走 `responseHandlerService`，不经过那里，健康缓存 key 从未写入。

**后果**：`first_available` 每请求按顺序取第一个「非 DOWN 且本请求未试过」的候选，
上游 1 始终是 NORMAL，于是**永远选它**。这比"本次请求不切换"影响更大——即使不做同请求切换，
这一条不修也永远轮不到第二个上游。

**一个必须注意的前提**：不能照搬 HTTP 那套判定。`response.failed` / `error` 事件里既有服务端
故障（`server_error`、`overloaded_error`、`rate_limit_error`、`insufficient_quota`），也有请求侧
问题（`invalid_request_error`、`content_filter`、上下文超限）。`shouldMarkFailure` 特意排除 4xx
正是为了避免"一个用户的坏请求把整个上游冷却 30 秒"；流内错误若不做同样的甄别，会引入新的全局
故障放大。三个累加器都把原始错误 payload 存进了 `markError`，但字段位置各家不同
（Responses 在 `event.response.error`，OpenAI / Anthropic 在 `error`），需先归一化。

### 4.3 跨协议方向转换器会丢掉错误事件（已修复，`d8468a7`）

| 客户端 ← 上游 | 转换器 | 错误事件处理 |
|--------------|--------|-------------|
| Responses ← Responses | 无 | 原始 `response.failed` 到达累加器 |
| Responses ← Anthropic | `ResponsesToAnthropicConverter` | 处理 `type==="error"` |
| OpenAI ← Anthropic | `OpenAIToAnthropicConverter` | 透传 `event: error` |
| Anthropic ← OpenAI | `AnthropicToOpenAIConverter` | 透传 `event: error` |
| OpenAI ← Responses | `OpenAIToResponsesConverter` | 处理 `type==="error"` 与 `response.failed`（`d8468a7`） |
| Anthropic ← Responses | `AnthropicToResponsesConverter` | 处理 `type==="error"` 与 `response.failed`（`d8468a7`） |
| Responses ← OpenAI | `ResponsesToOpenAIConverter` | 处理错误 chunk，归一化成 `event: error`（`d8468a7`） |

§3.2 的旁路改造解决了"错误帧被循环层丢弃"，但**转换器先丢掉错误**的那三个方向，循环层没有
东西可转发。该缺口已由 `d8468a7`（2026-09-28，随 v1.8.8 发布）修复：三处均在转换器层补上
错误分支，统一输出客户端协议的错误事件，并补充了对应单测（`tests/unit/protocolConverter/`）。

## 5. 与设计文档的差异

以下为正文所载与实现不符之处，此处只做登记，不改动设计文档本身：

| 位置 | 文档表述 | 实现 |
|------|---------|------|
| `step2_technical.md:42` | "非成功响应**或流式异常**触发下一次尝试" | 只有 `!response.ok` 与网络异常；流式异常不触发（见 §4.1） |
| `model_multi_upstream_routing_design.md:37` | "上游返回**任何**非成功响应或网络异常时，**总是**标记冷却" | `shouldMarkFailure` 只对 5xx / 402 / 网络不可达标记，4xx 有意豁免 |
| `model_multi_upstream_routing_design.md:63-78` | 表中反复出现"失败冷却" | 同上 |
| `request_record_and_activity_design.md:73,156` | failover 阶段单独记一条活动 | 已取消，`RequestActivityStage.FAILOVER` 成为未使用常量，切换由时间线自然体现 |

注：`upstream_failover_last_error_design.md` 的 §2 也提到"无条件 markFailure"，但该节已自行
标注为「修改前基线」，属于有意保留的历史快照，不算差异。

## 6. 测试覆盖

| 层级 | 覆盖 |
|------|------|
| 单元（`tests/unit/util/accumulator/`） | 各协议完成入口在已出错时不算完成；`error: null` 不误判；终止事件在前、错误在后仍算完成 |
| 单元（`tests/unit/util/protocol/upstreamFailureUtil.test.ts`） | 三个协议各自的失败形态识别，以及正常响应（含 `status:"incomplete"`、`error:null`）不被误判 |
| 端到端（`tests/api/ai/stream-failure.test.ts`） | 错误帧下发给客户端；上游报错后挂着不关连接时流能及时结束；非流式 200 + 失败体记 FAILED |

未覆盖：同请求切换（§4.1 未实现）、冷却写入（§4.2 未实现）。
跨协议错误帧透传已由 `tests/unit/protocolConverter/` 下的三个转换器单测覆盖（`d8468a7`）。

## 7. 排查指引

| 症状 | 看哪节 |
|------|--------|
| 客户端流被截断、拿不到错误信息 | §3.2、§4.3（同协议与跨协议均已修复） |
| 上游报错却记成 success 并扣费 | §3.1（流式）、§3.3（非流式） |
| 一直命中同一个上游、不切换 | §4.2（冷却未写） |
| 上游失败后本次请求不切下一个 | §4.1 |
| 客户端要等很久才拿到流结束 | §3.2 附带修复（空闲超时 180s） |
