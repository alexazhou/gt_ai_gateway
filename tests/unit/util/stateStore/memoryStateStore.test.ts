import { describe, expect, it } from "vitest";
import { createStateStore, MemoryStateStore, StateStoreNotImplementedError, StateStoreUnavailableError } from "../../../../src/util/stateStore";
import type { StateStore, StateStoreBackend } from "../../../../src/util/stateStore";

// ---------------------------------------------------------------------------
// 跨实现契约测试（设计 §9.1）
//
// 这里的用例写的是「语义」，不写「实现」：
// - 一律通过工厂拿实现，不直接 import 具体类（上界 / 回收这类内存实现细节另开 describe）。
// - S2 接入 Durable Object 时，只需 ①BACKENDS 数组加 "durable_object"，
//   ②createStore 里补一行（用 miniflare 绑定构造 DO 实现），本文件其余内容零改动。
// ---------------------------------------------------------------------------
const BACKENDS: StateStoreBackend[] = ["memory"];

function createStore(backend: StateStoreBackend): StateStore {
    return createStateStore({ backend });
}

// 固定基准时刻，避免用系统时间做断言（R12：时间必须可复现）
const BASE = 1_700_000_000_000;

describe.each(BACKENDS)("StateStore 契约（backend=%s）", (backend) => {
    it("新桶满额起步，突发打满即拒绝（capacity 即瞬时上限）", async () => {
        const store = createStore(backend);
        const opts = { capacity: 3, refillPerSec: 3 / 60, nowMs: BASE };

        await expect(store.consume("k", opts)).resolves.toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
        await expect(store.consume("k", opts)).resolves.toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
        await expect(store.consume("k", opts)).resolves.toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });

        const denied = await store.consume("k", opts);
        expect(denied.allowed).toBe(false);
        expect(denied.remaining).toBe(0);
        // 补 1 个令牌需 1s（3 rpm = 0.05 令牌/秒 → 1000 毫令牌 / 0.05 = 20000ms）
        expect(denied.retryAfterMs).toBe(20000);
    });

    it("按 refillPerSec 线性补充，毫令牌精度、时间余数不丢", async () => {
        const store = createStore(backend);
        // capacity=1，0.5 令牌/秒 = 0.5 毫令牌/毫秒
        expect((await store.consume("k", { capacity: 1, refillPerSec: 0.5, nowMs: BASE })).remaining).toBe(0);
        // BASE+3：3ms × 0.5 = 1.5 毫令牌 → 折算 1 毫，余下的 0.5 毫（=1ms）留到下次
        expect((await store.consume("k", { capacity: 1, refillPerSec: 0.5, nowMs: BASE + 3 })).remaining).toBe(0.001);
        // BASE+4：距上次锚点（BASE+2）2ms × 0.5 = 1 毫 → 累计 2 毫。
        // 变异体敏感性：若实现每次调用都把时间锚点重置到 now，这里只会得到 1 毫（0.001）。
        expect((await store.consume("k", { capacity: 1, refillPerSec: 0.5, nowMs: BASE + 4 })).remaining).toBe(0.002);
    });

    it("补满即放行，且封顶到 capacity（长时间空闲不会攒出超额额度）", async () => {
        const store = createStore(backend);
        expect((await store.consume("k", { capacity: 2, refillPerSec: 1, nowMs: BASE })).remaining).toBe(1);
        // 空闲 1 小时：补液远超容量 → 封顶 2，扣 1 后剩 1（不是 3600）
        const far = BASE + 3_600_000;
        expect((await store.consume("k", { capacity: 2, refillPerSec: 1, nowMs: far })).remaining).toBe(1);
    });

    it("同一 key 的 capacity 变更：只裁不补（放大不凭空补满，缩小裁掉多余令牌）", async () => {
        const store = createStore(backend);
        // 容量 5，消耗 1 → 剩 4
        expect((await store.consume("k", { capacity: 5, refillPerSec: 0, nowMs: BASE })).remaining).toBe(4);
        // 放大到 10：余额仍是 4（不补满到 10），再消耗 1 → 3
        expect((await store.consume("k", { capacity: 10, refillPerSec: 0, nowMs: BASE })).remaining).toBe(3);
        // 缩小到 2：余额裁到 2，再消耗 1 → 1
        expect((await store.consume("k", { capacity: 2, refillPerSec: 0, nowMs: BASE })).remaining).toBe(1);
        // 缩到 0：桶被清空并彻底阻断
        await expect(store.consume("k", { capacity: 0, refillPerSec: 0, nowMs: BASE })).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: null,
        });
    });

    it("令牌粒度 1 毫令牌：cost 小于 1 毫令牌按 1 毫扣（不许折算成 0 变成免费放行）", async () => {
        const store = createStore(backend);
        const opts = { capacity: 1, refillPerSec: 0, cost: 0.0001, nowMs: BASE };
        // 0.0001 令牌 = 0.1 毫令牌 → 向上兜到 1 毫令牌，剩余逐次递减（折算成 0 的话这里会一直是 1）
        expect((await store.consume("k", opts)).remaining).toBe(0.999);
        expect((await store.consume("k", opts)).remaining).toBe(0.998);
        // 1000 次正好扣完 1 个令牌：第 1001 次必须拒绝（折算成 0 会无限放行）
        for (let i = 0; i < 998; i++) {
            expect((await store.consume("k", opts)).allowed).toBe(true);
        }
        await expect(store.consume("k", opts)).resolves.toEqual({ allowed: false, remaining: 0, retryAfterMs: null });
    });

    it("capacity 小于 1 毫令牌折算为 0 = 永久硬阻断（宁可误拒不可误放）", async () => {
        const store = createStore(backend);
        // 0.0005 令牌 = 0.5 毫令牌 → 容量 0；即便补液速率很高也永远放不出令牌
        await expect(store.consume("k", { capacity: 0.0005, refillPerSec: 60, nowMs: BASE })).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: null,
        });
        await expect(store.consume("k", { capacity: 0.0005, refillPerSec: 60, nowMs: BASE + 3_600_000 })).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: null,
        });
    });

    it("cost>1：按成本扣减，不足则不扣减并给出等待时间", async () => {
        const store = createStore(backend);
        const opts = { capacity: 5, refillPerSec: 1, cost: 3, nowMs: BASE };

        await expect(store.consume("k", opts)).resolves.toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
        // 还差 1 个令牌（1000 毫），速率 1 毫令牌/毫秒 → 1000ms
        await expect(store.consume("k", opts)).resolves.toEqual({ allowed: false, remaining: 2, retryAfterMs: 1000 });
        // 拒绝时不扣减：等到 BASE+1000 恰好补够 3 个令牌
        await expect(store.consume("k", { ...opts, nowMs: BASE + 1000 })).resolves.toEqual({
            allowed: true,
            remaining: 0,
            retryAfterMs: 0,
        });
    });

    it("capacity 小于 cost：永远无法支付，retryAfterMs=null（不要让调用方无脑重试）", async () => {
        const store = createStore(backend);
        await expect(store.consume("k", { capacity: 2, refillPerSec: 1, cost: 3, nowMs: BASE })).resolves.toEqual({
            allowed: false,
            remaining: 2,
            retryAfterMs: null,
        });
    });

    it("rpm=0 硬阻断：capacity=0 时一个都不放行（与 refillPerSec 无关）", async () => {
        const store = createStore(backend);
        await expect(store.consume("a", { capacity: 0, refillPerSec: 0, nowMs: BASE })).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: null,
        });
        // 速率不为 0 也补不出令牌：容量为 0，补液封顶到 0
        await expect(store.consume("b", { capacity: 0, refillPerSec: 60, nowMs: BASE })).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: null,
        });
        // 一小时后依旧阻断
        expect((await store.consume("a", { capacity: 0, refillPerSec: 0, nowMs: BASE + 3_600_000 })).allowed).toBe(false);
    });

    it("refillPerSec=0（只出不进）时额度用尽即永久拒绝", async () => {
        const store = createStore(backend);
        const opts = { capacity: 1, refillPerSec: 0, nowMs: BASE };
        expect((await store.consume("k", opts)).allowed).toBe(true);
        await expect(store.consume("k", opts)).resolves.toEqual({ allowed: false, remaining: 0, retryAfterMs: null });
    });

    it("不同 key 的桶互相隔离", async () => {
        const store = createStore(backend);
        expect((await store.consume("a", { capacity: 1, refillPerSec: 0, nowMs: BASE })).allowed).toBe(true);
        expect((await store.consume("a", { capacity: 1, refillPerSec: 0, nowMs: BASE })).allowed).toBe(false);
        // b 是独立的满桶
        expect((await store.consume("b", { capacity: 1, refillPerSec: 0, nowMs: BASE })).allowed).toBe(true);
    });

    it("KV：TTL 到期即读不到（惰性过期）", async () => {
        const store = createStore(backend);
        await store.set("t", "v", { ttlMs: 1000, nowMs: BASE });
        expect(await store.get("t", { nowMs: BASE })).toBe("v");
        expect(await store.get("t", { nowMs: BASE + 999 })).toBe("v");
        // 到期时刻即失效（expiresAt <= now）
        expect(await store.get("t", { nowMs: BASE + 1000 })).toBeNull();
        // 不存在的键同样返回 null
        expect(await store.get("nope", { nowMs: BASE })).toBeNull();
    });

    it("KV：不带 TTL 则不过期；delete 返回「此前是否存在」", async () => {
        const store = createStore(backend);
        await store.set("p", "1", { nowMs: BASE });
        expect(await store.get("p", { nowMs: BASE + 365 * 24 * 3_600_000 })).toBe("1");
        await expect(store.delete("p")).resolves.toBe(true);
        await expect(store.delete("p")).resolves.toBe(false);
        expect(await store.get("p", { nowMs: BASE })).toBeNull();
    });

    it("incrBy：窗口内单调累加，resetAt 不因访问续期；窗口到期清零重来", async () => {
        const store = createStore(backend);
        await expect(store.incrBy("c", 1, { ttlMs: 1000, nowMs: BASE })).resolves.toEqual({
            value: 1,
            resetAt: BASE + 1000,
        });
        await expect(store.incrBy("c", 2, { ttlMs: 1000, nowMs: BASE + 500 })).resolves.toEqual({
            value: 3,
            resetAt: BASE + 1000,
        });
        // 到期后从 delta 重新开始，窗口重新计时
        await expect(store.incrBy("c", 1, { ttlMs: 1000, nowMs: BASE + 1000 })).resolves.toEqual({
            value: 1,
            resetAt: BASE + 2000,
        });
        // 无 TTL：永久计数，resetAt=null
        await expect(store.incrBy("d", 5, { nowMs: BASE })).resolves.toEqual({ value: 5, resetAt: null });
        await expect(store.incrBy("d", -2, { nowMs: BASE })).resolves.toEqual({ value: 3, resetAt: null });
    });

    it("compareAndSet：三态（建键成功 / 值不符失败 / 值相符成功）+ 过期后可重新建键", async () => {
        const store = createStore(backend);
        // ① expected=null 且键不存在 → 建键成功
        await expect(store.compareAndSet("lock", null, "owner-1", { nowMs: BASE })).resolves.toBe(true);
        // ② expected=null 但键已存在 → 失败（抢占失败）
        await expect(store.compareAndSet("lock", null, "owner-2", { nowMs: BASE })).resolves.toBe(false);
        // ③ 期望值不符 → 失败，且不覆盖
        await expect(store.compareAndSet("lock", "owner-2", "owner-3", { nowMs: BASE })).resolves.toBe(false);
        expect(await store.get("lock", { nowMs: BASE })).toBe("owner-1");
        // ④ 期望值相符 → 成功
        await expect(store.compareAndSet("lock", "owner-1", "owner-3", { nowMs: BASE })).resolves.toBe(true);
        expect(await store.get("lock", { nowMs: BASE })).toBe("owner-3");
        // ⑤ 带 TTL 的键过期后等同不存在 → expected=null 可重新建键
        await expect(store.compareAndSet("lease", null, "a", { ttlMs: 1000, nowMs: BASE })).resolves.toBe(true);
        await expect(store.compareAndSet("lease", null, "b", { nowMs: BASE + 1000 })).resolves.toBe(true);
        expect(await store.get("lease", { nowMs: BASE + 1000 })).toBe("b");
    });

    it("compareAndSet 条件删除（next=null）：期望值相符才删，且必须一次原子完成", async () => {
        const store = createStore(backend);
        await store.set("lock", "owner-1", { nowMs: BASE });
        // 期望值不符 → 不删，值保留
        await expect(store.compareAndSet("lock", "owner-2", null, { nowMs: BASE })).resolves.toBe(false);
        expect(await store.get("lock", { nowMs: BASE })).toBe("owner-1");
        // 期望值相符 → 条件删除成功
        await expect(store.compareAndSet("lock", "owner-1", null, { nowMs: BASE })).resolves.toBe(true);
        expect(await store.get("lock", { nowMs: BASE })).toBeNull();
        // 删干净后：delete 返回 false，expected=null 可重新建键
        await expect(store.delete("lock")).resolves.toBe(false);
        await expect(store.compareAndSet("lock", null, "owner-2", { nowMs: BASE })).resolves.toBe(true);
        // 键不存在时条件删除 → 失败（不是「删了个寂寞也算成功」）
        await expect(store.compareAndSet("nope", "whatever", null, { nowMs: BASE })).resolves.toBe(false);
        // expected 与 next 同时 null：既不比较也不写入 → 无意义，显式报错
        await expect(store.compareAndSet("lock", null, null, { nowMs: BASE })).rejects.toThrow(TypeError);
    });

    it("非法参数显式报错，不静默按缺省值处理", async () => {
        const store = createStore(backend);
        await expect(store.consume("k", { capacity: 1, refillPerSec: 1, cost: 0, nowMs: BASE })).rejects.toThrow(RangeError);
        await expect(store.consume("k", { capacity: -1, refillPerSec: 1, nowMs: BASE })).rejects.toThrow(RangeError);
        await expect(store.consume("k", { capacity: Number.NaN, refillPerSec: 1, nowMs: BASE })).rejects.toThrow(RangeError);
        await expect(
            store.consume("k", { capacity: 1, refillPerSec: 1, cost: Number.NaN, nowMs: BASE }),
        ).rejects.toThrow(RangeError);
        await expect(store.consume("k", { capacity: 1, refillPerSec: -1, nowMs: BASE })).rejects.toThrow(RangeError);
        await expect(
            store.consume("k", { capacity: 1, refillPerSec: Number.POSITIVE_INFINITY, nowMs: BASE }),
        ).rejects.toThrow(RangeError);
        await expect(store.set("k", null as unknown as string, { nowMs: BASE })).rejects.toThrow(TypeError);
        await expect(store.set("k", 42 as unknown as string, { nowMs: BASE })).rejects.toThrow(TypeError);
        await expect(store.incrBy("k", Number.NaN, { nowMs: BASE })).rejects.toThrow(RangeError);
        await expect(store.incrBy("k", 1, { ttlMs: 0, nowMs: BASE })).rejects.toThrow(RangeError);
        await expect(store.compareAndSet("k", null, 1 as unknown as string, { nowMs: BASE })).rejects.toThrow(TypeError);
    });

    it("同一个 key 只能归属一种语义：跨语义访问一律显式报错", async () => {
        const store = createStore(backend);
        // ① 先当令牌桶用，再想当 KV 用 → 报错
        expect((await store.consume("bucketFirst", { capacity: 1, refillPerSec: 1, nowMs: BASE })).allowed).toBe(true);
        await expect(store.set("bucketFirst", "1", { nowMs: BASE })).rejects.toThrow(TypeError);
        await expect(store.get("bucketFirst", { nowMs: BASE })).rejects.toThrow(TypeError);
        await expect(store.compareAndSet("bucketFirst", null, "1", { nowMs: BASE })).rejects.toThrow(TypeError);
        await expect(store.delete("bucketFirst")).rejects.toThrow(TypeError);

        // ② 先当 KV 用，再想当令牌桶 / 计数器用 → 报错
        await store.set("kvFirst", "1", { nowMs: BASE });
        await expect(store.consume("kvFirst", { capacity: 1, refillPerSec: 1, nowMs: BASE })).rejects.toThrow(TypeError);
        await expect(store.incrBy("kvFirst", 1, { nowMs: BASE })).rejects.toThrow(TypeError);

        // ③ 先当计数器用，再想当 KV 用 → 报错
        await store.incrBy("counterFirst", 1, { nowMs: BASE });
        await expect(store.get("counterFirst", { nowMs: BASE })).rejects.toThrow(TypeError);
        await expect(store.delete("counterFirst")).rejects.toThrow(TypeError);
    });

    // 设计 §9.2 明文要求：缺这条等于没验
    it("并发反证：capacity=10 的桶被 50 个并发消费，必须恰好 10 个放行、40 个拒绝", async () => {
        const store = createStore(backend);
        const opts = { capacity: 10, refillPerSec: 0, nowMs: BASE };
        const results = await Promise.all(Array.from({ length: 50 }, () => store.consume("burst", opts)));

        const allowed = results.filter((r) => r.allowed);
        const denied = results.filter((r) => !r.allowed);
        expect(allowed).toHaveLength(10);
        expect(denied).toHaveLength(40);
        // 恰好耗尽：10 个放行的剩余令牌正好是 9..0，不多不少（多放行 1 个这里就变成 10 个元素）
        expect(allowed.map((r) => r.remaining).sort((a, b) => b - a)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
        // remaining 永不为负
        expect(results.every((r) => r.remaining >= 0)).toBe(true);
        expect((await store.consume("burst", opts)).remaining).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 未实现后端必须显式报错（设计 §3.3：禁止静默回落内存）
// 这条是「多实例各算各的额度」的唯一防线，所以单独一个 describe，且断言到错误类型。
// ---------------------------------------------------------------------------
describe("createStateStore 降级路径反证", () => {
    it("durable_object 后端未实现 → 抛 StateStoreNotImplementedError，绝不返回内存实现", () => {
        expect(() => createStateStore({ backend: "durable_object" })).toThrow(StateStoreNotImplementedError);
        expect(() => createStateStore({ backend: "durable_object" })).toThrow(/禁止静默回落/);
    });

    it("redis 后端未实现 → 同样抛错", () => {
        expect(() => createStateStore({ backend: "redis" })).toThrow(StateStoreNotImplementedError);
    });

    it("未知后端 → 抛 TypeError（连枚举都不认识，不能静默造一个实例）", () => {
        expect(() => createStateStore({ backend: "postgres" as unknown as StateStoreBackend })).toThrow(TypeError);
    });

    it("memory 后端可用，且满足 StateStore 契约（正对照）", async () => {
        const store = createStateStore({ backend: "memory" });
        await expect(store.consume("k", { capacity: 1, refillPerSec: 0, nowMs: BASE })).resolves.toEqual({
            allowed: true,
            remaining: 0,
            retryAfterMs: 0,
        });
    });
});

// ---------------------------------------------------------------------------
// 共享性边界：memory = per-isolate，不跨 isolate 共享（S2 由 StateStoreDO 解决）
//
// 这条用例的价值不在断言实现，而在于把「worker 门绿 ≠ 跨 isolate 共享生效」这件事
// 写进**测试产物**（而不仅是注释）：worker 模式跑本文件只是跑在 vitest 的 node 进程里，
// 它只能证明「模块可加载 / 工厂分支正确 / 契约一致」，证明不了 workerd 里多个 isolate 之间的共享性。
// 不这样标出来，后人极容易把 worker 门的绿读成「P0-2 / P0-3 已修」。
// ---------------------------------------------------------------------------
describe("memory 后端的共享性边界：per-isolate，不跨 isolate 共享（S2 由 StateStoreDO 解决）", () => {
    it("memory 后端是 per-isolate 语义：每次 create 得到独立状态，额度会被放大成「isolate 数 × 额度」", async () => {
        // ① 意图标注：工厂的 memory 分支就是内存实现，没有隐藏的全局单例
        expect(createStateStore({ backend: "memory" })).toBeInstanceOf(MemoryStateStore);

        // ② 行为对照：把两个实例当成两个 isolate（每个 isolate 各一份内存）
        const isolateA = createStateStore({ backend: "memory" });
        const isolateB = createStateStore({ backend: "memory" });
        const opts = { capacity: 1, refillPerSec: 0, nowMs: BASE };

        // A 内额度用尽
        await expect(isolateA.consume("tenant:1:model:1", opts)).resolves.toEqual({
            allowed: true,
            remaining: 0,
            retryAfterMs: 0,
        });
        await expect(isolateA.consume("tenant:1:model:1", opts)).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: null,
        });
        // B 完全不受影响 → 同一个 key 在两个 isolate 里各放行一次：
        // 这就是「多 isolate 不共享 → 实际额度 = isolate 数 × 额度」的可执行证据（已知限制）。
        await expect(isolateB.consume("tenant:1:model:1", opts)).resolves.toEqual({
            allowed: true,
            remaining: 0,
            retryAfterMs: 0,
        });
    });
});

// ---------------------------------------------------------------------------
// 内存实现专属：键数上界保护（无界增长 = 内存泄漏）
// 这些用例验证的是「回收是语义等价的」，因此必须同时给出「不该回收的没被回收」的反证。
// ---------------------------------------------------------------------------
describe("memoryStateStore 键数上界保护", () => {
    it("顶到上界后新 key 一律拒绝：限流 fail-closed、其它写操作显式抛错，键数不越界", async () => {
        const store = new MemoryStateStore({ maxKeys: 2, idleEvictMs: 1000, cleanupIntervalMs: 60_000 });
        expect((await store.consume("a", { capacity: 1, refillPerSec: 0, nowMs: BASE })).allowed).toBe(true);
        expect((await store.consume("b", { capacity: 1, refillPerSec: 0, nowMs: BASE })).allowed).toBe(true);
        expect(store.size()).toBe(2);

        // 两个桶都还有令牌被消耗（未回满）→ 不可回收 → 新 key 被拒绝（fail-closed）
        await expect(store.consume("c", { capacity: 1, refillPerSec: 0, nowMs: BASE })).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: null,
        });
        expect(store.size()).toBe(2);
        // KV 写无法用 boolean 表达失败，必须显式报错（不能静默丢弃）
        await expect(store.set("d", "1", { nowMs: BASE })).rejects.toThrow(StateStoreUnavailableError);
        await expect(store.incrBy("e", 1, { nowMs: BASE })).rejects.toThrow(StateStoreUnavailableError);
        expect(store.size()).toBe(2);
        // 已存在的 key 仍可正常使用（上界只拦「新建 key」）
        expect((await store.consume("a", { capacity: 1, refillPerSec: 1, nowMs: BASE + 1000 })).allowed).toBe(true);
    });

    it("空转满桶会被回收，且回收前后行为完全一致（等价性）", async () => {
        const store = new MemoryStateStore({ maxKeys: 2, idleEvictMs: 1000, cleanupIntervalMs: 1000 });
        // a：capacity=2，消耗 1 个 → 剩 1
        expect((await store.consume("a", { capacity: 2, refillPerSec: 1, nowMs: BASE })).remaining).toBe(1);
        expect(store.size()).toBe(1);
        // BASE+2000：a 已按速率回满且空闲 ≥ idleEvictMs → 清扫时回收；
        // 因为要证明「被回收」，这里用另一个 key 触发清扫，再看 size 没有涨到 2。
        expect((await store.consume("b", { capacity: 1, refillPerSec: 0, nowMs: BASE + 2000 })).allowed).toBe(true);
        expect(store.size()).toBe(1);
        // 重建后的 a 仍是满桶 → 行为与「没被回收」一致（剩 1）
        expect((await store.consume("a", { capacity: 2, refillPerSec: 1, nowMs: BASE + 2000 })).remaining).toBe(1);
    });

    it("没回满的桶不会被回收——回收不能变成「凭空发额度」", async () => {
        const store = new MemoryStateStore({ maxKeys: 5, idleEvictMs: 1000, cleanupIntervalMs: 1000 });
        // c：capacity=5，refillPerSec=0，消耗 1 个 → 剩 4，永远不会回满
        expect((await store.consume("c", { capacity: 5, refillPerSec: 0, nowMs: BASE })).remaining).toBe(4);
        // 长时间空闲后触发清扫（用另一个 key），c 必须还在
        expect((await store.consume("d", { capacity: 1, refillPerSec: 0, nowMs: BASE + 100_000 })).allowed).toBe(true);
        expect(store.size()).toBe(2);
        // 关键：c 没有被回收，剩余额度仍是 4 而不是回到 5 —— 4 次放行后第 5 次必须被拒
        const opts = { capacity: 5, refillPerSec: 0, nowMs: BASE + 100_000 };
        expect((await store.consume("c", opts)).allowed).toBe(true);
        expect((await store.consume("c", opts)).allowed).toBe(true);
        expect((await store.consume("c", opts)).allowed).toBe(true);
        expect((await store.consume("c", opts)).allowed).toBe(true);
        expect((await store.consume("c", opts)).allowed).toBe(false);
    });

    it("过期条目在清扫时被回收（计数器 / 缓存本来就带 TTL，「可丢」）", async () => {
        const store = new MemoryStateStore({ maxKeys: 5, idleEvictMs: 1000, cleanupIntervalMs: 1000 });
        await store.set("x", "1", { ttlMs: 100, nowMs: BASE });
        await store.incrBy("y", 1, { ttlMs: 100, nowMs: BASE });
        expect(store.size()).toBe(2);
        // 到点后一次清扫（由别的 key 触发）即回收
        await store.consume("z", { capacity: 1, refillPerSec: 0, nowMs: BASE + 1000 });
        expect(store.size()).toBe(1);
        expect(await store.get("x", { nowMs: BASE + 1000 })).toBeNull();
    });

    it("参数校验：非法 maxKeys / idleEvictMs / cleanupIntervalMs 构造即报错", () => {
        expect(() => new MemoryStateStore({ maxKeys: 0 })).toThrow(RangeError);
        expect(() => new MemoryStateStore({ maxKeys: 1.5 })).toThrow(RangeError);
        expect(() => new MemoryStateStore({ idleEvictMs: -1 })).toThrow(RangeError);
        expect(() => new MemoryStateStore({ cleanupIntervalMs: 0 })).toThrow(RangeError);
    });
});
