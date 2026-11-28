# StateStore 业务层接入与内存状态收口改造方案

## 1. 背景与目标

### 1.1 现状分析
当前代码库已在 `src/util/stateStore/` 中完成了 **S1 阶段（共享状态层公共契约 + `MemoryStateStore` 实现 + 契约测试）**：
- `types.ts` 定义了 `StateStore` 统一异步契约（`consume` 令牌桶、`incrBy` 窗口计数器、`compareAndSet` 原子 CAS、`get/set/delete` 纯可丢缓存），并规定了 `StateStoreUnavailableError` 与 `StateStoreNotImplementedError`。
- `memoryStateStore.ts` 实现了整毫令牌计算、容量上限保护（`maxKeys`）及惰性清扫的进程内状态存储。

但**业务层尚未接入 `StateStore`**，各业务模块仍各自维护散落的模块级内存状态：
1. **规则 RPM 限流**（`rateLimitService.ts` + `src/util/rule/memoryRateLimitStore.ts`）：使用旧的同步浮点令牌桶 `MemoryRateLimitStore`。
2. **上游健康冷却**（`upstreamHealthService.ts`）：使用模块级 `localFailures = new Map<string, number>()`，且 `getHealthStatus` 为同步方法。
3. **版本更新检查缓存**（`updateService.ts`）：使用模块级 `cachedStatus` + `lastCheckTime` 缓存 GitHub Release 检查结果（12 小时 TTL）。
4. **未使用的历史缓存模块**（`cacheService.ts`）：业务代码已无任何引用，仅剩单元测试。

### 1.2 改造目标與范围
本次改造旨在**将所有非 DB 缓存类的业务内存状态统一收口到 `StateStore`**，为后续无缝切换 `durable_object`（Worker 跨 isolate）或 `redis`（Node/Docker 多机扩展）铺平道路。

- **纳入本次收口范围**：
  1. 新增全局状态存储生命周期管理服务（`stateStoreService`）。
  2. `rateLimitService` 接入 `StateStore.consume`，下线 `src/util/rule/memoryRateLimitStore.ts` 及 `RateLimitStore` 旧接口。
  3. `upstreamHealthService` 接入 `StateStore.get / set / delete`，并将路由策略中的健康检查链路改为异步。
  4. `updateService` 接入 `StateStore.get / set`。
  5. 清理已废弃的 `src/service/cacheService.ts` 及其测试。
  6. 测试环境重置链路（`/test/cache/clear` 与 `dbHelper.truncate`）统一接入 `stateStoreService.reset()`。
- **暂不纳入本次范围（保持现状）**：
  - **DB 读缓存**（`configService`、`ruleService`、`tenantService`）：因在请求热路径高频调用，若直接走远程 `StateStore` 会带来多次网络 RTT 放大，维持现有进程内缓存设计，待后续专项设计 L1/L2 多级缓存或失效广播机制时再处理。
  - **Redis / Durable Object 客户端实现**：本次不引入 `ioredis` 等第三方包，保持 `createStateStore` 对未实现后端显式抛 `StateStoreNotImplementedError` 的防呆契约。

---

## 2. 架构与核心模块设计

### 2.1 全局状态存储服务：`src/service/stateStoreService.ts`

由于 `createStateStore({ backend: "memory" })` 每次调用都会创建一个全新的实例，业务层需要一个全局统一的生命周期入口（类似 `ormService`）。

#### 职责与接口
```typescript
import {
    createStateStore,
    type CreateStateStoreOptions,
    type StateStore,
    type StateStoreBackend,
} from "../util/stateStore";

let currentStore: StateStore | null = null;
let currentOptions: CreateStateStoreOptions = { backend: "memory" };

/**
 * 初始化全局 StateStore（可在应用启动时调用；未显式调用时按默认 memory 惰性初始化）
 */
function init(options?: CreateStateStoreOptions): StateStore {
    const backend = (options?.backend ?? process.env.STATE_STORE_BACKEND ?? "memory") as StateStoreBackend;
    currentOptions = {
        ...options,
        backend,
    };
    currentStore = createStateStore(currentOptions);
    return currentStore;
}

/**
 * 获取全局 StateStore 单例
 */
function getStore(): StateStore {
    if (!currentStore) {
        currentStore = createStateStore(currentOptions);
    }
    return currentStore;
}

/**
 * 测试注入自定义或故障模拟的 StateStore
 */
function setStore(store: StateStore | null): void {
    currentStore = store;
}

/**
 * 重置状态存储（测试隔离用：基于当前配置重建一份空实例）
 */
function reset(): void {
    currentStore = createStateStore(currentOptions);
}

export default {
    init,
    getStore,
    setStore,
    reset,
};
```

