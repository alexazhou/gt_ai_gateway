# 失败重试耗尽时回传最后一个上游错误 — 设计文档

> 状态：已按此方案实现（待提交）
>
> 涉及文件：`src/service/routingService/`（`core.ts`、`types.ts`、`routingContext.ts`、`routingStrategy/`）、`src/service/senderService.ts`、`tests/unit/service/routingService.test.ts`、`tests/unit/service/routingContext.test.ts`、`tests/api/model/model-routing.test.ts`
>
> 关联：[model_multi_upstream_routing_design.md](./model_multi_upstream_routing_design.md)

## 1. 背景与问题

`senderService.sendRequest` 通过 `while(true)` 循环实现失败切换（failover）重试。当一次请求的**所有上游都失败**后，当前实现会走到"无可用上游"分支，抛出 `503 No available upstream`，**最后一个上游返回的错误响应/异常被丢弃**。

期望行为：重试全部失败时，客户端应看到**最后一个上游返回的错误**，而不是笼统的 `No available upstream`。

## 2. 当前行为分析

> 本节为**修改前基线**，代码是当前线上实现，用于对比 §3 的目标方案。

### 2.1 发送与重试流程（`sendRequest`，当前实现 / 修改前）

```typescript
async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    format: ApiFormat,
    body: string,
): Promise<Response> {
    while (true) {
        const routingResult: ModelRoutingResult = await modelRoutingService.selectUpstream(modelConfig, format);
        // 无可用上游时 selectUpstream 返回上游为 null 的空结果
        if (routingResult.vendor == null || routingResult.vendorModelName == null) {
            throw new customError.AppError("No available upstream", 503);
        }

        const vendor = routingResult.vendor;
        const supportedFormats = routingResult.supportedFormats;
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(format, supportedFormats);

        const failoverEnabled = modelConfig.getRoutingConfig().failover.enabled;
        const vendorModelName = routingResult.vendorModelName;

        try {
            const response = await sendRequestToUpstream(
                c, user, modelConfig, vendor, vendorModelName, format, body, supportedFormats,
            );

            if (!response.ok) {
                upstreamHealthService.markFailure(routingResult.vendor.id, vendorModelName, upstreamFormat);
                if (failoverEnabled) {
                    c.status(200);
                    continue;
                }
            }

            return response;
        } catch (e: any) {
            if (c.req.raw.signal.aborted || e instanceof customError.AppError) {
                throw e;
            }

            upstreamHealthService.markFailure(routingResult.vendor.id, vendorModelName, upstreamFormat);
            if (failoverEnabled) {
                continue;
            }

            throw e;
        }
    }
}
```

### 2.2 两条失败路径

| 路径 | 触发条件 | 失败标记 | 重试判断 | 当前失败去向 |
|------|---------|---------|---------|-------------|
| HTTP 错误响应 | `!response.ok`（任何非 2xx） | 无条件 `markFailure` | `failoverEnabled` 才 continue | continue 时丢弃 response |
| 网络异常 | `sendRequestToUpstream` 抛出非 AppError 异常 | 无条件 `markFailure` | `failoverEnabled` 才 continue | continue 时丢弃异常 |

`markFailure` 会把上游拉入 30s 冷却，因此循环**天然有界**：最多把每个上游试一遍，全部失败后 `selectUpstream` 返回空结果。

### 2.3 问题定位

- failover **关闭**时行为正确：`return response` / `throw e` 直接把上游错误回传给客户端。
- 问题仅在 **failover 开启且全部重试失败**：最后一次失败被 `continue` 丢弃，最终走到 `503 No available upstream`。

## 3. 方案：引入 `RoutingContext`，按原始请求记录已用后端

保留"每次重试重新 `selectUpstream`"的循环，但用**请求级上下文**记录本次请求已经尝试过的后端，`selectUpstream` 选择时排除已用后端——循环防护不再依赖全局冷却（`markFailure`）的副作用，而是**显式、按请求隔离**。失败处理（`markFailure` / `lastFailure` / 回传）仍收敛到一处。

### 3.1 `RoutingContext`（新增）

```typescript
class RoutingContext {
    private triedUpstreams = new Set<string>();

    private key(vendorId: number, vendorModelName: string): string {
        return `${vendorId}:${vendorModelName}`;
    }

    hasTried(vendorId: number, vendorModelName: string): boolean {
        return this.triedUpstreams.has(this.key(vendorId, vendorModelName));
    }

    markTried(vendorId: number, vendorModelName: string): void {
        this.triedUpstreams.add(this.key(vendorId, vendorModelName));
    }
}
```

后端标识 = `vendorId:vendorModelName`。同一原始请求内客户端格式固定，上游格式唯一确定，key 无需包含 `apiFormat`。

### 3.2 路由服务接入 `RoutingContext`

`selectUpstream` 接收 `routingContext`：`resolveAvailableCandidates` 排除已用后端；选中后 `markTried` 记录（成功则循环立即结束，该记录无害）。

