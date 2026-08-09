import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import userFixtures from "../../fixtures/userFixtures";

/**
 * Concurrent Request Tests
 *
 * 模拟前端首页加载场景：浏览器同时发起多个 API 请求。
 * 主要验证并发请求不会导致后端报错（如数据库连接竞态条件）。
 */

const ADMIN_TOKEN = userFixtures.ADMIN_TOKEN;

describe("Concurrent Requests", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        // 创建 admin 用户（带重试，worker 模式下可能遇到 ECONNRESET）
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await requestHelper.post(
                    "/user/create.json",
                    userFixtures.USER_FIXTURES.admin,
                    "root-token-123",
                );
                break;
            } catch (e) {
                if (attempt === 3) throw e;
                await new Promise(r => setTimeout(r, 500));
            }
        }
    });


    it("should handle concurrent requests to multiple endpoints", { timeout: 15000 }, async () => {
        // 模拟前端首页同时请求多个接口
        const requests = [
            requestHelper.get("/status.json", ADMIN_TOKEN),
            requestHelper.get("/vendor/list.json", ADMIN_TOKEN),
            requestHelper.get("/model/list.json", ADMIN_TOKEN),
            requestHelper.get("/record/latest.json", ADMIN_TOKEN),
            requestHelper.get("/user/list.json", ADMIN_TOKEN),
        ];

        const responses = await Promise.all(requests);

        // 所有请求都应成功（200）
        for (let i = 0; i < responses.length; i++) {
            expect(responses[i].status, `Request ${i} failed with status ${responses[i].status}, body: ${JSON.stringify(responses[i].body)}`).toBe(200);
        }
    });


    it("should handle repeated concurrent bursts", { timeout: 15000 }, async () => {
        // 连续发起多轮并发请求，确保稳定性
        const rounds = 3;

        for (let round = 0; round < rounds; round++) {
            const requests = [
                requestHelper.get("/status.json", ADMIN_TOKEN),
                requestHelper.get("/vendor/list.json", ADMIN_TOKEN),
                requestHelper.get("/model/list.json", ADMIN_TOKEN),
                requestHelper.get("/record/latest.json", ADMIN_TOKEN),
            ];

            const responses = await Promise.all(requests);

            for (let i = 0; i < responses.length; i++) {
                expect(responses[i].status, `Round ${round + 1}, Request ${i} failed with status ${responses[i].status}, body: ${JSON.stringify(responses[i].body)}`).toBe(200);
            }
        }
    });


    it("should handle concurrent requests to the same endpoint", { timeout: 15000 }, async () => {
        // 同一个接口的并发请求
        const requests = Array.from({ length: 5 }, () =>
            requestHelper.get("/status.json", ADMIN_TOKEN),
        );

        const responses = await Promise.all(requests);

        for (let i = 0; i < responses.length; i++) {
            expect(responses[i].status, `Request ${i} failed with status ${responses[i].status}`).toBe(200);
            expect(responses[i].body).toHaveProperty("status", "ok");
        }
    });
});
