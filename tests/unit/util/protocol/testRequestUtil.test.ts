import { describe, expect, it } from "vitest";
import {
    buildModelRouteTestBody,
    buildVendorTestBody,
    normalizeContentMode,
    TEST_IMAGE_BASE64,
    TEST_IMAGE_DATA_URL,
    TEST_IMAGE_MEDIA_TYPE,
    TEST_IMAGE_PROMPT,
} from "../../../../src/util/protocol/testRequestUtil";
import { ApiFormat } from "../../../../src/constants";


/**
 * 两个测试入口的请求体构造：文本模式逐字段回归 + 三协议图片模式。
 *
 * 文本模式的期望值是**改动前**的旧实现字面量（vendorTestService.buildRequest /
 * modelController.buildTestRequestBody），故意写死在这里而不是引用实现常量 ——
 * 用实现算期望值等于让实现自证，回归用例就失效了。
 */


function parse(json: string): any {
    return JSON.parse(json);
}


describe("testRequestUtil: 文本模式与旧实现逐字段一致（回归）", () => {
    it("供应商测试 OpenAI：max_tokens 5、content=ping、无 stream 字段", () => {
        expect(parse(buildVendorTestBody(ApiFormat.OPENAI, "gpt-4", "text"))).toEqual({
            model: "gpt-4",
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 5,
        });
    });

    it("供应商测试 Anthropic：max_tokens 1（图片模式才会放宽）", () => {
        expect(parse(buildVendorTestBody(ApiFormat.ANTHROPIC, "claude-3", "text"))).toEqual({
            model: "claude-3",
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
        });
    });

    it("供应商测试 Responses：input=ping、max_output_tokens 16", () => {
        expect(parse(buildVendorTestBody(ApiFormat.RESPONSES, "gpt-5", "text"))).toEqual({
            model: "gpt-5",
            input: "ping",
            max_output_tokens: 16,
        });
    });

    it("模型路由测试 OpenAI：max_tokens 256 + stream=false", () => {
        expect(parse(buildModelRouteTestBody(ApiFormat.OPENAI, "gpt-4o", "text"))).toEqual({
            model: "gpt-4o",
            messages: [{ role: "user", content: "你好" }],
            max_tokens: 256,
            stream: false,
        });
    });

    it("模型路由测试 Anthropic：max_tokens 256", () => {
        expect(parse(buildModelRouteTestBody(ApiFormat.ANTHROPIC, "claude-3", "text"))).toEqual({
            model: "claude-3",
            messages: [{ role: "user", content: "你好" }],
            max_tokens: 256,
        });
    });

    it("模型路由测试 Responses：input=你好、max_output_tokens 256", () => {
        expect(parse(buildModelRouteTestBody(ApiFormat.RESPONSES, "gpt-5", "text"))).toEqual({
            model: "gpt-5",
            input: "你好",
            max_output_tokens: 256,
        });
    });

    it("缺省 mode 参数等价于 text", () => {
        expect(buildVendorTestBody(ApiFormat.OPENAI, "m")).toBe(buildVendorTestBody(ApiFormat.OPENAI, "m", "text"));
        expect(buildModelRouteTestBody(ApiFormat.OPENAI, "m")).toBe(buildModelRouteTestBody(ApiFormat.OPENAI, "m", "text"));
    });
});


