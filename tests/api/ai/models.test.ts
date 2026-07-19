import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import modelFixtures from "../../fixtures/modelFixtures";

const adminToken = "admin-token-123";
const normalToken = "models-user-token";

describe("GET /llm/v1/models", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();

        await requestHelper.post(
            "/user/create.json",
            { name: "Models User", token: normalToken, type: "normal" },
            adminToken,
        );

        const openaiVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "openai",
                token: "openai-token",
                urls: { openai: "https://api.openai.com/v1/chat/completions" },
            },
            adminToken,
        );
        const anthropicVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "anthropic",
                token: "anthropic-token",
                urls: { anthropic: "https://api.anthropic.com/v1/messages" },
            },
            adminToken,
        );

        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openaiVendor.body.id, "gpt-4o"),
            adminToken,
        );
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(anthropicVendor.body.id, "claude-sonnet-4-5"),
            adminToken,
        );
        await requestHelper.post(
            "/model/create.json",
            {
                ...modelFixtures.createRandomModel(openaiVendor.body.id, "disabled-model"),
                enable: false,
            },
            adminToken,
        );
    });

    it("returns enabled models in OpenAI format with Bearer authentication", async () => {
        const response = await requestHelper.get("/llm/v1/models", normalToken);

        expect(response.status).toBe(200);
        expect(response.body.object).toBe("list");
        expect(response.body.data).toHaveLength(2);
        expect(response.body.data).toEqual([
            {
                id: "gpt-4o",
                object: "model",
                created: expect.any(Number),
                owned_by: "openai",
            },
            {
                id: "claude-sonnet-4-5",
                object: "model",
                created: expect.any(Number),
                owned_by: "anthropic",
            },
        ]);
        expect(response.body.data.every((model: { created: number }) => (
            Number.isInteger(model.created) && model.created > 0
        ))).toBe(true);
    });

    it("accepts x-api-key authentication", async () => {
        const response = await requestHelper.request("/llm/v1/models", {
            method: "GET",
            headers: { "x-api-key": normalToken },
        });

        expect(response.status).toBe(200);
        expect(response.body.data.map((model: { id: string }) => model.id)).not.toContain("disabled-model");
    });

    it("allows x-api-key in browser CORS preflight requests", async () => {
        const response = await requestHelper.request("/llm/v1/models", {
            method: "OPTIONS",
            headers: {
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-api-key",
            },
        });

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-headers")).toContain("x-api-key");
    });
});
