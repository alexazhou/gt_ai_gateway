import customError from "../customError";
import { PROTECTED_HEADER_PREFIXES, PROTECTED_HEADERS } from "./patch/headers";
import type { PluginHookHandler, RequestPlugin } from "./types";

/**
 * 「自动生成 session header」请求插件：给上游请求注入会话标识头，供上游按会话聚合缓存 / 计费。
 *
 * session id 由 (用户 id, system prompt, 第一条 user 消息) 确定性生成（UUIDv5）：
 * 同一用户在同一段会话里每轮请求都会带上同样长的历史，但 system prompt 与第一条 user 消息不变，
 * 因此 id 跨轮次、跨进程、跨重启都相同；compact 之后首条消息变化，才自然切换成新 session。
 */

/** 默认头名：与 TeamAgent 现在发给上游的一致（`src/constants.py` 的 `LLM_SESSION_HEADER`） */
export const DEFAULT_SESSION_HEADER = "X-Session-Id";

/** RFC 4122 NAMESPACE_URL，UUIDv5 的固定命名空间 */
const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
/** UUIDv5 name 前缀：网关自己的域，不引用任何客户端产品的标识 */
const SESSION_ID_NAME_PREFIX = "ai-gateway/session";

/** HTTP header 名的合法字符（RFC 7230 token） */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;


/** 16 字节 → 标准 UUID 字符串 */
function formatUuid(bytes: Uint8Array): string {
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}


function parseUuid(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, "");
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}


/** RFC 4122 §4.3 UUIDv5：namespace 字节 + name 字节做 SHA-1，取前 16 字节并写入版本 / 变体位 */
export async function uuid5(namespaceUuid: string, name: string): Promise<string> {
    const namespaceBytes = parseUuid(namespaceUuid);
    const nameBytes = new TextEncoder().encode(name);
    const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
    input.set(namespaceBytes, 0);
    input.set(nameBytes, namespaceBytes.length);

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
    const out = digest.slice(0, 16);
    out[6] = (out[6] & 0x0f) | 0x50;
    out[8] = (out[8] & 0x3f) | 0x80;
    return formatUuid(out);
}


/** 消息 content 取文本：字符串 / 文本块数组（OpenAI、Anthropic、Responses 三种形态） */
function contentText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === "string") {
                return part;
            }
            if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
                return (part as { text: string }).text;
            }
            return "";
        }).join("");
    }
    if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
        return (content as { text: string }).text;
    }
    return "";
}


function contentByRole(messages: unknown, role: string): string {
    if (!Array.isArray(messages)) {
        return "";
    }
    for (const message of messages) {
        if (message && typeof message === "object" && (message as { role?: unknown }).role === role) {
            return contentText((message as { content?: unknown }).content);
        }
    }
    return "";
}


/**
 * 从请求体提取会话锚点：system prompt 与第一条 user 消息。
 *
 * 兼容三种协议形态：OpenAI（`messages` + role=system）、Anthropic（`system` 顶字段）、
 * Responses（`instructions` + `input`，input 可能是字符串或消息数组）。
 */
export function extractSessionSeed(body: Readonly<Record<string, unknown>>): {
    systemPrompt: string;
    firstUserMessage: string;
} {
    const messages = body.messages ?? body.input;
    const systemPrompt = contentText(body.system)
        || contentText(body.instructions)
        || contentByRole(body.messages, "system");
    const firstUserMessage = typeof body.input === "string"
        ? body.input
        : contentByRole(messages, "user");
    return { systemPrompt, firstUserMessage };
}


/** 由用户 id + 会话锚点算出 session id（UUIDv5，确定性） */
export async function buildSessionId(
    userId: number,
    systemPrompt: string,
    firstUserMessage: string,
): Promise<string> {
    return uuid5(UUID_NAMESPACE_URL, `${SESSION_ID_NAME_PREFIX}:user:${userId}:${systemPrompt}\u0000${firstUserMessage}`);
}


/** 头名：配置优先，缺省用默认头 */
export function resolveSessionHeader(pluginConfig: Record<string, unknown>): string {
    const configured = pluginConfig.header;
    if (typeof configured === "string" && configured.trim() !== "") {
        return configured.trim();
    }
    return DEFAULT_SESSION_HEADER;
}


const applyHook: PluginHookHandler = async (request, context, pluginConfig) => {
    const { systemPrompt, firstUserMessage } = extractSessionSeed(request.body);
    // 没有任何消息时退回整份请求体：宁可多算一次哈希，也不要让这个头在某些请求上静默缺失
    const anchorMessage = firstUserMessage || JSON.stringify(request.body);
    const sessionId = await buildSessionId(context.userId, systemPrompt, anchorMessage);
    return { headerPatch: { set: { [resolveSessionHeader(pluginConfig)]: sessionId } } };
};


export const addSessionHeader: RequestPlugin = {
    name: "addSessionHeader",
    description: "按「用户 + system prompt + 第一条消息」生成会话 id，注入上游请求头（默认 X-Session-Id）",
    configExample: { header: DEFAULT_SESSION_HEADER },
    beforeConversion: applyHook,
    afterConversion: applyHook,
    /** 参数只有 header（头名），且必须是合法、非受保护的 HTTP 头名 */
    validateConfig(pluginConfig: Record<string, unknown>): void {
        for (const key of Object.keys(pluginConfig)) {
            if (key !== "header") {
                throw new customError.AppError(`addSessionHeader only accepts "header", got: ${key}`);
            }
        }
        const raw = pluginConfig.header;
        if (raw === undefined || raw === null) {
            return;
        }
        if (typeof raw !== "string") {
            throw new customError.AppError("addSessionHeader config.header must be a string");
        }
        const header = raw.trim();
        if (header === "") {
            throw new customError.AppError("addSessionHeader config.header must not be empty");
        }
        if (!HEADER_NAME_PATTERN.test(header)) {
            throw new customError.AppError(`addSessionHeader config.header is not a valid HTTP header name: ${header}`);
        }
        const lower = header.toLowerCase();
        if (PROTECTED_HEADERS.has(lower) || PROTECTED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
            throw new customError.AppError(`addSessionHeader config.header is a protected header: ${header}`);
        }
    },
};

export default addSessionHeader;
