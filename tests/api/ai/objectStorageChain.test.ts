import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * End-to-end linkage test: a real gateway request must persist the combined
 * {request, response} payload into object storage (storage_record table in node
 * mode), and the record API must read it back from there.
 *
 * The record table no longer has request_data/response_data columns, so the only
 * way the API can return the payload is via objectStorageService. This test also
 * inspects storage_record directly to make that linkage explicit.
 */

/**
 * 两种模式都要跑：node 用本地对象存储（写 storage_record 表），worker 用真实 R2 binding
 * （`wrangler.test.toml` 里的 `gt-ai-gateway-test-objects`）。两条链路都能覆盖「请求体+响应体
 * 落对象存储 → record 详情 API 读回来」这个端到端约定，只是 worker 侧没有 storage_record 表，
 * 不能直接查表，只做 API 回读 + 二次回读一致性断言。
 */
describe("record object storage chain", () => {
    let adminToken: string;
    let testUserToken: string;
    let openaiModelName: string;

    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserToken = userResponse.body.token;

        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );

        openaiModelName = config.getCurrentUpstreamConfig().openai.model;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(Number(vendor.body.id), openaiModelName),
            adminToken,
        );
    });

    async function getStoredObject(recordId: number): Promise<{ request: string | null; response: string | null } | null> {
        const rows = await dbHelper.query<{ object_key: string; data: Buffer }>(
            "SELECT object_key, data FROM storage_record WHERE object_key = ?",
            [`record/${recordId}`],
        );
        if (rows.length === 0) {
            return null;
        }
        return JSON.parse(rows[0].data.toString());
    }

    it("persists the combined payload to object storage and reads it back via the API", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: openaiModelName,
            stream: false,
        });

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            chatRequest,
            testUserToken,
        );
        expect(response.status).toBe(200);

        // locate the record just created
        const recordsResponse = await requestHelper.get(
            "/record/latest.json?limit=1",
            adminToken,
        );
        expect(recordsResponse.body.length).toBeGreaterThan(0);
        const record = recordsResponse.body[0];
        expect(record.status).toBe("success");

        // 1) node：直接查 storage_record 确认对象真的落盘（键为 "record/{id}"）
        //    worker：对象在 R2 里，测试进程没有 binding，改由下面的详情 API 回读来证明链路通
        let storedRequestText: string | null = null;
        let storedResponseText: string | null = null;

        if (config.TEST_MODE !== "worker") {
            const stored = await getStoredObject(record.id);
            expect(stored).not.toBeNull();
            expect(stored!.request).not.toBeNull();
            expect(stored!.response).not.toBeNull();
            storedRequestText = stored!.request;
            storedResponseText = stored!.response;

            // the stored request matches what was sent
            const storedRequest = JSON.parse(stored!.request!);
            expect(storedRequest.model).toBe(openaiModelName);
            expect(storedRequest.messages).toEqual(chatRequest.messages);

            // the stored response is the upstream body the gateway received
            const storedResponse = JSON.parse(stored!.response!);
            expect(storedResponse.object).toBe("chat.completion");
            expect(storedResponse.choices[0].message.content).toBe(
                response.body.choices[0].message.content,
            );
        }

        // 2) the record detail API reads the payload back from object storage
        const detailResponse = await requestHelper.get(
            `/record/${record.id}`,
            adminToken,
        );
        expect(detailResponse.status).toBe(200);

        if (storedRequestText !== null) {
            expect(detailResponse.body.request_data).toBe(storedRequestText);
            expect(detailResponse.body.response_data).toBe(storedResponseText);
        } else {
            // worker（R2 链路）：详情 API 能读回完整请求体/响应体，就说明 R2 读写都不为空
            expect(typeof detailResponse.body.request_data).toBe("string");
            expect(typeof detailResponse.body.response_data).toBe("string");

            const apiRequest = JSON.parse(detailResponse.body.request_data);
            expect(apiRequest.model).toBe(openaiModelName);
            expect(apiRequest.messages).toEqual(chatRequest.messages);

            const apiResponse = JSON.parse(detailResponse.body.response_data);
            expect(apiResponse.object).toBe("chat.completion");
            expect(apiResponse.choices[0].message.content).toBe(
                response.body.choices[0].message.content,
            );

            // 二次回读必须逐字节一致：证明是从对象存储取回来的，而不是进程内残留
            const again = await requestHelper.get(`/record/${record.id}`, adminToken);
            expect(again.status).toBe(200);
            expect(again.body.request_data).toBe(detailResponse.body.request_data);
            expect(again.body.response_data).toBe(detailResponse.body.response_data);
        }
    }, 60000);
});