#### 统一 Key 命名空间规范
`StateStore` 要求**同一个 Key 只能归属一种语义**（令牌桶 `bucket` / 计数器 `counter` / 纯可丢缓存 `cache`），且共用同一键空间。所有业务模块统一通过命名空间前缀隔离：

| 业务模块 | 语义类型 | Key 格式 | 示例 | TTL / 回收策略 |
| :--- | :--- | :--- | :--- | :--- |
| 规则限流 (`rateLimitService`) | 令牌桶 (`consume`) | `rl:rule:{ruleId}:rpm` | `rl:rule:12:rpm` | 满桶且空闲 `idleEvictMs`（默认 120s）自动回收 |
| 上游健康冷却 (`upstreamHealthService`) | 纯可丢缓存 (`get`/`set`/`delete`) | `upstream-health:{vendorId}:{vendorModelName}:{apiFormat}` | `upstream-health:3:gpt-4o:openai` | `ttlMs = UPSTREAM_FAILURE_COOLDOWN_MS` |
| 版本更新缓存 (`updateService`) | 纯可丢缓存 (`get`/`set`) | `sys:update:latest` | `sys:update:latest` | `ttlMs = 12 * 3600 * 1000` (12h) |

---

### 2.2 限流服务改造：`src/service/rateLimitService.ts`

#### 改造要点
1. **移除旧限流器依赖**：移除 `src/util/rule/memoryRateLimitStore.ts` 导入以及 `src/util/rule/types.ts` 中的 `RateLimitStore` / `ConsumeResult` 定义。
2. **对接 `StateStore.consume`**：
   - 旧接口参数为 `(key, now, capacity, refillPerMs)`，新接口为 `consume(key, { capacity: rpm, refillPerSec: rpm / 60, cost: 1, nowMs })`。
   - `StateStore.consume` 已直接返回计算好的 `retryAfterMs: number | null`（向上取整到毫秒），`rateLimitService` 直接用 `Math.max(1, Math.ceil((result.retryAfterMs ?? 60_000) / 1000))` 换算为 `Retry-After` 秒数，无需在业务层重复手算令牌差额。
3. **Fail-Closed 契约落地**：
   - 当 `stateStore.consume` 抛出 `StateStoreUnavailableError`（例如 Redis 断连、DO 事务失败）时，必须按 **fail-closed（拒绝放行）** 处理，捕获后转换为 `customError.RateLimitError`（`retryAfterSeconds = 60`），绝不因状态后端故障而放行限流请求。

#### 核心代码示意
```typescript
const RL_KEY_PREFIX = "rl:rule:";
const WINDOW_SECONDS = 60;
const RETRY_AFTER_OFFLINE_SECONDS = 60;

async function checkAndAdmit(
    rule: SgRule,
    _ctx: RequestContext,
    opts: CheckAndAdmitOptions = {},
): Promise<void> {
    const failoverEligible = opts.failoverEligible ?? false;
    const rpm = (rule.config ?? {}).rpm;

    if (rpm === null || rpm === undefined) {
        return;
    }

    if (rpm === 0) {
        throw new customError.RateLimitError(
            `Rule "${rule.name}" is unavailable (rpm = 0)`,
            RETRY_AFTER_OFFLINE_SECONDS,
            failoverEligible,
            Number(rule.id),
            rule.name,
        );
    }

    const key = `${RL_KEY_PREFIX}${rule.id}:rpm`;
    let result;
    try {
        result = await stateStoreService.getStore().consume(key, {
            capacity: rpm,
            refillPerSec: rpm / WINDOW_SECONDS,
            cost: 1,
        });
    } catch (err) {
        if (err instanceof StateStoreUnavailableError) {
            throw new customError.RateLimitError(
                `Rate limit store unavailable for rule "${rule.name}"`,
                RETRY_AFTER_OFFLINE_SECONDS,
                failoverEligible,
                Number(rule.id),
                rule.name,
            );
        }
        throw err;
    }

    if (!result.allowed) {
        const waitSeconds = result.retryAfterMs !== null
            ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
            : RETRY_AFTER_OFFLINE_SECONDS;
        throw new customError.RateLimitError(
            `Rate limit exceeded for rule "${rule.name}" (rpm = ${rpm})`,
            waitSeconds,
            failoverEligible,
            Number(rule.id),
            rule.name,
        );
    }
}
```

---

### 2.3 上游健康冷却改造：`src/service/upstreamHealthService.ts` 与路由策略

