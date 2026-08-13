import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";

/**
 * Frontend-Backend API Coexistence Tests
 * Verifies that API endpoints work correctly alongside frontend static file serving
 */

let adminToken: string;

describe("Frontend-Backend API Coexistence", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
    });

    it("should serve API endpoints alongside frontend", async () => {
        const response = await requestHelper.get("/welcome");

        expect(response.status).toBe(200);
        expect(typeof response.body).toBe("string");
        expect(response.body).toContain("serverless ai gateway");
    });

    it("should return JSON 404 for unknown API routes", async () => {
        const response = await requestHelper.get("/v1/nonexistent");

        expect(response.status).toBe(404);
        expect(response.body).toHaveProperty("error");
    });

    it("should allow API operations with admin token", async () => {
        const vendorData = {
            type: "other",
            name: "Test Vendor",
            token: "test-token",
            urls: { openai: "http://localhost:9999" },
        };

        const response = await requestHelper.post(
            "/vendor/create.json",
            vendorData,
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("id");
    });
});
