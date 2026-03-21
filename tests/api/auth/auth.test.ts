import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";
import userFixtures from "../../fixtures/userFixtures";

/**
 * Authentication and Authorization Tests
 * Tests for admin-only API endpoints
 */

let adminToken = "admin-token-123";
let normalToken = "normal-token-123";
let invalidToken = "invalid-token-123";
let vendorId: number;
let anthropicVendorId: number;
let modelId: number;
let anthropicModelId: number;

describe("Auth API Tests", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();

        // Create normal user via API (admin user already created in globalSetup)
        await requestHelper.post(
            "/user/create.json",
            {
                name: "Normal User",
                token: normalToken,
                type: "normal",
            },
            adminToken,
        );

        // Create OpenAI vendor for testing (using mock server URL)
        const vendorResponse = await requestHelper.post(
            "/vendor/create.json",
            {
                name: "Test Vendor",
                type: "other",
                url: "http://localhost:9999/chat/completions",
                token: "test-vendor-token",
                api_format: "openai",
            },
            adminToken,
        );
        vendorId = vendorResponse.body.id;

        // Create OpenAI model for testing
        const modelResponse = await requestHelper.post(
            "/model/create.json",
            {
                name: "gpt-4",
                vendor_id: vendorId,
            },
            adminToken,
        );
        modelId = modelResponse.body.id;

        // Create Anthropic vendor for testing (using mock server URL)
        const anthropicVendorResponse = await requestHelper.post(
            "/vendor/create.json",
            {
                name: "Test Anthropic Vendor",
                type: "other",
                url: "http://localhost:9999/messages",
                token: "test-anthropic-token",
                api_format: "anthropic",
            },
            adminToken,
        );
        anthropicVendorId = anthropicVendorResponse.body.id;

        // Create Anthropic model for testing
        const anthropicModelResponse = await requestHelper.post(
            "/model/create.json",
            {
                name: "claude-3-opus-20240229",
                vendor_id: anthropicVendorId,
            },
            adminToken,
        );
        anthropicModelId = anthropicModelResponse.body.id;
    });

    describe("Vendor API Authorization", () => {
        describe("GET /vendor/list.json", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get("/vendor/list.json");

                expect(response.status).toBe(401);
                expect(response.body.error).toBe(
                    "Authorization header is missing or invalid",
                );
            });

            it("should return 401 with invalid token", async () => {
                const response = await requestHelper.get(
                    "/vendor/list.json",
                    invalidToken,
                );

                expect(response.status).toBe(401);
                expect(response.body.error).toBe("Invalid token");
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get(
                    "/vendor/list.json",
                    normalToken,
                );

                expect(response.status).toBe(403);
                expect(response.body.error).toBe("Admin access required");
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.get(
                    "/vendor/list.json",
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(Array.isArray(response.body.list)).toBe(true);
            });
        });

        describe("GET /vendor/:id", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get(`/vendor/${vendorId}`);

                expect(response.status).toBe(401);
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get(
                    `/vendor/${vendorId}`,
                    normalToken,
                );

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.get(
                    `/vendor/${vendorId}`,
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(response.body.id).toBe(vendorId);
            });
        });

        describe("POST /vendor/create.json", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.post(
                    "/vendor/create.json",
                    {
                        name: "New Vendor",
                        type: "other",
                        url: "http://localhost:9999/chat/completions",
                        token: "test-vendor-token",
                        api_format: "openai",
                    },
                );

                expect(response.status).toBe(401);
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.post(
                    "/vendor/create.json",
                    {
                        name: "New Vendor",
                        type: "other",
                        url: "http://localhost:9999/chat/completions",
                        token: "test-vendor-token",
                        api_format: "openai",
                    },
                    normalToken,
                );

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.post(
                    "/vendor/create.json",
                    {
                        name: "New Vendor",
                        type: "other",
                        url: "http://localhost:9999/chat/completions",
                        token: "test-vendor-token",
                        api_format: "openai",
                    },
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
            });
        });

        describe("PUT /vendor/:id", () => {
            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.put(
                    `/vendor/${vendorId}`,
                    {
                        name: "Updated Vendor",
                    },
                    normalToken,
                );

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.put(
                    `/vendor/${vendorId}`,
                    {
                        name: "Updated Vendor",
                    },
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(response.body.name).toBe("Updated Vendor");
            });
        });
    });

    describe("Model API Authorization", () => {
        describe("GET /model/list.json", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get("/model/list.json");

                expect(response.status).toBe(401);
                expect(response.body.error).toBe(
                    "Authorization header is missing or invalid",
                );
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get(
                    "/model/list.json",
                    normalToken,
                );

                expect(response.status).toBe(403);
                expect(response.body.error).toBe("Admin access required");
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.get(
                    "/model/list.json",
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(Array.isArray(response.body.list)).toBe(true);
            });
        });

        describe("GET /model/:id", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get(`/model/${modelId}`);

                expect(response.status).toBe(401);
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get(
                    `/model/${modelId}`,
                    normalToken,
                );

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.get(
                    `/model/${modelId}`,
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(response.body.id).toBe(modelId);
            });
        });

        describe("POST /model/create.json", () => {
            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.post(
                    "/model/create.json",
                    {
                        name: "New Model",
                        vendor_id: vendorId,
                        model_name: "gpt-3.5-turbo",
                    },
                    normalToken,
                );

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.post(
                    "/model/create.json",
                    {
                        name: "New Model",
                        vendor_id: vendorId,
                        model_name: "gpt-3.5-turbo",
                    },
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
            });
        });
    });

    describe("User API Authorization", () => {
        describe("GET /user/list.json", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get("/user/list.json");

                expect(response.status).toBe(401);
                expect(response.body.error).toBe(
                    "Authorization header is missing or invalid",
                );
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get(
                    "/user/list.json",
                    normalToken,
                );

                expect(response.status).toBe(403);
                expect(response.body.error).toBe("Admin access required");
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.get(
                    "/user/list.json",
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(Array.isArray(response.body.list)).toBe(true);
            });
        });

        describe("GET /user/:id", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get("/user/1");

                expect(response.status).toBe(401);
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get("/user/1", normalToken);

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                // First get list to find a valid user ID
                const listResponse = await requestHelper.get("/user/list.json", adminToken);
                expect(listResponse.body.list.length).toBeGreaterThan(0);
                const userId = listResponse.body.list[0].id;

                const response = await requestHelper.get(`/user/${userId}`, adminToken);

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
            });
        });

        describe("POST /user/create.json", () => {
            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.post(
                    "/user/create.json",
                    {
                        name: "New User",
                    },
                    normalToken,
                );

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.post(
                    "/user/create.json",
                    {
                        name: "New User",
                    },
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
                expect(response.body.name).toBe("New User");
            });
        });
    });

    describe("Record API Authorization", () => {
        describe("GET /record/list.json", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get("/record/list.json");

                expect(response.status).toBe(401);
                expect(response.body.error).toBe(
                    "Authorization header is missing or invalid",
                );
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get(
                    "/record/list.json",
                    normalToken,
                );

                expect(response.status).toBe(403);
                expect(response.body.error).toBe("Admin access required");
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.get(
                    "/record/list.json",
                    adminToken,
                );

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("list");
                expect(response.body).toHaveProperty("total");
                expect(Array.isArray(response.body.list)).toBe(true);
            });
        });

        describe("GET /record/latest.json", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get("/record/latest.json");

                expect(response.status).toBe(401);
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get(
                    "/record/latest.json",
                    normalToken,
                );

                expect(response.status).toBe(403);
            });

            it("should return 200 with admin token", async () => {
                const response = await requestHelper.get(
                    "/record/latest.json",
                    adminToken,
                );

                expect(response.status).toBe(200);
            });
        });

        describe("GET /record/:id", () => {
            it("should return 401 without token", async () => {
                const response = await requestHelper.get("/record/1");

                expect(response.status).toBe(401);
            });

            it("should return 403 with normal user token", async () => {
                const response = await requestHelper.get("/record/1", normalToken);

                expect(response.status).toBe(403);
            });

            it("should return 404 with admin token when record not found", async () => {
                const response = await requestHelper.get(
                    "/record/999",
                    adminToken,
                );

                expect(response.status).toBe(404);
            });
        });
    });

    describe("LLM API - No Auth Required", () => {
        describe("POST /llm/v1/chat/completions", () => {
            it("should work with normal user token", async () => {
                const response = await requestHelper.post(
                    "/llm/v1/chat/completions",
                    {
                        model: "gpt-4",
                        messages: [
                            {
                                role: "user",
                                content: "Hello, this is a test",
                            },
                        ],
                    },
                    normalToken,
                );

                // The response depends on mock server, should at least not be 401/403
                expect(response.status).not.toBe(401);
                expect(response.status).not.toBe(403);
            });

            it("should work with admin token", async () => {
                const response = await requestHelper.post(
                    "/llm/v1/chat/completions",
                    {
                        model: "gpt-4",
                        messages: [
                            {
                                role: "user",
                                content: "Hello, this is a test",
                            },
                        ],
                    },
                    adminToken,
                );

                // The response depends on mock server, should at least not be 401/403
                expect(response.status).not.toBe(401);
                expect(response.status).not.toBe(403);
            });
        });

        describe("POST /llm/v1/messages", () => {
            it("should work with normal user token", async () => {
                const response = await requestHelper.post(
                    "/llm/v1/messages",
                    {
                        model: "claude-3-opus-20240229",
                        max_tokens: 100,
                        messages: [
                            {
                                role: "user",
                                content: "Hello, this is a test",
                            },
                        ],
                    },
                    normalToken,
                    {
                        "anthropic-version": "2023-06-01",
                    },
                );

                // The response depends on mock server, should at least not be 401/403
                expect(response.status).not.toBe(401);
                expect(response.status).not.toBe(403);
            });

            it("should work with admin token", async () => {
                const response = await requestHelper.post(
                    "/llm/v1/messages",
                    {
                        model: "claude-3-opus-20240229",
                        max_tokens: 100,
                        messages: [
                            {
                                role: "user",
                                content: "Hello, this is a test",
                            },
                        ],
                    },
                    adminToken,
                    {
                        "anthropic-version": "2023-06-01",
                    },
                );

                // The response depends on mock server, should at least not be 401/403
                expect(response.status).not.toBe(401);
                expect(response.status).not.toBe(403);
            });
        });
    });
});
