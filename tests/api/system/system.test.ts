import { beforeAll, describe, it, expect } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import { RunMode } from "../../../src/constants";
import packageJson from "../../../package.json";

/**
 * System Endpoint Tests
 */

describe("System API", () => {
    let adminToken: string;

    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
    });

    describe("GET /welcome", () => {
        it("should return welcome message with status 200", async () => {
            const response = await requestHelper.get("/welcome");

            expect(response.status).toBe(200);
            expect(response.body).toContain("Hello");
            expect(response.body).toContain("serverless ai gateway");
        });

        it("should return a text response", async () => {
            const response = await requestHelper.get("/welcome");

            expect(typeof response.body).toBe("string");
            expect(response.headers.get("content-type")).toContain(
                "text/plain",
            );
        });

        it("should indicate node mode", async () => {
            const response = await requestHelper.get("/welcome");

            // In node mode: contains "node mode", in worker mode: contains "serverless ai gateway"
            const isNodeMode = response.body.includes("node mode");
            const isWorkerMode = response.body.includes("serverless ai gateway") && !response.body.includes("node mode");
            expect(isNodeMode || isWorkerMode).toBe(true);
        });
    });

    describe("GET /status.json", () => {
        it("should return R2 availability for the current runtime", async () => {
            const response = await requestHelper.get("/status.json", adminToken);

            expect(response.status).toBe(200);
            if (response.body.mode === RunMode.NODE) {
                expect(response.body.storage).toMatchObject({
                    r2_available: false,
                    r2_unavailable_reason: "当前非 Cloudflare 环境，R2 不可用",
                });
                return;
            }

            expect(response.body.storage).toMatchObject({
                r2_available: true,
                r2_unavailable_reason: "",
            });
        });
    });

    describe("GET /status.json version", () => {
        it("returns the code-defined version by default", async () => {
            const response = await requestHelper.get("/status.json", adminToken);

            expect(response.status).toBe(200);
            expect(response.body.system.version).toBe(packageJson.version);
        });
    });

    describe("GET /status.json memory & colo", () => {
        it("reports node process memory and worker edge colo as two separate fields", async () => {
            const response = await requestHelper.get("/status.json", adminToken);

            expect(response.status).toBe(200);
            if (response.body.mode === RunMode.NODE) {
                // "128.5 MB" 形式的标量；colo 为 null
                expect(response.body.system.memory).toMatch(/^\d+(\.\d+)? MB$/);
                expect(response.body.system.colo).toBeNull();
            } else {
                // 测试环境无 cf：两个字段均为 null（真实 worker 下 colo 返回本次请求的边缘数据中心）
                expect(response.body.system.memory).toBeNull();
                expect(response.body.system.colo).toBeNull();
            }
        });
    });
});
