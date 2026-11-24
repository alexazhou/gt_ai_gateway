import type { PluginHook, RequestPlugin } from "./types";

/**
 * 请求插件注册中心（step2_technical.md §2「插件层」）。
 *
 * 设计取舍：
 * - **自注册**：内置插件在模块加载时调用 `register()`，不维护中心清单——加插件只加一个文件，
 *   不做「注册表 + 插件列表」双写（双写必然漂移）。
 * - **名称即契约**：规则 `config.plugin` 存的就是这里注册的 `name`。重复注册直接抛错，
 *   绝不静默覆盖：静默覆盖会让「改了一个插件的行为」变成「改了另一个插件」。
 * - **插件无优先级**：执行顺序由命中规则的 `(priority ASC, id ASC)` 决定，注册顺序不参与排序。
 * - **注册是启动期行为**：`register()` 只在模块初始化时调用；运行期只读（`get` / `list` / `describe`）。
 */

/** 插件名：字母开头，允许字母数字下划线，2~64 字符（与规则 config 里的可读写法一致） */
const PLUGIN_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;

const registry = new Map<string, RequestPlugin>();

/** 插件的对外描述（`GET /rule/plugins.json` 的返回元素） */
export interface PluginDescriptor {
    name: string;
    description: string | null;
    hooks: PluginHook[];
    configExample: Record<string, unknown> | null;
}

function assertPluginShape(plugin: RequestPlugin): void {
    if (!plugin || typeof plugin !== "object") {
        throw new Error("Request plugin must be an object");
    }
    const name = plugin.name;
    if (typeof name !== "string" || !PLUGIN_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid request plugin name: ${String(name)}`);
    }
    if (typeof plugin.beforeConversion !== "function" && typeof plugin.afterConversion !== "function") {
        throw new Error(`Request plugin "${name}" implements no hook (beforeConversion / afterConversion)`);
    }
}

/** 注册一个插件；重复名 / 非法名 / 无任何钩子都直接抛错 */
function register(plugin: RequestPlugin): void {
    assertPluginShape(plugin);
    if (registry.has(plugin.name)) {
        throw new Error(`Request plugin already registered: ${plugin.name}`);
    }
    registry.set(plugin.name, plugin);
}

/** 批量注册（原子）：任一插件非法则整体不注册，避免半注册状态 */
function registerAll(plugins: readonly RequestPlugin[]): void {
    for (const plugin of plugins) {
        assertPluginShape(plugin);
        if (registry.has(plugin.name)) {
            throw new Error(`Request plugin already registered: ${plugin.name}`);
        }
    }
    for (const plugin of plugins) {
        registry.set(plugin.name, plugin);
    }
}

function get(name: string): RequestPlugin | null {
    return registry.get(name) ?? null;
}

function has(name: string): boolean {
    return registry.has(name);
}

/** 已注册插件描述列表，按名称升序（输出稳定，便于接口与快照测试） */
function describe(): PluginDescriptor[] {
    return [...registry.values()]
        .map((plugin) => ({
            name: plugin.name,
            description: plugin.description ?? null,
            hooks: [
                ...(typeof plugin.beforeConversion === "function" ? ["before_conversion" as const] : []),
                ...(typeof plugin.afterConversion === "function" ? ["after_conversion" as const] : []),
            ],
            configExample: plugin.configExample ?? null,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 已注册插件名列表，按名称升序 */
function names(): string[] {
    return [...registry.keys()].sort();
}

/** 仅测试用：清空注册表（生产代码不应调用） */
function resetForTest(): void {
    registry.clear();
}

export default {
    register,
    registerAll,
    get,
    has,
    describe,
    names,
    resetForTest,
};