#### 改造要点
1. **状态转存 `StateStore`**：
   - 删除 `localFailures = new Map<string, number>()`。
   - `markFailure(vendorId, vendorModelName, apiFormat, failedAt)`：
     调用 `await stateStoreService.getStore().set(key, String(failedAt.getTime()), { ttlMs: UPSTREAM_FAILURE_COOLDOWN_MS, nowMs: failedAt.getTime() })`。
   - `getHealthStatus(vendorId, vendorModelName, apiFormat, now)`：
     **由同步方法改为 `async` 方法**，调用 `await stateStoreService.getStore().get(key, { nowMs: now })`。
     - 若返回 `null`，则为 `{ state: UpstreamHealthState.NORMAL, lastFailureAt: null }`。
     - 若返回时间戳字符串 `val`，解析为 `failedAt = Number(val)`，返回 `{ state: UpstreamHealthState.DOWN, lastFailureAt: failedAt }`（由于 `StateStore` 自身根据 `nowMs` 与 `ttlMs` 做惰性过期判定，未过期即处于 `DOWN` 状态）。
2. **Fail-Open 契约落地**：
   - 冷却属于「尽量少打几次坏上游」的优化手段。当 `markFailure` 或 `getHealthStatus` 捕获到 `StateStoreUnavailableError` 时，记录 `console.warn` 并按 `NORMAL` 放行（**fail-open**），不中断正常的 LLM 请求转发。
3. **路由策略选路链路同步转异步**：
   因为 `upstreamHealthService.getHealthStatus` 变为 `async`，需沿调用链向上改为 `async/await`（调用顶层 `routingService.selectUpstream` 本身已经是 `async`，因此对 Controller / `senderService` 零影响）：
   - `BaseRoutingStrategy.isDown(candidate, now)` → 改为 `protected async isDown(candidate, now): Promise<boolean>`
   - ` BaseRoutingStrategy.selectUpstream(...)` → 签名改为 `abstract selectUpstream(...): Promise<ModelRoutingResult>`
   - `SingleRoutingStrategy.selectUpstream` → 加上 `async`
   - `FirstAvailableRoutingStrategy.selectUpstream` → 改为 `for (const candidate of candidates)` 循环内 `await this.isDown(candidate)`
   - `LoadBalanceRoutingStrategy.selectUpstream` → 过滤可用候选或按顺序查找时使用 `await this.isDown(candidate)`
   - `src/service/routingService/core.ts` 第 258 行：`const selected = await strategy.selectUpstream(...)`

---

### 2.4 版本更新检查缓存改造：`src/service/updateService.ts`

#### 改造要点
- 删除模块级变量 `let cachedStatus: UpdateStatus | null = null` 和 `let lastCheckTime = 0`。
- 定义常量 `UPDATE_CACHE_KEY = "sys:update:latest"` 与 `CHECK_INTERVAL = 1000 * 60 * 60 * 12`。
- 在 `checkUpdate(force = false)` 中：
  - 若 `!force`，尝试 `const raw = await stateStoreService.getStore().get(UPDATE_CACHE_KEY)`，命中则 `JSON.parse(raw)` 直接返回。
  - 请求 GitHub Release API 成功后，调用 `await stateStoreService.getStore().set(UPDATE_CACHE_KEY, JSON.stringify(status), { ttlMs: CHECK_INTERVAL })`。
  - 缓存读写用 `try / catch` 包裹（fail-open），任何状态存储异常不影响在线版本检查。

---

### 2.5 废弃模块清理与测试生命周期对齐

1. **删除废弃文件**：
   - 删除 `src/util/rule/memoryRateLimitStore.ts`
   - 删除 `tests/unit/util/memoryRateLimitStore.test.ts`（其令牌桶与空闲回收覆盖已由 `tests/unit/util/stateStore/memoryStateStore.test.ts` 超集覆盖）
   - 删除 `src/service/cacheService.ts`
   - 删除 `tests/unit/service/cacheService.test.ts`
2. **清理 `src/util/rule/types.ts`**：
   - 删除不再使用的 `ConsumeResult` 与 `RateLimitStore` 接口（`src/util/stateStore/types.ts` 第 30 行注释已明确："旧限流模块按计划在 S3 删除"）。
3. **测试隔离与重置统一收口**：
   - `src/routes.ts` 中的 `DELETE /test/cache/clear` 增加 `stateStoreService.reset()`。
   - `tests/helpers/dbHelper.ts` 的 `truncate()` 中增加 `stateStoreService.reset()`，确保每个测试类执行前限流桶、上游冷却状态、更新缓存一并清空。

---

## 3. 涉及修改的文件清单

