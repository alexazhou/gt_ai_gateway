import { SgVendor } from "../model/sgVendor";
import { ApiFormat } from "../constants";
import customError from "../util/customError";


/**
 * 校验代理配置：代理类型与 URL scheme 必须匹配
 */
function validateProxyConfig(config?: Record<string, any>): void {
    const proxy = config?.proxy;
    if (!proxy || !proxy.url) return;

    const url = proxy.url as string;
    const isSocks = url.startsWith("socks");

    if (proxy.type === "http" && isSocks) {
        throw new customError.AppError("代理类型为 HTTP，但 URL 使用了 SOCKS 协议");
    }
    if (proxy.type === "socks5" && !isSocks) {
        throw new customError.AppError("代理类型为 SOCKS5，但 URL 不是 SOCKS 协议");
    }
}


async function getVendorByName(name: string): Promise<SgVendor | null> {
    if (name == null) {
        return null;
    }

    return await SgVendor.query().where("name", name).first();
}


async function updateVendor(
    vendorId: number,
    data: { type?: string; name?: string; token?: string; urls?: Record<string, string>; config?: Record<string, any> },
): Promise<SgVendor | null> {
    validateProxyConfig(data.config);

    const vendor = await SgVendor.query().find(vendorId);

    if (!vendor) {
        return null;
    }

    const updateData: any = {
        type: data.type ?? vendor.type,
        name: data.name ?? vendor.name,
        token: data.token ?? vendor.token,
    };

    // query().update() 是裸 SQL 拼接，不走 casts，对象类型字段需手动序列化
    if (data.urls !== undefined) {
        updateData.urls = JSON.stringify(data.urls);
    }

    if (data.config !== undefined) {
        updateData.config = JSON.stringify(data.config);
    }

    await SgVendor.query()
        .where("id", vendorId)
        .update(updateData);

    return await SgVendor.query().find(vendorId);
}

async function findVendorByUrl(gatewayUrl: string, protocol: ApiFormat): Promise<number | null> {
    if (!gatewayUrl) return null;

    const vendors = await SgVendor.query().get();
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
    const baseUrl = openaiUrl.replace(/\/chat\/completions$/, "");
    const modelsUrl = `${baseUrl}/models`;

    const token = vendor.token;
    const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

    try {
        const response = await fetch(modelsUrl, {
            method: "GET",
            headers: {
                Authorization: authHeader,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new customError.AppError(
                `Upstream returned ${response.status}: ${text}`,
                502,
            );
        }

        const data: any = await response.json();

        const models: string[] = Array.isArray(data?.data)
            ? data.data.map((m: any) => m.id).filter(Boolean).filter(isLlmModel)
            : [];

        return models;
    } catch (err: any) {
        if (err.statusCode) throw err;
        throw new customError.AppError(`Failed to fetch models: ${err.message}`, 502);
    }
}


export default {
    getVendorByName,
    updateVendor,
    findVendorByUrl,
    fetchUpstreamModels,
    validateProxyConfig,
};
