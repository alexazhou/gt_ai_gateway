import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Frontend Static File Serving Tests
 * Verifies that the backend correctly serves frontend static files
 * and handles SPA routing
 *
 * Works in both node and worker modes
 */


/**
 * Helper to get the first available asset file of a given type (node mode only)
 */
function getFirstAsset(type: "js" | "css" | "svg"): string | null {
    const distPath = join(process.cwd(), "frontend", "dist");
    const assetsPath = join(distPath, "assets");

    try {
        if (type === "svg") {
            const files = readdirSync(distPath);
            const svg = files.find(f => f.endsWith(".svg"));
            return svg ? `/${svg}` : null;
        } else {
            const files = readdirSync(assetsPath);
            const file = files.find(f => f.endsWith(`.${type}`));
            return file ? `/assets/${file}` : null;
        }
    } catch {
        return null;
    }
}


function getDataViewerAssets(): string[] {
    const indexPath = join(process.cwd(), "frontend", "dist", "data_viewer", "dist", "index.html");

    try {
        const html = readFileSync(indexPath, "utf-8");
        return Array.from(html.matchAll(/(?:src|href)=(?:"|')([^"']+\.(?:js|css))(?:"|')/g))
            .map((match) => `/data_viewer/dist/${match[1].replace(/^\.\//, "")}`);
    } catch {
        return [];
    }
}


/**
 * Helper to make a request and get raw text response
 */
async function getRaw(endpoint: string): Promise<{
    status: number;
    body: string;
    contentType: string | null;
}> {
    const response = await requestHelper.request(endpoint, { method: "GET" });
    const textBody = typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body);

    return {
        status: response.status,
        body: textBody,
        contentType: response.headers.get("content-type"),
    };
}


describe("Frontend Static File Serving", () => {
    describe("Homepage", () => {
        it("should serve HTML at root path", async () => {
            const response = await getRaw("/");

            expect(response.status).toBe(200);
            expect(response.contentType).toContain("text/html");
            expect(response.body).toContain("<!doctype html>");
            expect(response.body).toContain('<div id="app">');
        });
    });


    describe("Static Assets", () => {
        it("should serve JavaScript files", async () => {
            // Discover actual file (works in both modes)
            const asset = getFirstAsset("js");

            if (!asset) {
                console.warn("No JS assets found, skipping test");
                return;
            }

            const response = await getRaw(asset);
            expect(response.status).toBe(200);
            // Worker mode may return different content-type
            expect(response.contentType).toMatch(/javascript|octet-stream/);
        });


        it("should serve CSS files", async () => {
            // Discover actual file (works in both modes)
            const asset = getFirstAsset("css");

            if (!asset) {
                console.warn("No CSS assets found, skipping test");
                return;
            }

            const response = await getRaw(asset);
            expect(response.status).toBe(200);
            expect(response.contentType).toMatch(/css|octet-stream/);
        });


        it("should serve SVG files", async () => {
            // Discover actual file (works in both modes)
            const asset = getFirstAsset("svg");

            if (!asset) {
                console.warn("No SVG assets found, skipping test");
                return;
            }

            const response = await getRaw(asset);
            expect(response.status).toBe(200);
            expect(response.contentType).toContain("image/svg");
        });


        it("should serve data viewer files", async () => {
            const indexResponse = await getRaw("/data_viewer/dist/index.html");
            expect(indexResponse.status).toBe(200);
            expect(indexResponse.contentType).toContain("text/html");
            expect(indexResponse.body).toContain("Vue Beautiful Chat Demo");

            const assets = getDataViewerAssets();

            if (assets.length === 0) {
                console.warn("No data viewer assets found, skipping asset checks");
                return;
            }

            for (const asset of assets) {
                const response = await getRaw(asset);
                expect(response.status).toBe(200);

                if (asset.endsWith(".js")) {
                    expect(response.contentType).toMatch(/javascript|octet-stream/);
                    expect(response.body).not.toContain("GT AI Gateway");
                }

                if (asset.endsWith(".css")) {
                    expect(response.contentType).toMatch(/css|octet-stream/);
                    expect(response.body).not.toContain("GT AI Gateway");
                }
            }
        });
    });


    describe("SPA Fallback", () => {
        it("should return index.html for /dashboard", async () => {
            const response = await getRaw("/dashboard");

            expect(response.status).toBe(200);
            expect(response.contentType).toContain("text/html");
            expect(response.body).toContain("<!doctype html>");
            expect(response.body).toContain('<div id="app">');
        });


        it("should return index.html for /vendor", async () => {
            const response = await getRaw("/vendor");

            expect(response.status).toBe(200);
            expect(response.contentType).toContain("text/html");
            expect(response.body).toContain("<!doctype html>");
        });


        it("should return index.html for nested paths", async () => {
            const response = await getRaw("/some/nested/path");

            expect(response.status).toBe(200);
            expect(response.contentType).toContain("text/html");
        });
    });
});


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
