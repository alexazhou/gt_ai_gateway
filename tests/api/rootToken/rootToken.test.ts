import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import userService from "../../../src/service/userService";
import { ROOT_USER_ID } from "../../../src/constants";

/**
 * Root Token Tests
 * Tests for the root token functionality
 */

const ROOT_TOKEN = "root-token-123";
const INVALID_ROOT_TOKEN = "invalid-root-token";
let adminToken = "admin-token-123";

describe("Root Token Tests", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();

        // Create admin user via API
        await requestHelper.post(
            "/user/create.json",
            {
                name: "Admin User",
                token: adminToken,
                type: "admin",
            },
        );
    });

    describe("userService.isRootToken", () => {
        it("should return true when token matches root token", () => {
            expect(userService.isRootToken(ROOT_TOKEN, ROOT_TOKEN)).toBe(true);
        });

        it("should return false when token does not match root token", () => {
            expect(userService.isRootToken("some-other-token", ROOT_TOKEN)).toBe(false);
        });

        it("should return false when root token is undefined", () => {
            expect(userService.isRootToken(ROOT_TOKEN, undefined)).toBe(false);
        });

        it("should return false when root token is empty string", () => {
            expect(userService.isRootToken(ROOT_TOKEN, "")).toBe(false);
        });

        it("should return false when root token is null", () => {
            expect(userService.isRootToken(ROOT_TOKEN, null as any)).toBe(false);
        });
    });

    describe("Admin API Access with Root Token", () => {
        describe("GET /user/list.json", () => {
            it("should allow access with valid root token", async () => {
                const response = await requestHelper.get("/user/list.json", ROOT_TOKEN);

                expect(response.status).toBe(200);
                expect(Array.isArray(response.body.list)).toBe(true);

                // Root user should not appear in the list
                const rootUser = response.body.list.find((u: any) => u.id === ROOT_USER_ID);
                expect(rootUser).toBeUndefined();
            });

            it("should deny access with invalid root token", async () => {
                const response = await requestHelper.get(
                    "/user/list.json",
                    INVALID_ROOT_TOKEN,
                );

                expect(response.status).toBe(401);
                expect(response.body.error).toBe("Invalid token");
            });
        });

        describe("GET /vendor/list.json", () => {
            it("should allow access with valid root token", async () => {
                const response = await requestHelper.get("/vendor/list.json", ROOT_TOKEN);

                expect(response.status).toBe(200);
                expect(Array.isArray(response.body.list)).toBe(true);
            });
        });

        describe("GET /model/list.json", () => {
            it("should allow access with valid root token", async () => {
                const response = await requestHelper.get("/model/list.json", ROOT_TOKEN);

                expect(response.status).toBe(200);
                expect(Array.isArray(response.body.list)).toBe(true);
            });
        });

        describe("GET /record/list.json", () => {
            it("should allow access with valid root token", async () => {
                const response = await requestHelper.get("/record/list.json", ROOT_TOKEN);

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("list");
                expect(response.body).toHaveProperty("total");
                expect(Array.isArray(response.body.list)).toBe(true);
            });
        });

        describe("GET /status.json", () => {
            it("should allow access with valid root token", async () => {
                const response = await requestHelper.get("/status.json", ROOT_TOKEN);

                expect(response.status).toBe(200);
            });
        });
    });

    describe("Write Operations with Root Token", () => {
        let vendorId: number;
        let modelId: number;
        let normalUserId: number;

        beforeAll(async () => {
            // Create a vendor using root token
            const vendorResponse = await requestHelper.post(
                "/vendor/create.json",
                {
                    name: "Test Vendor",
                    type: "other",
                    url: "http://localhost:9999/chat/completions",
                    token: "test-vendor-token",
                    api_format: "openai",
                },
                ROOT_TOKEN,
            );
            vendorId = vendorResponse.body.id;

            // Create a model using root token
            const modelResponse = await requestHelper.post(
                "/model/create.json",
                {
                    name: "gpt-4",
                    vendor_id: vendorId,
                },
                ROOT_TOKEN,
            );
            modelId = modelResponse.body.id;

            // Create a normal user using root token
            const userResponse = await requestHelper.post(
                "/user/create.json",
                {
                    name: "Normal User",
                    token: "normal-token-123",
                    type: "normal",
                },
                ROOT_TOKEN,
            );
            normalUserId = userResponse.body.id;
        });

        describe("POST /vendor/create.json", () => {
            it("should allow creating vendor with root token", async () => {
                const response = await requestHelper.post(
                    "/vendor/create.json",
                    {
                        name: "Another Vendor",
                        type: "other",
                        url: "http://localhost:9999/chat/completions",
                        token: "another-vendor-token",
                        api_format: "openai",
                    },
                    ROOT_TOKEN,
                );

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
            });
        });

        describe("PUT /vendor/:id", () => {
            it("should allow updating vendor with root token", async () => {
                const response = await requestHelper.put(
                    `/vendor/${vendorId}`,
                    {
                        name: "Updated Vendor",
                    },
                    ROOT_TOKEN,
                );

                expect(response.status).toBe(200);
                expect(response.body.name).toBe("Updated Vendor");
            });
        });

        describe("POST /model/create.json", () => {
            it("should allow creating model with root token", async () => {
                const response = await requestHelper.post(
                    "/model/create.json",
                    {
                        name: "gpt-3.5-turbo",
                        vendor_id: vendorId,
                    },
                    ROOT_TOKEN,
                );

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
            });
        });

        describe("POST /user/create.json", () => {
            it("should allow creating user with root token", async () => {
                const response = await requestHelper.post(
                    "/user/create.json",
                    {
                        name: "Another User",
                        token: "another-user-token",
                        type: "normal",
                    },
                    ROOT_TOKEN,
                );

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
                expect(response.body.name).toBe("Another User");
            });
        });

        describe("GET /user/:id", () => {
            it("should allow getting user with root token", async () => {
                const response = await requestHelper.get(`/user/${normalUserId}`, ROOT_TOKEN);

                expect(response.status).toBe(200);
                expect(response.body).toHaveProperty("id");
                expect(response.body).toHaveProperty("name");
                expect(response.body.name).toBe("Normal User");
            });
        });
    });

    describe("AI Requests with Root Token", () => {
        let vendorId: number;
        let modelName = "gpt-3.5-turbo-root";

        beforeAll(async () => {
            // Create a vendor
            const vendorResponse = await requestHelper.post(
                "/vendor/create.json",
                {
                    name: "AI Vendor for Root",
                    type: "other",
                    urls: {
                        openai: "http://localhost:9999/chat/completions",
                        anthropic: "http://localhost:9999/messages"
                    },
                    token: "test-vendor-token",
                },
                ROOT_TOKEN,
            );
            vendorId = vendorResponse.body.id;

            // Create a model
            await requestHelper.post(
                "/model/create.json",
                {
                    name: modelName,
                    vendor_id: vendorId,
                },
                ROOT_TOKEN,
            );
        });

        it("should allow OpenAI chat completions with root token", async () => {
            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                {
                    model: modelName,
                    messages: [{ role: "user", content: "Hello" }],
                },
                ROOT_TOKEN,
            );

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("choices");

            // Verify record user_id
            const recordsRes = await requestHelper.get("/record/latest.json?limit=1", ROOT_TOKEN);
            expect(recordsRes.body[0].user_id).toBe(ROOT_USER_ID);
        });

        it("should allow Anthropic messages with root token", async () => {
            // Create an Anthropic model
            const anthropicModel = "claude-3-haiku-20240307";
            await requestHelper.post(
                "/model/create.json",
                {
                    name: anthropicModel,
                    vendor_id: vendorId,
                },
                ROOT_TOKEN,
            );

            const response = await requestHelper.postWithAnthropicStyleApiKey(
                "/llm/v1/messages",
                {
                    model: anthropicModel,
                    max_tokens: 1024,
                    messages: [{ role: "user", content: "Hello" }],
                },
                ROOT_TOKEN,
            );

            expect(response.status).toBe(200);
            expect(response.body.type).toBe("message");

            // Verify record user_id
            const recordsRes = await requestHelper.get("/record/latest.json?limit=1", ROOT_TOKEN);
            expect(recordsRes.body[0].user_id).toBe(ROOT_USER_ID);
        });
    });

    describe("Root Token vs Normal Token Independence", () => {
        it("should work independently - root token access", async () => {
            const response = await requestHelper.get("/vendor/list.json", ROOT_TOKEN);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
        });

        it("should work independently - normal user should not have admin access", async () => {
            // Create a normal user
            const normalToken = "normal-user-token-456";
            await requestHelper.post(
                "/user/create.json",
                {
                    name: "Normal User 2",
                    token: normalToken,
                    type: "normal",
                },
                adminToken,
            );

            const response = await requestHelper.get("/vendor/list.json", normalToken);

            expect(response.status).toBe(403);
            expect(response.body.error).toBe("Admin access required");
        });

        it("should work independently - admin token still works", async () => {
            const response = await requestHelper.get("/vendor/list.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
        });
    });

    describe("Boundary Tests", () => {
        it("should return 401 when no token provided", async () => {
            const response = await requestHelper.get("/vendor/list.json");

            expect(response.status).toBe(401);
            expect(response.body.error).toBe(
                "Authorization header is missing or invalid",
            );
        });

        it("should return 401 when malformed token", async () => {
            const response = await requestHelper.get("/vendor/list.json", "Bearer " + ROOT_TOKEN);

            expect(response.status).toBe(401);
            expect(response.body.error).toBe("Invalid token");
        });

        it("should return 401 when wrong prefix format (only token without Bearer)", async () => {
            // requestHelper.get expects just the token value, which it will format as Bearer
            // This test is handled by the actual requestHelper.get implementation
            // We just need to verify invalid tokens return 401
            const response = await requestHelper.get(
                "/vendor/list.json",
                "completely-wrong-token",
            );

            expect(response.status).toBe(401);
            expect(response.body.error).toBe("Invalid token");
        });
    });
});
