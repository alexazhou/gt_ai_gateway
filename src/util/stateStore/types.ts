// StateStore（共享状态层）的公共契约。
// 设计文档：StateStore-设计与实施计划.md（§3 契约 / §4 接口 / §8 整数令牌）。
//
// 三条不可动摇的契约（实现方必须逐条满足，调用方可以逐条依赖）：
// 1. ephemeral：本层只存「可丢状态」，不承担账务 / 幂等 / 审计职责，允许在发布时整体清零。
// 2. 限流 fail-closed（后端不可用 → 拒绝放行，宁可误拒不可误放）；
//    冷却 fail-open（宁可多打一次上游）。取舍点由调用方按操作语义选择，本层不替它兜底。
// 3. 未实现的后端必须显式抛 StateStoreNotImplementedError，禁止静默回落内存实现
//    —— 多机部署下「每个实例各算各的」正是本层要消灭的故障形态。
//
// 两条形态约定（都是为了让三套后端语义真正对齐，不是审美选择）：
// A. 所有方法返回 Promise：Durable Object 与 Redis 的原子操作天然异步，
//    接口若定成同步，S2 的 DO 实现根本无法落地（要么阻塞事件循环，要么改接口）。
//    对 memory 实现来说 async 只是调用形态，方法体内不出现任何 await，仍然是单线程原子。
// B. KV 值类型限定 string（null 表示「键不存在」）：DO storage / Redis 都是跨进程序列化的，
//    对象、浮点在这些后端上「相等」的判定与内存里的引用相等根本对不齐，
//    CAS 一旦允许任意类型，三套后端就会出现肉眼看不出的语义差。需要结构化值时由调用方自行 JSON 编码。
//
// 令牌粒度（1 毫令牌 = 0.001 令牌）：实现内部用整数毫令牌运算（禁浮点累加，避免长期漂移）。
// - **cost 侧向上兜到 1 毫令牌**：cost=0.0001 若被折算成 0，就变成「每次免费放行」——
//   限流最危险的静默失败方向，任何实现都必须保证「一次消费至少扣 1 毫令牌」。
// - **capacity 侧按 0 计**：capacity=0.0005 折算为 0 = 永久硬阻断，方向安全（宁可误拒不可误放）。
// - 需要更细的粒度请直接改 TOKENS_PER_UNIT 并同步三套实现，不要在调用侧做小数补偿。

/**
 * 令牌桶消费结果。
 *
 * 字段命名沿用 `src/util/rule/types.ts` 的同名类型（allowed / remaining 语义完全一致，
 * 见该文件 ConsumeResult 注释），只额外增加 retryAfterMs。
 * 这里独立定义而不 import 旧类型：旧限流模块按计划在 S3 删除，stateStore 不应反向依赖它。
 */
export interface ConsumeResult {
    /** 是否获得令牌（放行）；false = 令牌不足被限流 */
    allowed: boolean;
    /**
     * allowed=true：扣减后的剩余令牌数；
     * allowed=false：此刻桶内令牌数（cost=1 时必然 < 1，可用于观测「差多少」）。
     */
    remaining: number;
    /**
     * 还要等多久重试才可能放行（毫秒，向上取整，避免提前重试又被拒）。
     * allowed=true 时为 0。
     * null = 「等多久都不会放行」：refillPerSec <= 0（只出不进），
     * 或满桶也不足以支付本次 cost（capacity < cost）。
     * 用 null 而不是 Infinity：DO / Redis 侧要跨进程序列化，Infinity 不是合法 JSON 值。
     */
    retryAfterMs: number | null;
}

/** 时钟注入：缺省 Date.now()。仅供测试与确定性重放使用，生产调用方不要传。 */
export interface TimeOptions {
    /** 当前时刻（epoch 毫秒） */
    nowMs?: number;
}

/** 令牌桶消费参数 */
export interface ConsumeOptions extends TimeOptions {
    /** 桶容量（瞬时突发上限，单位：令牌）。有限非负数；0 = 一个令牌都不发 */
    capacity: number;
    /** 补液速率（令牌/秒，= rpm / 60）。有限非负数；0 = 只出不进 */
    refillPerSec: number;
    /** 本次消费的令牌数，缺省 1，必须 > 0 */
    cost?: number;
}

/** 计数器累加结果 */
export interface IncrByResult {
    /** 累加后的当前值 */
    value: number;
    /**
     * 窗口结束时刻（epoch 毫秒）；null = 无 TTL（永久计数）。
     * 调用方据此算 Retry-After / 配额重置时间，比只返回数字更有用（设计 §4）。
     */
    resetAt: number | null;
}