```typescript
async function resolveAvailableCandidates(
    model: SgModel,
    clientFormat: ApiFormat,
    routingContext: RoutingContext,
    now: number,
): Promise<ModelRoutingResult[]> {
    // ...现有解析逻辑（vendor / vendorModel / supportedFormats / upstreamFormat / 健康检查）...
    for (const upstream of upstreams) {
        // ...
        const vendorModelName = vendorModel?.model_id ?? model.name ?? "";

        // 本次请求已用过的后端，跳过，避免循环
        if (routingContext.hasTried(upstream.vendor_id, vendorModelName)) {
            continue;
        }

        // ...健康检查、push 候选...
    }
}

async function selectUpstream(
    model: SgModel,
    clientFormat: ApiFormat,
    routingContext: RoutingContext,
    now: number = Date.now(),
): Promise<ModelRoutingResult> {
    const strategy = strategies[model.routing_mode];
    if (!strategy) {
        throw new customError.AppError("Invalid routing mode");
    }
    const candidates = await resolveAvailableCandidates(model, clientFormat, now, routingContext);
    const selected = strategy.selectUpstream(model, candidates);
    if (selected.vendor != null) {
        routingContext.markTried(selected.vendor.id, selected.vendorModelName);   // 记录本次已用
    }
    return selected;
}
```

### 3.3 `sendRequest`：循环 + 单一失败处理点 + 耗尽回传

```typescript
// 本地错误类：可重试的 HTTP 错误响应转成异常，与网络异常汇入同一个失败处理点
class UpstreamResponseError extends Error {
    constructor(readonly response: Response) {
        super(`Upstream returned retryable status ${response.status}`);
    }
}

type LastFailure =
    | { kind: "response"; response: Response }   // 最后一次是 HTTP 错误响应
    | { kind: "error"; error: unknown };         // 最后一次是网络异常

async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    format: ApiFormat,
    body: string,
): Promise<Response> {
    const routingContext = new RoutingContext();   // 每个原始请求一个上下文
    let lastFailure: LastFailure | null = null;

    while (true) {
        const routingResult: ModelRoutingResult = await modelRoutingService.selectUpstream(
            modelConfig, format, routingContext,
        );
        if (routingResult.vendor == null || routingResult.vendorModelName == null) {
            // 没有可用上游：优先回传最后一次尝试的上游错误
            if (lastFailure) {
                if (lastFailure.kind === "response") {
                    return lastFailure.response;   // ① HTTP 错误：status + body 原样回传
                }
                throw new customError.AppError(   // ② 网络异常：502 + 明确信息
                    `All upstreams failed: ${lastFailure.error instanceof Error ? lastFailure.error.message : String(lastFailure.error)}`,
                    502,
                );
            }
            // ③ 一开始就没有可用上游（全部冷却中 / 未启用）
            throw new customError.AppError("No available upstream", 503);
        }

        const vendor = routingResult.vendor;
        const vendorModelName = routingResult.vendorModelName;
        const supportedFormats = routingResult.supportedFormats;
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(format, supportedFormats);
        const failoverEnabled = modelConfig.getRoutingConfig().failover.enabled;

        try {
            const response = await sendRequestToUpstream(
                c, user, modelConfig, vendor, vendorModelName, format, body, supportedFormats,
            );

            // 上游返回非成功响应，转成异常统一走下面的失败处理点，尝试下一个上游
            if (!response.ok) {
                throw new UpstreamResponseError(response);
            }

            return response;
        } catch (e: any) {
            if (c.req.raw.signal.aborted || e instanceof customError.AppError) {
                throw e;
            }

            // 唯一的失败处理点：HTTP 错误与网络异常在这里汇合
            const httpFailure = e instanceof UpstreamResponseError;

            // 全局冷却：标记失败，让后续请求跳过（本请求的循环防护由 routingContext 承担）
            upstreamHealthService.markFailure(vendor.id, vendorModelName, upstreamFormat);

            // failover 关闭：HTTP 错误直接回传响应，网络异常抛原始异常，不继续尝试
            if (!failoverEnabled) {
                if (httpFailure) {
                    return e.response;
                }
                throw e;
            }

            lastFailure = httpFailure
                ? { kind: "response", response: e.response }
                : { kind: "error", error: e };
            c.status(200);   // 复位上下文状态，避免上次失败的 error 状态影响下一次尝试
        }
    }
}
```

### 3.4 设计要点

1. **循环防护显式化**：`RoutingContext.triedUpstreams` 按请求隔离，任何一次重试都不会再选中已用过的后端；后端数量有限，用完即止，**不可能循环**。
2. **`markFailure` 职责收敛**：只负责"全局 30s 冷却，让后续请求跳过刚失败的上游"，不再承担本请求的循环防护，两者解耦。
3. **`load_balance` 语义保持**：每次重试仍在"剩余健康且未用过"的上游中随机选，比"有序列表"方案更贴近现状。
4. **失败处理收敛到一处**：上游返回的非成功响应经 `UpstreamResponseError` 转成异常，与网络异常在 `catch` 汇合；`markFailure`、`lastFailure` 记录、回传只出现一次。
5. **耗尽回传**：全部后端用尽时回传最后一次上游错误（HTTP 错误原样 / 网络异常 502），首次即无可用上游保持 `503 No available upstream`。
6. HTTP 错误回传：返回 `sendRequestToUpstream` 已构建的 `Response` 对象，status + body 原样透传（与 failover 关闭时 `return response` 的既有路径一致，已验证可行）。