describe("testRequestUtil: 图片模式（内置样图）", () => {
    it("供应商测试 OpenAI：content 数组 = [text, image_url]，max_tokens 放宽到 64", () => {
        const body = parse(buildVendorTestBody(ApiFormat.OPENAI, "gpt-4o", "image"));

        expect(body.model).toBe("gpt-4o");
        expect(body.max_tokens).toBe(64);
        expect(body).not.toHaveProperty("stream");
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe("user");
        expect(body.messages[0].content).toEqual([
            { type: "text", text: TEST_IMAGE_PROMPT },
            { type: "image_url", image_url: { url: TEST_IMAGE_DATA_URL } },
        ]);
    });

    it("供应商测试 Anthropic：图片在前、文本在后，source 是 base64 + image/png", () => {
        const body = parse(buildVendorTestBody(ApiFormat.ANTHROPIC, "claude-3", "image"));

        expect(body.max_tokens).toBe(64);
        expect(body.messages[0].content).toEqual([
            {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: TEST_IMAGE_BASE64 },
            },
            { type: "text", text: TEST_IMAGE_PROMPT },
        ]);
    });

    it("供应商测试 Responses：input 是数组，input_image.image_url 是字符串（不是 { url } 对象）", () => {
        const body = parse(buildVendorTestBody(ApiFormat.RESPONSES, "gpt-5", "image"));

        expect(body.max_output_tokens).toBe(64);
        expect(Array.isArray(body.input)).toBe(true);
        expect(body.input[0].role).toBe("user");
        expect(body.input[0].content).toEqual([
            { type: "input_text", text: TEST_IMAGE_PROMPT },
            { type: "input_image", image_url: TEST_IMAGE_DATA_URL },
        ]);
        // 这条是设计稿点名的易错点：Responses 的 image_url 是字符串
        expect(typeof body.input[0].content[1].image_url).toBe("string");
    });

    it("模型路由测试图片模式：token 256，OpenAI 保留 stream=false", () => {
        const openai = parse(buildModelRouteTestBody(ApiFormat.OPENAI, "gpt-4o", "image"));
        expect(openai.max_tokens).toBe(256);
        expect(openai.stream).toBe(false);
        expect(openai.messages[0].content[1].type).toBe("image_url");

        const anthropic = parse(buildModelRouteTestBody(ApiFormat.ANTHROPIC, "claude-3", "image"));
        expect(anthropic.max_tokens).toBe(256);
        expect(anthropic.messages[0].content[0].type).toBe("image");

        const responses = parse(buildModelRouteTestBody(ApiFormat.RESPONSES, "gpt-5", "image"));
        expect(responses.max_output_tokens).toBe(256);
        expect(responses.input[0].content[1].type).toBe("input_image");
    });

    it("模型路由测试的提示词与供应商测试不同（你好 vs 请描述这张图片）", () => {
        expect(parse(buildModelRouteTestBody(ApiFormat.OPENAI, "m", "image")).messages[0].content[0].text)
            .toBe("请描述这张图片");
        expect(TEST_IMAGE_PROMPT).toBe("请描述这张图片");
    });
});


describe("testRequestUtil: 内置样图本身", () => {
    it("base64 解出来是合法 PNG（magic bytes + IHDR 64×64），且体积 < 4KB", () => {
        const buffer = Buffer.from(TEST_IMAGE_BASE64, "base64");

        // PNG signature
        expect([...buffer.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        // IHDR：宽高在偏移 16..24（大端 4 字节各一）
        expect(buffer.readUInt32BE(16)).toBe(64);
        expect(buffer.readUInt32BE(20)).toBe(64);
        expect(buffer.length).toBeLessThan(4 * 1024);
    });

    it("data URL 前缀是 image/png;base64", () => {
        expect(TEST_IMAGE_MEDIA_TYPE).toBe("image/png");
        expect(TEST_IMAGE_DATA_URL.startsWith("data:image/png;base64,")).toBe(true);
        expect(TEST_IMAGE_DATA_URL.endsWith(TEST_IMAGE_BASE64)).toBe(true);
    });
});


describe("testRequestUtil: content_mode 校验", () => {
    it("缺省 / null / 空串 ⇒ text（旧调用方不传时必须走文本模式）", () => {
        expect(normalizeContentMode(undefined)).toBe("text");
        expect(normalizeContentMode(null)).toBe("text");
        expect(normalizeContentMode("")).toBe("text");
    });

    it("合法值原样返回", () => {
        expect(normalizeContentMode("text")).toBe("text");
        expect(normalizeContentMode("image")).toBe("image");
    });

    it("非法值抛 400，且不静默降级成 text", () => {
        for (const bad of ["IMAGE", "img", "text ", 1, {}, []]) {
            let caught: any = null;
            try {
                normalizeContentMode(bad);
            } catch (e) {
                caught = e;
            }
            expect(caught, `应当抛错: ${JSON.stringify(bad)}`).not.toBeNull();
            expect(caught.statusCode).toBe(400);
            expect(String(caught.message)).toContain("content_mode");
        }
    });
});
