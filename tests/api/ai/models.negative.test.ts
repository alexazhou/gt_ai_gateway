import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";

const adminToken = "admin-token-123";
const disabledToken = "disabled-models-user-token";

describe("GET /llm/v1/models authentication", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();

        const user = await requestHelper.post(
            "/user/create.json",
            { name: "Disabled Models User", token: disabledToken, type: "normal" },
            adminToken,
        );
        await requestHelper.put(
            `/user/${user.body.id}`,
            { status: "disabled" },
            adminToken,
        );
    });

    it("rejects a request without authentication", async () => {
        const response = await requestHelper.get("/llm/v1/models");

        expect(response.status).toBe(401);
        expect(response.body.error.type).toBe("authentication_error");
    });

    it("rejects an invalid token", async () => {
        const response = await requestHelper.get("/llm/v1/models", "invalid-token");

        expect(response.status).toBe(401);
        expect(response.body.error.message).toContain("Invalid token");
    });

    it("rejects a disabled user", async () => {
        const response = await requestHelper.get("/llm/v1/models", disabledToken);

        expect(response.status).toBe(403);
        expect(response.body.error.message).toBe("User disabled");
    });
});
