import pluginRegistry from "./pluginRegistry";
import addSessionHeader from "./addSessionHeader";
import { cchRewriter } from "./cchRewriter";
import claudeCodeTrackingRewriter from "./claudeCodeTrackingRewriter";
import responsesPromptCacheKeyRewriter from "./responsesPromptCacheKeyRewriter";
import type { RequestPlugin } from "./types";

/**
 * 内置请求插件清单 + 注册（模块加载时执行一次）。
 *
 * 为什么用「模块副作用注册」而不是在别处手动 `register` 一遍：
 * - 注册中心的语义是「插件自注册」，加插件只加一个文件 + 一行 import，不维护第二份清单；
 * - `registerAll` 是原子的：任一插件名冲突/形状非法，整体不注册并抛错，启动即失败，
 *   不会留一半注册的中间态。
 *
 * 谁负责 import 这个模块：任何需要「插件可用」的入口。当前是 `service/ruleService.ts`
 * （保存规则时要校验 `config.plugin` 是否存在）与 `service/pluginService.ts`（执行时取插件）。
 */
export const BUILTIN_PLUGINS: readonly RequestPlugin[] = [
    claudeCodeTrackingRewriter,
    cchRewriter,
    responsesPromptCacheKeyRewriter,
    addSessionHeader,
];

pluginRegistry.registerAll(BUILTIN_PLUGINS);

export default BUILTIN_PLUGINS;
