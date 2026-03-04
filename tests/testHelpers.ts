/**
 * Test Helpers
 * Exposes database helpers for test files that need direct DB access
 */

import dbHelper from "./helpers/dbHelper";
import requestHelper from "./helpers/requestHelper";
import userFixtures from "./fixtures/userFixtures";

async function truncate() {
    console.log("Truncating database...");
    await dbHelper.truncate();
}

/**
 * Setup test admin user
 * Creates an admin user via API if needed, returns the admin token
 */
async function setupAdminUser() {
    const adminUser = userFixtures.USER_FIXTURES.admin;
    console.log("Creating admin user:", adminUser);
    try {
        const response = await requestHelper.post("/user/create.json", {
            name: adminUser.name,
            token: adminUser.token,
            type: adminUser.type,
        });
        console.log("Admin user created, response:", response.status);
    } catch (e: any) {
        console.log("Admin user creation error:", e.response?.status, e.message || e);
        // User might already exist, ignore
        if (!e.response || e.response.status !== 400) {
            console.log("Admin user creation info:", e.message || e);
        }
    }
    return adminUser.token;
}

export default {
    query: dbHelper.query,
    execute: dbHelper.execute,
    truncate,
    setupAdminUser,
};
