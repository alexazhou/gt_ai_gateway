import { ApiFormat } from "../../constants";
import customError from "../../customError";


/**
 * 测试请求的内容模式：纯文本 / 多模态（内置样图 + 文本提示）。
 *
 * 为什么图片要内置：两个测试入口的用途是「验证上游模型能不能收图片」，
 * 而不是「上传一张用户的图」。内置样图让请求体可复现、不引入上传/校验/SSRF，
 * 也不会把用户的图片数据带到上游或落进测试结果的请求快照里。
 */
export type TestContentMode = "text" | "image";

export const TEST_CONTENT_MODES: TestContentMode[] = ["text", "image"];

/** 多模态模式默认提示词（与设计稿一致） */
export const TEST_IMAGE_PROMPT = "请描述这张图片";

export const TEST_IMAGE_MEDIA_TYPE = "image/png";

/**
 * 内置样图：64×64 PNG（230 字节），浅蓝底 + 深蓝边框 + 红色圆点。
 * 体积极小（base64 仅 308 字符）是为了让它整段出现在测试结果的「请求」快照里也不影响可读性。
 * 生成方式：纯色/几何图形手绘后无损压缩，无第三方素材授权问题。
 */
export const TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAArUlEQVR42u3a0Q3CMAwFwM7RRViAjTouC/STCRBdoJBEJDjuSR7gnRIpseVlf76mrgUAAAAAoAtg3fZQdVVAhEsCAAAAAAAA0F6P+20+wBH6rKIDPkRvZowDFKavNQwCVKWvMowANKQvN3QHNKcvNAD0TF9iAACIC/hJ+q8GJwAA4CVODpj+N5qhH8jQkWXoiTNMJZLMhYwWAQAAAACCAGyr/A9gYwsAAADgEoA3ZwHRaaGVzkMAAAAASUVORK5CYII=";

export const TEST_IMAGE_DATA_URL = `data:${TEST_IMAGE_MEDIA_TYPE};base64,${TEST_IMAGE_BASE64}`;

/** 供应商连通性测试的图片模式 token 上限（文本模式仍沿用各自的旧值） */
const VENDOR_IMAGE_MAX_TOKENS = 64;

/** 模型可用性测试的图片模式 token 上限 */
const MODEL_ROUTE_IMAGE_MAX_TOKENS = 256;

/** 供应商连通性测试的文本提示词（沿用旧实现） */
const VENDOR_TEXT_PROMPT = "ping";

/** 模型可用性测试的文本提示词（沿用旧实现） */
const MODEL_ROUTE_TEXT_PROMPT = "你好";


/**
 * 校验并归一化 content_mode。
 *
 * 缺省 / 空值 ⇒ text（旧调用方不传时必须完全走文本模式，接口行为不变）；
 * 非法值 ⇒ 400（不静默降级：否则前端写错字段名会被当成文本模式，测试结果看起来「正常」）。
 */
export function normalizeContentMode(value: unknown): TestContentMode {
    if (value === undefined || value === null || value === "") {
        return "text";
    }
    if (value === "text" || value === "image") {
        return value;
    }
    throw new customError.AppError(`content_mode must be one of text, image (got ${String(value)})`);
}


function openaiBody(model: string, mode: TestContentMode, prompt: string, maxTokens: number, withStream: boolean): string {
    // 图片模式用多模态提示词；文本模式沿用各入口原来的 ping / 你好
    const text = mode === "image" ? TEST_IMAGE_PROMPT : prompt;
    const content = mode === "image"
        ? [
            { type: "text", text },
            { type: "image_url", image_url: { url: TEST_IMAGE_DATA_URL } },
        ]
        : prompt;

    const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content }],
        max_tokens: maxTokens,
    };
    // stream 只在模型路由测试保留（沿旧实现：供应商测试不带该字段）
    if (withStream) {
        body.stream = false;
    }
    return JSON.stringify(body);
}


function anthropicBody(model: string, mode: TestContentMode, prompt: string, maxTokens: number): string {
    const text = mode === "image" ? TEST_IMAGE_PROMPT : prompt;
    // Anthropic 推荐图片在前、文本在后（两种顺序都接受，按推荐写法减少兼容性差异）
    const content = mode === "image"
        ? [
            {
                type: "image",
                source: {
                    type: "base64",
                    media_type: TEST_IMAGE_MEDIA_TYPE,
                    data: TEST_IMAGE_BASE64,
                },
            },
            { type: "text", text },
        ]
        : text;

    return JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: maxTokens,
    });
}


function responsesBody(model: string, mode: TestContentMode, prompt: string, maxOutputTokens: number): string {
    const text = mode === "image" ? TEST_IMAGE_PROMPT : prompt;
    if (mode === "text") {
        return JSON.stringify({
            model,
            input: text,
            max_output_tokens: maxOutputTokens,
        });
    }
    return JSON.stringify({
        model,
        input: [{
            role: "user",
            content: [
                { type: "input_text", text },
                // Responses 的 input_image.image_url 是**字符串**，不是 OpenAI 的 { url } 对象
                { type: "input_image", image_url: TEST_IMAGE_DATA_URL },
            ],
        }],
        max_output_tokens: maxOutputTokens,
    });
}


/**
 * 供应商连通性测试（POST /vendor/:id/test.json）的请求体。
 *
 * 文本模式下输出必须与旧实现逐字段一致（回归用例钉住）：
 * OpenAI max_tokens 5 / Anthropic max_tokens 1 / Responses max_output_tokens 16。
 */
export function buildVendorTestBody(format: ApiFormat, model: string, mode: TestContentMode = "text"): string {
    if (format === ApiFormat.ANTHROPIC) {
        return anthropicBody(model, mode, VENDOR_TEXT_PROMPT, mode === "image" ? VENDOR_IMAGE_MAX_TOKENS : 1);
    }
    if (format === ApiFormat.RESPONSES) {
        return responsesBody(model, mode, VENDOR_TEXT_PROMPT, mode === "image" ? VENDOR_IMAGE_MAX_TOKENS : 16);
    }
    return openaiBody(model, mode, VENDOR_TEXT_PROMPT, mode === "image" ? VENDOR_IMAGE_MAX_TOKENS : 5, false);
}


/**
 * 模型可用性测试（POST /model/route-test.json）的请求体。
 *
 * 文本模式与旧 buildTestRequestBody 逐字段一致：OpenAI 256 + stream:false / Anthropic 256 / Responses 256。
 * 图片模式 token 也是 256 —— 旧值本来就够视觉问答，不需要再放宽。
 */
export function buildModelRouteTestBody(format: ApiFormat, model: string, mode: TestContentMode = "text"): string {
    if (format === ApiFormat.ANTHROPIC) {
        return anthropicBody(model, mode, MODEL_ROUTE_TEXT_PROMPT, MODEL_ROUTE_IMAGE_MAX_TOKENS);
    }
    if (format === ApiFormat.RESPONSES) {
        return responsesBody(model, mode, MODEL_ROUTE_TEXT_PROMPT, MODEL_ROUTE_IMAGE_MAX_TOKENS);
    }
    return openaiBody(model, mode, MODEL_ROUTE_TEXT_PROMPT, MODEL_ROUTE_IMAGE_MAX_TOKENS, true);
}


export default {
    normalizeContentMode,
    buildVendorTestBody,
    buildModelRouteTestBody,
    TEST_IMAGE_PROMPT,
    TEST_IMAGE_MEDIA_TYPE,
    TEST_IMAGE_BASE64,
    TEST_IMAGE_DATA_URL,
};
