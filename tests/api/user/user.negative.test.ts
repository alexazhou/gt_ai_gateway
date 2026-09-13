import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";

/**
 * User Endpoint Negative Tests
 */

describe("User API (Negative)", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
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

    describe("PUT /user/:id", () => {
        let adminToken: string;
        let existingUserId: number;

        beforeAll(async () => {
            const { setupAdminUser } = await import("../../globalSetup");
            adminToken = await setupAdminUser();

            const userData = { name: "Test User", token: "test-token-123" };
            const response = await requestHelper.post(
                "/user/create.json",
                userData,
                adminToken,
            );
            existingUserId = response.body.id;
        });

        it("should return error for non-existent user ID", async () => {
            const updateData = { name: "New Name" };
            const response = await requestHelper.put(
                "/user/99999",
                updateData,
                adminToken,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid ID format (string)", async () => {
            const updateData = { name: "New Name" };
            const response = await requestHelper.put(
                "/user/invalid-id",
                updateData,
                adminToken,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for negative ID", async () => {
            const updateData = { name: "New Name" };
            const response = await requestHelper.put(
                "/user/-1",
                updateData,
                adminToken,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for zero ID", async () => {
            const updateData = { name: "New Name" };
            const response = await requestHelper.put(
                "/user/0",
                updateData,
                adminToken,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should require admin authentication", async () => {
            const updateData = { name: "New Name" };
            const response = await requestHelper.put(
                `/user/${existingUserId}`,
                updateData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });
    });

    /**
     * 用户类型（type）权限边界：
     * - root 为系统保留类型（只由 ROOT_TOKEN 提供），接口不允许创建/改成 root
     * - 管理员不能修改自己的类型，避免租户内唯一管理员自我降级后再也进不了后台
     * 用例自建管理员，不使用 setupAdminUser()（其 token 唯一，重复创建会冲突）
     */
    describe("User type guard", () => {
        const ROOT_TOKEN = "root-token-123";
        let adminToken: string;
        let selfAdminId: number;
        let targetUserId: number;

        beforeAll(async () => {
            const adminResponse = await requestHelper.post(
                "/user/create.json",
                { name: "Type Guard Admin", token: "type-guard-admin-token", type: "admin" },
                ROOT_TOKEN,
            );
            expect(adminResponse.status).toBe(200);
            adminToken = adminResponse.body.token;
            selfAdminId = adminResponse.body.id;

            const targetResponse = await requestHelper.post(
                "/user/create.json",
                { name: "Type Guard Target", token: "type-guard-target-token" },
                adminToken,
            );
            expect(targetResponse.status).toBe(200);
            targetUserId = targetResponse.body.id;
        });

        it("should reject creating a user with root type", async () => {
            const response = await requestHelper.post(
                "/user/create.json",
                { name: "Illegal Root User", token: "illegal-root-token", type: "root" },
                adminToken,
            );

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should reject creating a user with unknown type", async () => {
            const response = await requestHelper.post(
                "/user/create.json",
                { name: "Illegal Type User", token: "illegal-type-token", type: "superuser" },
                adminToken,
            );

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should reject changing a user type to root", async () => {
            const response = await requestHelper.put(
                `/user/${targetUserId}`,
                { type: "root" },
                adminToken,
            );

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should reject changing own user type", async () => {
            const response = await requestHelper.put(
                `/user/${selfAdminId}`,
                { type: "normal" },
                adminToken,
            );

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should still allow updating own user when type is unchanged", async () => {
            const response = await requestHelper.put(
                `/user/${selfAdminId}`,
                { name: "Type Guard Admin Renamed", type: "admin" },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Type Guard Admin Renamed");
            expect(response.body.type).toBe("admin");
        });
    });
});
