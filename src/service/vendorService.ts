import { SgVendor } from "../model/sgVendor";
import { ApiFormat } from "../constants";
import customError from "../customError";
import vendorManager from "../manager/vendorManager";
import maskUtil from "../util/maskUtil";
import objectUtil from "../util/objectUtil";


/**
 * 编辑接口的 token 语义：留空（undefined / "" / 纯空白）= 不修改。
 *
 * 前端拿到的是掩码值，用户不动它就把掩码原样回传，这种情况同样视为「不修改」，
 * 否则一次「只改名字」的保存会把真 token 覆盖成一串 `****`。
 */
function resolveUpdatedToken(input: string | undefined, current: string): string {
    if (input === undefined || input === null) {
        return current;
    }
    if (typeof input !== "string") {
        return current;
    }
    if (input.trim() === "") {
        return current;
    }
    if (maskUtil.isMaskedValue(input) && input === maskUtil.maskToken(current)) {
        return current;
    }
    return input;
}


/**
 * 回传的配置里代理 URL 是掩码形态时，还原成库里的原值，避免「看一眼再保存」把密码抹掉。
 */
function restoreMaskedProxyUrl(config: Record<string, unknown>, current: SgVendor["config"] | null | undefined): Record<string, unknown> {
    if (!objectUtil.isRecord(config)) {
        return config;
    }
    const proxy = config.proxy;
    if (!objectUtil.isRecord(proxy) || typeof proxy.url !== "string") {
        return config;
    }
    const currentProxy = (current as { proxy?: { url?: string } } | null | undefined)?.proxy;
    const currentUrl = typeof currentProxy?.url === "string" ? currentProxy.url : "";
    if (!currentUrl) {
        return config;
    }
    if (proxy.url === currentUrl || proxy.url === maskUtil.maskUrlCredentials(currentUrl)) {
        return { ...config, proxy: { ...proxy, url: currentUrl } };
    }
    return config;
}


/** 拉取上游模型列表的超时（P2-15） */
const UPSTREAM_MODELS_TIMEOUT_MS = 10000;


/**
 * 校验代理配置：代理类型与 URL scheme 必须匹配
 */
function validateProxyConfig(config?: unknown): void {
    if (!objectUtil.isRecord(config)) return;

    const proxy = config.proxy;
    if (!objectUtil.isRecord(proxy)) return;

    const url = typeof proxy.url === "string" ? proxy.url : "";
    if (!url) return;

    const isSocks = url.startsWith("socks");

    if (proxy.type === "http" && isSocks) {
        throw new customError.AppError("代理类型为 HTTP，但 URL 使用了 SOCKS 协议");
    }
    if (proxy.type === "socks5" && !isSocks) {
        throw new customError.AppError("代理类型为 SOCKS5，但 URL 不是 SOCKS 协议");
    }
}


async function updateVendor(
    vendorId: number,
    data: { type?: string; name?: string; token?: string; urls?: Record<string, string>; config?: Record<string, unknown> },
    tenantId?: number,
): Promise<SgVendor | null> {
    validateProxyConfig(data.config);

    const vendor = tenantId !== undefined
        ? await vendorManager.findByIdInTenant(vendorId, tenantId)
        : await vendorManager.findById(vendorId);

    if (!vendor) {
        return null;
    }

    // 供应商名租户内唯一查重（创建 / 更新）
    if (data.name !== undefined && data.name !== vendor.name) {
        const dup = await vendorManager.findByName(data.name, tenantId);
        if (dup && dup.id !== vendorId) {
            throw new customError.AppError("A vendor with this name already exists", 409);
        }
    }

    const updateData: {
        type: string;
        name: string;
        token: string;
        urls?: string;
        config?: string;
    } = {
        type: data.type ?? vendor.type,
        name: data.name ?? vendor.name,
        token: resolveUpdatedToken(data.token, vendor.token),
    };

    // query().update() 是裸 SQL 拼接，不走 casts，对象类型字段需手动序列化
    if (data.urls !== undefined) {
        updateData.urls = JSON.stringify(data.urls);
    }

    if (data.config !== undefined) {
        updateData.config = JSON.stringify(restoreMaskedProxyUrl(data.config, vendor.config));
    }

    return await vendorManager.update(vendorId, updateData, tenantId);
}

