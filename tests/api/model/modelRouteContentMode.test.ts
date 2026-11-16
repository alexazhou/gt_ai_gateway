import { beforeAll, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import upstreamCaptureHelper from "../../helpers/upstreamCaptureHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import userFixtures from "../../fixtures/userFixtures";
import { TEST_IMAGE_BASE64, TEST_IMAGE_DATA_URL, TEST_IMAGE_PROMPT } from "../../../src/util/protocol/testRequestUtil";


const adminToken = userFixtures.ADMIN_TOKEN;

let seq = 0;
function unique(prefix: string): string {
    seq += 1;
    return `${prefix}-${Date.now()}-${seq}`;
}


/**
 * 模型可用性测试（POST /model/route-test.json）的 content_mode 支持。
 *
 * 与供应商直连测试的差别：这条走真实网关路由 + 协议转换（senderService.sendRequest），
 * 所以除了「接口回显的 request_body」，还要断言 **上游真的收到图片**，以及跨协议场景下图不被丢。
 */
describe("Model route-test with content_mode", () => {
    let openaiVendorId: number;
    let openaiModelName: string;

    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();

        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        expect(vendor.status).toBe(200);
        openaiVendorId = vendor.body.id;

        openaiModelName = unique("route-content-mode");
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: openaiModelName,
                routing_mode: "single",
                routing_config: {
                    upstreams: [{ vendor_id: openaiVendorId, enabled: true }],
                    failover: { enabled: false },
                },
            },
            adminToken,
        );
        expect(model.status).toBe(200);
    });

    it("text 模式回归：不传 content_mode 时请求体与旧实现一致（你好 / 256 / stream:false）", async () => {
        const response = await requestHelper.post(
            "/model/route-test.json",
            { model: openaiModelName, format: "openai" },
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.content_mode).toBe("text");
        expect(response.body.request_body.messages[0].content).toBe("你好");
        expect(response.body.request_body.max_tokens).toBe(256);
        expect(response.body.request_body.stream).toBe(false);
    });

    it("image 模式（同协议 OpenAI）：上游收到图片，接口回显 content_mode=image", async () => {
        const response = await requestHelper.post(
            "/model/route-test.json",
            { model: openaiModelName, format: "openai", content_mode: "image" },
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.content_mode).toBe("image");

        const body = response.body.request_body;
        expect(body.max_tokens).toBe(256);
        expect(body.messages[0].content[0]).toEqual({ type: "text", text: TEST_IMAGE_PROMPT });
        expect(body.messages[0].content[1].image_url.url).toBe(TEST_IMAGE_DATA_URL);

        const captured = await upstreamCaptureHelper.list();
        const last = captured[captured.length - 1];
        expect(last.json.messages[0].content[1].image_url.url).toBe(TEST_IMAGE_DATA_URL);
    });

    it("image 模式（客户端 anthropic → 上游 openai）：跨协议转换后图片仍在", async () => {
        // 客户端按 Anthropic 协议构造（图片在前、base64 source），上游是 OpenAI；
        // 这正是设计稿里「六向图片转换已补齐，路由测试不需要丢图警告」要覆盖的场景。
        const response = await requestHelper.post(
            "/model/route-test.json",
            { model: openaiModelName, format: "anthropic", content_mode: "image" },
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.content_mode).toBe("image");

        // 上游快照是转换后的 OpenAI 形态
        const upstreamBody = response.body.request_body;
        const parts = upstreamBody.messages[0].content;
        expect(Array.isArray(parts)).toBe(true);
        const imagePart = parts.find((p: any) => p.type === "image_url");
        expect(imagePart, "跨协议转换后上游请求里必须有图片").toBeTruthy();
        // OpenAI 侧是 data URL（Anthropic 的 base64 source 被转成 data URL）
        const url: string = imagePart.image_url.url;
        expect(url).toBe(TEST_IMAGE_DATA_URL);
        expect(url.endsWith(TEST_IMAGE_BASE64)).toBe(true);
    });

    it("非法 content_mode 返回 400（不静默降级成 text）", async () => {
        for (const bad of ["IMAGE", "img", "base64", 1]) {
            const response = await requestHelper.post(
                "/model/route-test.json",
                { model: openaiModelName, format: "openai", content_mode: bad },
                adminToken,
            );
            expect(response.status, `content_mode=${String(bad)} 应返回 400`).toBe(400);
        }
    });
});
