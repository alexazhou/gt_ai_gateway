import type { ApiFormat } from "../constants";
import pluginRegistry from "../plugin/pluginRegistry";
// 内置插件注册（模块副作用）：执行时要按名取到插件
import "../plugin/builtinPlugins";
import { applyBodyPatch, applyHeaderPatch } from "../plugin/patch/applyPatch";
import { PatchRejectedError } from "../plugin/patch/errors";
import type { PluginHook, PluginPatchResult, RequestPlugin } from "../plugin/types";
import type { MatchedPluginRule } from "./ruleService";

/**
 * 请求插件管线（step2_technical.md §4）。
 *
 * 职责边界：
 * - **规则层**已经算好本次要执行哪些规则、按什么顺序（`ruleService.matchPluginRules`）；
 * - 本模块按顺序逐条执行，把插件返回的声明式补丁落地到请求体/请求头上；
 * - **不写时间线**：留痕归 senderService（它才知道 recordId 与最终级别），
 *   本模块只把「执行了哪些、出了哪些问题」原样带回。
 *
 * 容错口径（产品文档「异常不阻断」）：
 * - 插件抛错、补丁被拒、插件名未注册 ⇒ 该条规则**跳过**，记一条 issue，其余规则继续跑，请求照常发出；
 * - 某条规则的补丁被整份拒绝时，前序规则已经产生的改动保留（它们本身是合法改动），只有这一条不生效。
 */

/** 一条规则执行完的留痕信息（只记路径，不记内容） */
export interface PluginExecutionEntry {
    hook: PluginHook;
    plugin: string;
    rule: { id: number; name: string };
    priority: number;
    /** 本次真正生效的路径：请求体为 JSON Pointer，请求头为 `header:<小写头名>` */
    paths: string[];
}

/** 执行过程中的问题（不阻断转发，最终由调用方记为 warn 时间线） */
export interface PluginIssue {
    hook: PluginHook;
    plugin: string;
    rule: { id: number; name: string };
    reason: string;
}

export interface ApplyPluginsOptions {
    hook: PluginHook;
    /** 当前阶段请求体（JSON 文本）；跨协议时 before 是客户端格式、after 是上游格式 */
    body: string;
    /** 当前请求头快照；插件只能通过 headerPatch 表达改动 */
    headers: Headers;
    /** 已按 (priority ASC, id ASC) 排好序的命中规则 */
    matchedRules: readonly MatchedPluginRule[];
    /** 插件上下文（不含 hook，hook 由本函数按入参补齐） */
    context: {
        clientModel: string;
        clientFormat: ApiFormat;
        upstreamFormat: ApiFormat;
        /** 当前阶段所属协议：before = clientFormat，after = upstreamFormat */
        currentFormat: ApiFormat;
        hostKey: string;
        clientName: string | null | undefined;
    };
}

export interface ApplyPluginsResult {
    /** 处理后的请求体文本；本阶段没有任何改动时**原样返回入参字符串**（不重新序列化） */
    body: string;
    /** 处理后的请求头（新对象；无改动时是入参的副本） */
    headers: Headers;
    executed: PluginExecutionEntry[];
    issues: PluginIssue[];
}

function reasonOf(error: unknown): string {
    if (error instanceof PatchRejectedError) {
        return `${error.code}${error.path ? ` @ ${error.path}` : ""}: ${error.message}`;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/** 取本阶段该跑的钩子：插件没实现这个阶段就跳过（按需实现钩子是设计契约） */
function handlerOf(plugin: RequestPlugin, hook: PluginHook) {
    return hook === "before_conversion" ? plugin.beforeConversion : plugin.afterConversion;
}

/**
 * 在单个阶段执行所有命中的插件规则。
 *
 * `body` 只有在本阶段真的发生改动时才是新序列化的字符串：没改动就原样返回，
 * 避免一次无意义的 parse/stringify 造成字节差异（stream log 与 inspect 快照依赖这点）。
 */
export async function applyRequestPlugins(options: ApplyPluginsOptions): Promise<ApplyPluginsResult> {
    const { hook, matchedRules } = options;
    let currentHeaders = new Headers(options.headers);
    const executed: PluginExecutionEntry[] = [];
    const issues: PluginIssue[] = [];

    if (matchedRules.length === 0) {
        return { body: options.body, headers: currentHeaders, executed, issues };
    }

    let bodyObject: Record<string, unknown>;
    try {
        const parsed = JSON.parse(options.body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            // 非 JSON 对象请求体：插件是 JSON 补丁模型，无从下手，按「无插件处理」跳过（不是错误）
            return { body: options.body, headers: currentHeaders, executed, issues };
        }
        bodyObject = parsed as Record<string, unknown>;
    } catch {
        return { body: options.body, headers: currentHeaders, executed, issues };
    }

    let bodyChanged = false;
    const context = { ...options.context, hook };

    for (const matched of matchedRules) {
        const ruleRef = { id: Number(matched.rule.id), name: String(matched.rule.name ?? "") };
        const pluginName = matched.pluginName;

        if (!pluginName) {
            issues.push({ hook, plugin: "", rule: ruleRef, reason: "rule config has no plugin name" });
            continue;
        }

        const plugin = pluginRegistry.get(pluginName);
        if (!plugin) {
            issues.push({ hook, plugin: pluginName, rule: ruleRef, reason: "plugin is not registered" });
            continue;
        }

        const handler = handlerOf(plugin, hook);
        if (!handler) {
            // 该插件不处理这个阶段（例如只实现 beforeConversion）——按设计静默跳过，不算问题
            continue;
        }

        let patchResult: PluginPatchResult | void;
        try {
            // 传只读视图：插件只该读、用补丁表达改动。对象/Headers 本身防不住越权写，
            // 真正的边界在 applyBodyPatch / applyHeaderPatch 上（受保护字段/头一律拒绝）
            patchResult = handler(
                { body: bodyObject as Readonly<Record<string, unknown>>, headers: currentHeaders },
                context,
                matched.pluginConfig ?? {},
            );
        } catch (e) {
            issues.push({ hook, plugin: pluginName, rule: ruleRef, reason: reasonOf(e) });
            continue;
        }

        if (!patchResult) {
            continue;
        }

        const paths: string[] = [];

        if (patchResult.bodyPatch && patchResult.bodyPatch.length > 0) {
            try {
                const applied = applyBodyPatch(bodyObject, patchResult.bodyPatch);
                bodyObject = applied.value;
                bodyChanged = true;
                paths.push(...applied.applied);
            } catch (e) {
                issues.push({ hook, plugin: pluginName, rule: ruleRef, reason: reasonOf(e) });
            }
        }

        if (patchResult.headerPatch) {
            try {
                const applied = applyHeaderPatch(currentHeaders, patchResult.headerPatch);
                currentHeaders = applied.value;
                paths.push(...applied.applied.map((name) => `header:${name}`));
            } catch (e) {
                issues.push({ hook, plugin: pluginName, rule: ruleRef, reason: reasonOf(e) });
            }
        }

        if (paths.length > 0) {
            executed.push({
                hook,
                plugin: pluginName,
                rule: ruleRef,
                priority: Number(matched.rule.priority ?? 0),
                paths,
            });
        }
    }

    return {
        body: bodyChanged ? JSON.stringify(bodyObject) : options.body,
        headers: currentHeaders,
        executed,
        issues,
    };
}

export default { applyRequestPlugins };
