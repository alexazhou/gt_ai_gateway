import { MemoryStateStore, type MemoryStateStoreOptions } from "./memoryStateStore";
import { StateStoreNotImplementedError, type StateStore } from "./types";

/**
 * 后端标识。
 * - memory：node / 桌面模式，单进程内存（原子性来自 JS 单线程）
 * - durable_object：workerd 模式（S2 实现，binding 名恒定 STATE_STORE）
 * - redis：多机部署（预留，S3 之后）
 */
export type StateStoreBackend = "memory" | "durable_object" | "redis";

/** 工厂参数：只放「按后端取值」的必填项，未实现的参数不预埋占位字段 */
export interface CreateStateStoreOptions {
    backend: StateStoreBackend;
    /** 仅 memory 后端使用（上界 / 回收阈值，生产用缺省值） */
    memory?: MemoryStateStoreOptions;
}

/**
 * 按后端创建 StateStore 实例。
 *
 * 契约：**未实现的后端必须显式抛 StateStoreNotImplementedError，禁止静默回落内存**。
 * 静默回落 = 多实例部署时每个实例各算各的额度（限流形同虚设），这是本层存在的主要理由，
 * 所以宁可让部署在启动时就炸，也不留一个「看起来能跑」的降级路径。
 */
export function createStateStore(options: CreateStateStoreOptions): StateStore {
    switch (options.backend) {
        case "memory":
            return new MemoryStateStore(options.memory);
        case "durable_object":
            throw new StateStoreNotImplementedError(
                'StateStore backend "durable_object" 尚未实现（计划 S2）：禁止静默回落到内存实现 —— ' +
                    "多实例下每进程各算各的额度等于没有限流。",
            );
        case "redis":
            throw new StateStoreNotImplementedError(
                'StateStore backend "redis" 尚未实现（多机部署预留）：同样禁止静默回落到内存实现。',
            );
        default: {
            const unknown: never = options.backend;
            throw new TypeError(`未知的 StateStore backend: ${String(unknown)}`);
        }
    }
}

export { MemoryStateStore } from "./memoryStateStore";
export type { MemoryStateStoreOptions } from "./memoryStateStore";
export * from "./types";
