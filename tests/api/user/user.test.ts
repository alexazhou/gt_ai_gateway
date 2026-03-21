import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import userFixtures from "../../fixtures/userFixtures";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";

/**
 * User Endpoint Positive Tests
 */

let createdUserId: number;
let createdUserToken: string;
let adminToken: string;

describe("User API (Positive)", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
    });
    describe("POST /user/create.json", () => {
        it("should create a user with specified token", async () => {
            const userData = userFixtures.USER_FIXTURES.withCustomToken;
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("id");
            expect(response.body.name).toBe(userData.name);
            expect(response.body.token).toBe(userData.token);
            expect(response.body).toHaveProperty("created_at");
            expect(response.body).toHaveProperty("updated_at");

            createdUserId = response.body.id;
            createdUserToken = response.body.token;
        });

        it("should create a user with auto-generated token when token is not provided", async () => {
            const userData = { name: "Auto Token User" };
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("id");
            expect(response.body.name).toBe(userData.name);
            expect(response.body.token).toBeTruthy();
            expect(typeof response.body.token).toBe("string");
            expect(response.body.token.length).toBeGreaterThan(0);
        });

        it("should create multiple users with the same name", async () => {
            const userData1 = mockHelper.generateUser({
                name: "Same Name User",
            });
            const userData2 = mockHelper.generateUser({
                name: "Same Name User",
            });

            const response1 = await requestHelper.post(
                "/user/create.json",
                userData1,
                adminToken,
            );
            const response2 = await requestHelper.post(
                "/user/create.json",
                userData2,
                adminToken,
            );

            expect(response1.status).toBe(200);
            expect(response2.status).toBe(200);
            expect(response1.body.name).toBe(response2.body.name);
            expect(response1.body.id).not.toBe(response2.body.id);
        });

        it("should handle long names", async () => {
            const userData = userFixtures.USER_FIXTURES.longName;
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe(userData.name);
        });

        it("should handle empty token", async () => {
            const userData = userFixtures.USER_FIXTURES.emptyToken; // token: ''
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
                adminToken,
            );

            expect(response.status).toBe(200);
            // 空 token 会被自动生成（在 userController 中使用 crypto.randomUUID()）
            expect(response.body.token).toBeTruthy();
            expect(typeof response.body.token).toBe("string");
            expect(response.body.token.length).toBeGreaterThan(0);
            expect(response.body.token).not.toBe(""); // 不应该是空字符串
        });
    });

    describe("GET /user/list.json", () => {
        it("should return a list of users", async () => {
            const response = await requestHelper.get("/user/list.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body.list)).toBe(true);
            expect(response.body.total).toBeGreaterThan(0);
        });

        it("should return users with correct structure", async () => {
            const response = await requestHelper.get("/user/list.json", adminToken);
            const user = response.body.list[0];

            expect(user).toHaveProperty("id");
            expect(user).toHaveProperty("name");
            expect(user).toHaveProperty("token");
            expect(user).toHaveProperty("created_at");
            expect(user).toHaveProperty("updated_at");
        });

        it("should return all users created in tests", async () => {
            const response = await requestHelper.get("/user/list.json", adminToken);

            expect(response.body.total).toBeGreaterThanOrEqual(4); // At least the users we created
        });
    });

    describe("GET /user/:id", () => {
        it("should return a user by ID", async () => {
            const response = await requestHelper.get(`/user/${createdUserId}`, adminToken);

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(createdUserId);
            expect(response.body.token).toBe(createdUserToken);
            expect(response.body).toHaveProperty("name");
        });

        it("should return user with all fields", async () => {
            const response = await requestHelper.get(`/user/${createdUserId}`, adminToken);

            expect(response.body).toHaveProperty("id");
            expect(response.body).toHaveProperty("name");
            expect(response.body).toHaveProperty("token");
            expect(response.body).toHaveProperty("created_at");
            expect(response.body).toHaveProperty("updated_at");
        });
    });

    describe("PUT /user/:id", () => {
        let userToUpdateId: number;
        let originalToken: string;

        beforeAll(async () => {
            const userData = {
                name: "User To Update",
                token: "original-token-12345",
            };
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
                adminToken,
            );
            userToUpdateId = response.body.id;
            originalToken = response.body.token;
        });

        it("should update user name", async () => {
            const updateData = { name: "Updated User Name" };
            const response = await requestHelper.put(
                `/user/${userToUpdateId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(userToUpdateId);
            expect(response.body.name).toBe(updateData.name);
            expect(response.body.token).toBe(originalToken); // Token should remain unchanged
        });

        it("should update token with new value", async () => {
            const newToken = "new-token-67890";
            const updateData = { token: newToken };
            const response = await requestHelper.put(
                `/user/${userToUpdateId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(userToUpdateId);
            expect(response.body.token).toBe(newToken);
            expect(response.body.name).toBe("Updated User Name"); // Name should remain unchanged
        });

        it("should regenerate token when token is empty string", async () => {
            // First set a known token
            const oldToken = "token-before-regenerate";
            await requestHelper.put(
                `/user/${userToUpdateId}`,
                { token: oldToken },
                adminToken,
            );

            // Then regenerate with empty string
            const regenerateData = { token: "" };
            const response = await requestHelper.put(
                `/user/${userToUpdateId}`,
                regenerateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(userToUpdateId);
            expect(response.body.token).toBeTruthy();
            expect(response.body.token).not.toBe(oldToken); // Token should be new
            expect(response.body.token.length).toBeGreaterThan(0);
        });

        it("should regenerate token when token is null", async () => {
            const response = await requestHelper.get(`/user/${userToUpdateId}`, adminToken);
            const oldToken = response.body.token;

            const regenerateData = { token: null };
            const response2 = await requestHelper.put(
                `/user/${userToUpdateId}`,
                regenerateData,
                adminToken,
            );

            expect(response2.status).toBe(200);
            expect(response2.body.token).toBeTruthy();
            expect(response2.body.token).not.toBe(oldToken);
        });

        it("should not change anything when no fields provided", async () => {
            const response1 = await requestHelper.get(`/user/${userToUpdateId}`, adminToken);
            const originalName = response1.body.name;
            const originalToken = response1.body.token;

            const updateData = {};
            const response2 = await requestHelper.put(
                `/user/${userToUpdateId}`,
                updateData,
                adminToken,
            );

            expect(response2.status).toBe(200);
            expect(response2.body.name).toBe(originalName);
            expect(response2.body.token).toBe(originalToken);
        });

        it("should update both name and token simultaneously", async () => {
            const newToken = "simultaneous-update-token";
            const updateData = {
                name: "Simultaneously Updated User",
                token: newToken,
            };
            const response = await requestHelper.put(
                `/user/${userToUpdateId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(userToUpdateId);
            expect(response.body.name).toBe(updateData.name);
            expect(response.body.token).toBe(newToken);
        });

        it("should return user with all fields after update", async () => {
            const response = await requestHelper.get(`/user/${userToUpdateId}`, adminToken);

            expect(response.body).toHaveProperty("id");
            expect(response.body).toHaveProperty("name");
            expect(response.body).toHaveProperty("token");
            expect(response.body).toHaveProperty("created_at");
            expect(response.body).toHaveProperty("updated_at");
        });
    });
});
