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

describe.skipIf(config.TEST_MODE === "worker")("record object storage chain", () => {
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

    it("persists the combined payload to storage_record and reads it back via the API", async () => {
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

        // 1) the combined object exists in storage_record under key "record/{id}"
        const stored = await getStoredObject(record.id);
        expect(stored).not.toBeNull();
        expect(stored!.request).not.toBeNull();
        expect(stored!.response).not.toBeNull();

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

        // 2) the record detail API reads the payload back from object storage
        const detailResponse = await requestHelper.get(
            `/record/${record.id}`,
            adminToken,
        );
        expect(detailResponse.status).toBe(200);
        expect(detailResponse.body.request_data).toBe(stored!.request);
        expect(detailResponse.body.response_data).toBe(stored!.response);
    }, 30000);
});
