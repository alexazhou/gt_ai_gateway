import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import testHelpers from "../../testHelpers";

/**
 * Record Endpoint Tests
 */

let testUserId: number;
let testUserToken: string;
let testVendorId: number;
let testModelId: number;
let adminToken: string;

describe("Record API", () => {
    beforeAll(async () => {
        await testHelpers.truncate();

        adminToken = await testHelpers.setupAdminUser();

        // Create test user
        const user = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserId = user.body.id;
        testUserToken = user.body.token;

        // Create test vendor
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        testVendorId = vendor.body.id;

        // Create test model
        const model = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(testVendorId),
            adminToken,
        );
        testModelId = model.body.id;
    });

    describe("GET /record/list.json", () => {
        it("should return a list of records", async () => {
            const response = await requestHelper.get("/record/list.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
        });

        it("should return records with correct structure", async () => {
            const response = await requestHelper.get("/record/list.json", adminToken);

            for (const record of response.body) {
                expect(record).toHaveProperty("id");
                expect(record).toHaveProperty("user_id");
                expect(record).toHaveProperty("model_id");
                expect(record).toHaveProperty("request_data");
                expect(record).toHaveProperty("response_data");
                expect(record).toHaveProperty("status");
                expect(record).toHaveProperty("created_at");
                expect(record).toHaveProperty("updated_at");
            }
        });
    });

    describe("GET /record/latest.json", () => {
        it("should return latest records with default limit", async () => {
            const response = await requestHelper.get("/record/latest.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
        });

        it("should return latest records with specified limit", async () => {
            const response = await requestHelper.get(
                "/record/latest.json?limit=5",
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBeLessThanOrEqual(5);
        });

        it("should return records sorted by created_at descending", async () => {
            const response = await requestHelper.get(
                "/record/latest.json?limit=10",
                adminToken,
            );

            if (response.body.length > 1) {
                const timestamps = response.body.map((r: any) =>
                    new Date(r.created_at).getTime(),
                );

                for (let i = 1; i < timestamps.length; i++) {
                    expect(timestamps[i - 1]).toBeGreaterThanOrEqual(
                        timestamps[i],
                    );
                }
            }
        });
    });

    describe("GET /record/:id", () => {
        it("should return error for non-existent record ID initially", async () => {
            const response = await requestHelper.get("/record/99999");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid ID format", async () => {
            const response = await requestHelper.get("/record/invalid-id");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });
});