/** 计数器累加参数 */
export interface IncrByOptions extends TimeOptions {
    /** 窗口长度（毫秒）：首次建键时开始计时，到期后整个计数清零重新开始；缺省 = 永久 */
    ttlMs?: number;
}

/** CAS 参数 */
export interface CasOptions extends TimeOptions {
    /** 键不存在时新建的 TTL（毫秒）；键已存在且未指定则沿用原有过期时刻 */
    ttlMs?: number;
}

/** 纯可丢缓存写入参数 */
export interface SetOptions extends TimeOptions {
    /** 存活时长（毫秒）；缺省 = 永不过期 */
    ttlMs?: number;
}

/**
 * 共享状态层接口：只暴露**语义化原子操作**，不暴露裸 get/set 让调用方自己拼原子性。
 *
 * 理由（设计 §4）：调用方写的「读 → 判断 → 写」在 memory 下原子（JS 单线程）、
 * 在 Durable Object 下需要事务、在 Redis 下需要 Lua / WATCH —— 三套后端原子性不同，
 * 而调用方看不出来。语义化操作保证「限流判定只有一份」。
 *
 * 同一个 key 只能归属一种语义（令牌桶 / 计数器 / 纯可丢缓存）：混用会抛 TypeError。
 */
export interface StateStore {
    /**
     * 令牌桶消费：先按 refillPerSec 补液（封顶 capacity），再尝试扣 cost 个令牌。
     * 令牌不足时不扣减，返回 allowed=false 与精确的 retryAfterMs。
     *
     * 限流路径 fail-closed：实现内部异常或资源耗尽一律按「拒绝」处理，
     * 绝不返回 allowed=true 来掩盖后端问题。
     */
    consume(key: string, options: ConsumeOptions): Promise<ConsumeResult>;

    /**
     * 计数器累加（窗口语义）：窗口内单调累加；窗口到期后清零、从 delta 重新开始。
     * 用于「每窗口 N 次」类配额，不用于令牌桶。
     */
    incrBy(key: string, delta: number, options?: IncrByOptions): Promise<IncrByResult>;

    /**
     * 比较并交换：期望值与当前值一致（或 expected=null 表示期望「键不存在」）时才写入 next。
     * 值类型是 string，比较即字符串相等 —— 三套后端（内存 / DO 事务 / Redis Lua）都能做到同一语义。
     *
     * next=null 表示**条件删除**：只有当前值仍等于 expected 才删。这个动作必须在一次原子操作内完成，
     * 拆成 `compareAndSet` + `delete` 两步会在中间被别人写入（DO 事务 / Redis Lua 同样要一条原子命令）。
     * 所以它必须留在本接口里，不能靠调用方自己拼。
     *
     * @param expected null 表示「键不存在才写」（建键 / 抢占）；与 next=null 同时出现无意义，实现应抛 TypeError
     * @param next 写入的新值；null = 条件删除
     * @returns 是否写入/删除成功
     */
    compareAndSet(key: string, expected: string | null, next: string | null, options?: CasOptions): Promise<boolean>;

    /**
     * 读取值。⚠️ **仅限纯可丢缓存使用**：禁止用 get + set 拼原子操作来实现限流 / 冷却 / 配额，
     * 那在三套后端下原子性不同（见接口注释）。原子语义请用 consume / incrBy / compareAndSet。
     * @returns 不存在或已过期 → null
     */
    get(key: string, options?: TimeOptions): Promise<string | null>;

    /** 写入值。⚠️ 仅限纯可丢缓存使用（同 get 的限制）。值必须为 string。 */
    set(key: string, value: string, options?: SetOptions): Promise<void>;

    /** 删除键。⚠️ 仅限纯可丢缓存使用（同 get 的限制）。@returns 键此前是否存在 */
    delete(key: string): Promise<boolean>;
}

/**
 * 后端不可用（限流 fail-closed 的显式信号）。
 * 限流 / 配额路径收到本错误必须按「拒绝放行」处理；冷却路径按 fail-open 处理（放它过去）。
 * memory 实现不会抛它（无外部依赖）；DO / Redis 实现的「连不上 / 事务失败」抛它。
 */
export class StateStoreUnavailableError extends Error {
    constructor(message = "StateStore 后端不可用（限流 fail-closed：拒绝放行）") {
        super(message);
        this.name = "StateStoreUnavailableError";
        // 降级编译（target 改到 ES5）后 instanceof 仍成立
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * 后端未实现（显式报错，禁止静默回落内存）。
 * 静默回落的后果：多实例部署时每个实例各算各的 = 没有限流，正是本层要消灭的 P0 形态。
 */
export class StateStoreNotImplementedError extends Error {
    constructor(message = "StateStore 后端尚未实现（禁止静默回落到内存实现）") {
        super(message);
        this.name = "StateStoreNotImplementedError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
