import type { ApiFormat } from "../constants";

/**
 * 请求插件框架的类型契约（对应 design/2026-11-24-generic-plugin/step2_technical.md §2）。
 *
 * 分层约定：
 * - 规则层（rule 表 + ruleService）负责「对谁生效、按什么顺序」，插件层完全不知道优先级；
 * - 插件层只实现「怎么改写」，通过声明式补丁返回结果，不直接改请求对象；
 * - 管线层（pluginService + senderService）负责匹配、按序执行、边界拦截与留痕。
 */

/**
 * 插件钩子。
 *
 * - 同协议直通：只触发 `before_conversion`；
 * - 跨协议转换：转换前后各触发一次（`before_conversion` 看到的是客户端格式请求体，
 *   `after_conversion` 看到的是上游格式请求体，用 `context.currentFormat` 区分）。
 */
export type PluginHook = "before_conversion" | "after_conversion";

/**
 * RFC 6902 JSON Patch 的操作子集：只允许 add / replace / remove。
 *
 * 不支持 move / copy / test：插件改写请求不需要搬移子树，少三种操作就少三处边界。
 */
export type JsonPatchOp =
    | { op: "add"; path: string; value: unknown }
    | { op: "replace"; path: string; value: unknown }
    | { op: "remove"; path: string };

/** 请求头补丁：按名设置 / 按名删除，受保护头一律拒绝（见 patch/headers.ts） */
export interface HeaderPatch {
    set?: Record<string, string>;
    remove?: string[];
}

/** 插件返回的声明式补丁：两者都可省略；都省略等价于「本插件不处理该请求」 */
export interface PluginPatchResult {
    bodyPatch?: JsonPatchOp[];
    headerPatch?: HeaderPatch;
}

/**
 * 插件执行上下文：全部只读。
 *
 * 不含 `vendor_id` 等匹配维度（规则匹配已在管线层完成），`userId` 是唯一例外：
 * session 头要按用户区分会话身份，拿不到就只能退化成全局唯一的弱标识。
 */
export interface PluginContext {
    readonly hook: PluginHook;
    readonly clientModel: string;
    readonly clientFormat: ApiFormat;
    readonly upstreamFormat: ApiFormat;
    /** 当前请求体所属协议：转换前 == clientFormat，转换后 == upstreamFormat */
    readonly currentFormat: ApiFormat;
    readonly hostKey: string;
    readonly clientName: string | null | undefined;
    /** 发起本次请求的网关用户 id（鉴权结果） */
    readonly userId: number;
}

/**
 * 钩子实现。
 *
 * `request.body` 是只读视图，插件**不得**就地改写；要改就返回 `bodyPatch`。
 * `request.headers` 是网关已构造好的上游请求头快照，同样只读取值、用 `headerPatch` 表达改动。
 * 返回 `void` / `undefined` 表示不处理。允许返回 Promise：需要哈希的插件（如 session id）
 * 只能用异步 WebCrypto 取摘要，管线侧统一 `await`。
 */
export type PluginHookHandler = (
    request: { readonly body: Readonly<Record<string, unknown>>; readonly headers: Headers },
    context: PluginContext,
    pluginConfig: Record<string, unknown>,
) => PluginPatchResult | void | Promise<PluginPatchResult | void>;

/**
 * 内置请求插件。
 *
 * 名称即规则 `config.plugin` 里填的标识，注册后不可变（重复注册直接报错，避免静默覆盖）。
 * 插件自身**不设优先级**——执行顺序完全由命中规则的 `(priority ASC, id ASC)` 决定。
 */
export interface RequestPlugin {
    readonly name: string;
    readonly description?: string;
    readonly configExample?: Record<string, unknown>;
    readonly beforeConversion?: PluginHookHandler;
    readonly afterConversion?: PluginHookHandler;
    /**
     * 规则保存时校验 `pluginConfig`（由 ruleService 调用），不合法直接抛错 → 接口返回 400。
     * 未实现则视为「接受任意参数」。
     */
    validateConfig?(pluginConfig: Record<string, unknown>): void;
}