| 操作 | 文件路径 | 说明 |
| :--- | :--- | :--- |
| **新增** | `src/service/stateStoreService.ts` | 全局 `StateStore` 单例与生命周期管理（`init` / `getStore` / `setStore` / `reset`） |
| **修改** | `src/service/rateLimitService.ts` | 切换至 `stateStoreService.getStore().consume()`，实现 `StateStoreUnavailableError` fail-closed 处理 |
| **修改** | `src/service/upstreamHealthService.ts` | 切换至 `stateStoreService.getStore().get/set`，`getHealthStatus` 改为 `async`，实现 fail-open 处理 |
| **修改** | `src/service/routingService/routingStrategy/baseRoutingStrategy.ts` | `selectUpstream` 与 `isDown` 改为 `async` 返回 `Promise` |
| **修改** | `src/service/routingService/routingStrategy/singleRoutingStrategy.ts` | `selectUpstream` 改为 `async` |
| **修改** | `src/service/routingService/routingStrategy/firstAvailableRoutingStrategy.ts` | `selectUpstream` 改为 `async` 循环判断 `await this.isDown(candidate)` |
| **修改** | `src/service/routingService/routingStrategy/loadBalanceRoutingStrategy.ts` | `selectUpstream` 改为 `async` 过滤/查找 `await this.isDown(candidate)` |
| **修改** | `src/service/routingService/core.ts` | `await strategy.selectUpstream(...)` |
| **修改** | `src/service/updateService.ts` | 使用 `StateStore.get/set` 替代进程内 `cachedStatus` 变量 |
| **修改** | `src/util/rule/types.ts` | 移除已废弃的 `RateLimitStore` 与 `ConsumeResult` |
| **修改** | `src/routes.ts` | `/test/cache/clear` 增加 `stateStoreService.reset()` |
| **修改** | `tests/helpers/dbHelper.ts` | `truncate()` 增加 `stateStoreService.reset()` |
| **删除** | `src/util/rule/memoryRateLimitStore.ts` | 被 `MemoryStateStore` 替代 |
| **删除** | `tests/unit/util/memoryRateLimitStore.test.ts` | 被 `memoryStateStore.test.ts` 替代 |
| **删除** | `src/service/cacheService.ts` | 无业务引用的旧内存缓存，下线 |
| **删除** | `tests/unit/service/cacheService.test.ts` | 随 `cacheService.ts` 下线 |
| **修改** | `tests/unit/service/rateLimitService.test.ts` | 改为使用 `stateStoreService.reset()`，新增 `StateStoreUnavailableError` fail-closed 单测 |
| **修改** | `tests/unit/service/upstreamHealthService.test.ts` | `getHealthStatus` 调用加上 `await`，新增 `StateStoreUnavailableError` fail-open 单测 |
| **修改** | `tests/unit/service/routingService.test.ts` | `markFailure` / `clear` 调用补齐 `await` |
| **修改** | `tests/integration/service/ruleService.node.test.ts` | 将 `memoryRateLimitStore.clear()` 替换为 `stateStoreService.reset()` |

---

## 4. 实施步骤与验证计划

1. **Step 1：创建 `stateStoreService` 并接入测试重置钩子**
   - 编写 `src/service/stateStoreService.ts`。
   - 在 `src/routes.ts`（`/test/cache/clear`）与 `tests/helpers/dbHelper.ts`（`truncate`）中接入 `stateStoreService.reset()`。
2. **Step 2：改造 `rateLimitService` 并清理旧限流存储**
   - 改造 `src/service/rateLimitService.ts` 使用 `stateStoreService`。
   - 清理 `src/util/rule/memoryRateLimitStore.ts`、`src/util/rule/types.ts`。
   - 更新 `tests/unit/service/rateLimitService.test.ts` 与 `tests/integration/service/ruleService.node.test.ts`。
3. **Step 3：改造 `upstreamHealthService` 与路由策略异步链路**
   - 改造 `src/service/upstreamHealthService.ts` 及 4 个路由策略文件、`routingService/core.ts`。
   - 更新 `tests/unit/service/upstreamHealthService.test.ts` 与 `tests/unit/service/routingService.test.ts`。
4. **Step 4：改造 `updateService` 并清理 `cacheService`**
   - 改造 `src/service/updateService.ts`。
   - 删除 `src/service/cacheService.ts` 与 `tests/unit/service/cacheService.test.ts`。
5. **Step 5：全量回归验证**
   - 执行静态类型检查：`npm run backend:test:type`
   - 执行 Node 模式全量自动化测试：`npm run test:node`
   - 执行前端构建验证：`npm run frontend:build`