## 4. 行为矩阵

| 场景 | 当前行为 | 修改后行为 |
|------|---------|-----------|
| failover 关闭，上游返回 retryable 错误 | 直接回传上游错误 | 不变 |
| failover 关闭，上游返回非 retryable 错误 | 直接回传上游错误 | 不变 |
| failover 关闭，网络异常 | 抛原始异常 | 不变 |
| failover 开启，任一上游成功 | 返回成功响应 | 不变 |
| failover 开启，全部 HTTP 错误 | `503 No available upstream` | **回传最后一个上游的错误响应** |
| failover 开启，全部网络异常 | `503 No available upstream` | **`502 All upstreams failed: <msg>`** |
| 首次即无可用上游（全部冷却中） | `503 No available upstream` | 不变 |
| 非 retryable 错误（如 400） | 直接返回，不重试 | 不变 |

## 5. 保持不变的部分

- `markFailure` 无条件执行；冷却逻辑、健康 key 不变（冷却只影响**后续**请求；本次请求的循环防护由 `routingContext` 承担）。
- 非 retryable 错误直接返回；failover 关闭直接返回/抛异常。
- 每次重试尝试都会创建一条记录（既有行为，中间失败记录保留）。
- `c.status(200)` 复位逻辑保留（failover 开启、准备尝试下一个上游前复位上下文状态）。

## 6. 测试计划

**单测（`tests/unit/service/modelRoutingService.test.ts`）**：现有策略用例不变（仍是"选一个"）。新增 `RoutingContext` 相关用例：

- `markTried` / `hasTried` 按 `vendorId:vendorModelName` 去重
- 传入已含某后端的 context 时，`selectUpstream` 不再返回该后端

**API 用例（`tests/api/model/model-routing.test.ts`）**：现有 failover 用例都**至少有一个健康上游**，行为不变，无需改动。

新增 2 个用例：

1. **HTTP 错误耗尽回传**：failover 开启，两个上游都指向 mock 的 `/chat/completions/unavailable`（503，retryable）——同时验证"全部失败后不循环、回传最后一次错误"
   - 断言：响应体为 mock 的 `error.message === "Mock upstream unavailable"`（而非 `No available upstream`）；record 2 条且均 FAILED
2. **网络异常耗尽回传**：failover 开启，两个上游 URL 指向关闭的本地端口（fetch 连接失败）
   - 断言：状态 `502`；`error.message` 包含 `All upstreams failed`

## 7. 验证

- `npm run backend:test:type`
- `npm run backend:test:node`（全量 node 模式测试）

## 8. 已确认 / 待确认决策

- [x] 全部 HTTP 错误时回传最后一个上游的错误响应（status + body 原样）
- [x] 全部网络异常时抛 `502 All upstreams failed: <msg>`（用户已确认采用"502 + 明确信息"）
- [x] 首次无可用上游仍返回 `503 No available upstream`
- [x] **引入请求级 `RoutingContext`**：记录本次请求已用后端，循环防护显式化、按请求隔离（放弃"有序列表"方案，保留"每次重试重新 selectUpstream"）
- [x] **`markFailure` 职责收敛**：只负责全局冷却（后续请求），不承担本请求的循环防护
- [x] **`load_balance` 语义保持**：每次重试仍在剩余健康上游中随机选
- [x] **失败处理合并到一处**：上游返回的非成功响应经 `UpstreamResponseError` 转成异常，与网络异常汇入同一 `catch`
- [x] **任何非成功响应都切换**：移除 `RETRYABLE_UPSTREAM_STATUS_CODES` / `isRetryableStatus` 门槛，`!response.ok` 即触发 failover
- [x] **`RoutingContext` 位置**：`src/service/routingService/routingContext.ts`，默认导出类（符合项目规范）
- [x] **502 消息不带上游名称/ID**：保持 `All upstreams failed: <msg>`（如需排查可查本次请求的失败记录）

## 9. 实现记录

- `RoutingContext` 新增于 `src/service/routingContext.ts`，`triedUpstreams` 按 `vendorId:vendorModelName` 去重。
- `selectUpstream` 签名增加 `routingContext` 参数；`resolveAvailableCandidates` 排除已用后端，选中后 `markTried`。
- `sendRequest` 每请求创建一个 `RoutingContext`；失败处理合并到单一 `catch`（`UpstreamResponseError` + 网络异常），耗尽时回传 `lastFailure`（HTTP 错误原样 / 网络异常 502）。
- 验证：`backend:test:type` 通过；node 模式全量 73 文件 / 834 测试通过。