async function findVendorByUrl(gatewayUrl: string, protocol: ApiFormat): Promise<number | null> {
    if (!gatewayUrl) return null;

    const vendors = await vendorManager.listAll();
    for (const vendor of vendors) {
        const mergedUrls = vendor.getMergedUrls();
        let vendorUrl: string | undefined;

        if (protocol === ApiFormat.RESPONSES) {
            vendorUrl = mergedUrls[ApiFormat.RESPONSES] || mergedUrls[ApiFormat.OPENAI];
        } else {
            vendorUrl = mergedUrls[protocol];
        }

        if (vendorUrl && gatewayUrl.startsWith(vendorUrl)) {
            return Number(vendor.id);
        }
    }

    return null;
}


const NON_LLM_PATTERNS = [
    /embedding/i,
    /rerank/i,
    /\btts\b/i,
    /text-to-speech/i,
    /speech-to-text/i,
    /whisper/i,
    /dall-e/i,
    /stable-diffusion/i,
    /image/i,
    /image2video/i,
    /video-gen/i,
    /video/i,
    /ocr/i,
    /livetranslate/i,
    /realtime-asr/i,
    /moderation/i,
    /^wanx/i,
    /^wan\d/i,
    /^cosyvoice/i,
    /^sensevoice/i,
    /^sambert/i,
    /^paraformer/i,
];

function isLlmModel(modelId: string): boolean {
    return !NON_LLM_PATTERNS.some(pattern => pattern.test(modelId));
}


/**
 * 从上游 API 获取模型列表
 */
export async function fetchUpstreamModels(vendor: SgVendor): Promise<string[]> {
    const openaiUrl = vendor.getUrlByFormat(ApiFormat.OPENAI);
    if (openaiUrl === null) {
        throw new customError.AppError("vendor does not have url for openai format", 400);
    }
    const baseUrl = openaiUrl.replace(/\/chat\/completions$/, "");
    const modelsUrl = `${baseUrl}/models`;

    const token = vendor.token;
    const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

    try {
        // 必须有超时：上游不响应时这个请求会一直挂着，前端「拉取模型」按钮转圈到天荒地老（P2-15）
        const response = await fetch(modelsUrl, {
            method: "GET",
            headers: {
                Authorization: authHeader,
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(UPSTREAM_MODELS_TIMEOUT_MS),
        });

        if (!response.ok) {
            // 不回传上游 body：里面可能带上游的内部标识/凭据线索，只给状态码
            throw new customError.AppError(
                `Upstream returned ${response.status}`,
                502,
            );
        }

        const data: unknown = await response.json();

        const models: string[] = objectUtil.isRecord(data) && Array.isArray(data.data)
            ? data.data
                .map((model) => objectUtil.isRecord(model) && typeof model.id === "string" ? model.id : null)
                .filter((id): id is string => Boolean(id))
                .filter(isLlmModel)
            : [];

        return models;
    } catch (err) {
        if (customError.isAppError(err)) throw err;
        // 超时/网络错误统一成可读文案；不把底层错误详情（可能含 URL/代理地址）透给客户端
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
            throw new customError.AppError(`Failed to fetch models: upstream timeout (${UPSTREAM_MODELS_TIMEOUT_MS}ms)`, 504);
        }
        throw new customError.AppError("Failed to fetch models: upstream unreachable", 502);
    }
}


export default {
    updateVendor,
    findVendorByUrl,
    fetchUpstreamModels,
    validateProxyConfig,
};
