import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import testHelpers from "../../testHelpers";

/**
 * User Endpoint Negative Tests
 */

describe("User API (Negative)", () => {
    beforeAll(async () => {
        await testHelpers.truncate();
    });
    describe("POST /user/create.json", () => {
        it("should return error when name is missing", async () => {
            const userData = { token: "some-token" };
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when both name and token are missing", async () => {
            const userData = {};
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });
    });

    describe("GET /user/:id", () => {
        it("should return error for non-existent user ID", async () => {
            const response = await requestHelper.get("/user/99999");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid ID format (string)", async () => {
            const response = await requestHelper.get("/user/invalid-id");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for negative ID", async () => {
            const response = await requestHelper.get("/user/-1");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for zero ID", async () => {
            const response = await requestHelper.get("/user/0");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });
});
