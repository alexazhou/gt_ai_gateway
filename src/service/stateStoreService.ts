import {
    createStateStore,
    type CreateStateStoreOptions,
    type StateStore,
    type StateStoreBackend,
} from "../util/stateStore";

/**
 * 全局 StateStore 单例与生命周期管理。
 *
 * 为什么要这一层：`createStateStore({ backend: "memory" })` 每次调用都会新建一个实例，
 * 而业务层需要「全进程一份」的状态（限流桶、上游冷却、版本检查缓存必须落在同一个键空间里，
 * 否则测试重置、故障注入都只能覆盖到随机构造出来的那一份）。
 *
 * 契约（见 `src/util/stateStore/types.ts`）：
 * - 未显式 `init()` 时按 `STATE_STORE_BACKEND` 环境变量惰性创建，缺省 memory；
 * - 未实现的 backend 由 `createStateStore` 显式抛 `StateStoreNotImplementedError`，
 *   本层不做任何静默回落 —— 多实例部署下「每个进程各算各的额度」等于没有限流。
 */
let currentStore: StateStore | null = null;
let currentOptions: CreateStateStoreOptions = { backend: "memory" };

function resolveBackend(options?: CreateStateStoreOptions): StateStoreBackend {
    const fromEnv = process.env.STATE_STORE_BACKEND;
    return (options?.backend ?? (fromEnv as StateStoreBackend | undefined) ?? "memory") as StateStoreBackend;
}

/**
 * 初始化全局 StateStore（应用启动时可显式调用；不调用也会在首次 `getStore()` 时惰性创建）。
 *
 * @param options 后端与后端专属选项；`backend` 缺省时取 `STATE_STORE_BACKEND`，再缺省 memory
 */
function init(options?: CreateStateStoreOptions): StateStore {
    currentOptions = {
        ...options,
        backend: resolveBackend(options),
    };
    currentStore = createStateStore(currentOptions);
    return currentStore;
}

/**
 * 获取全局 StateStore 单例（不存在时按当前配置惰性创建）。
 */
function getStore(): StateStore {
    if (!currentStore) {
        currentOptions = {
            ...currentOptions,
            backend: resolveBackend(currentOptions),
        };
        currentStore = createStateStore(currentOptions);
    }
    return currentStore;
}

/**
 * 注入自定义实现（测试用：故障模拟 / 计数探针）。传 null 表示丢弃当前实例，下次 `getStore()` 重建。
 */
function setStore(store: StateStore | null): void {
    currentStore = store;
}

/**
 * 重置状态存储（测试隔离用）：基于当前配置重建一份空实例。
 * 注意：注入过的自定义实现会被丢弃 —— 这正是「重置」的语义。
 */
function reset(): StateStore {
    currentStore = createStateStore(currentOptions);
    return currentStore;
}

export default {
    init,
    getStore,
    setStore,
    reset,
};
