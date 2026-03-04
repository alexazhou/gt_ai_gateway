import { join } from "path";
import { spawn, ChildProcess } from "child_process";
import { existsSync, unlinkSync } from "fs";
import config from "./config";
import dbHelper from "./helpers/dbHelper";
import mockServer from "./helpers/mockServer";
import requestHelper from "./helpers/requestHelper";

// Worker mode configuration
const TEST_WRANGLER_CONFIG = "wrangler.test.toml";

let testServerProcess: ChildProcess | null = null;
let mockServerProcess: any | null = null;

/**
 * Setup admin user via API
 * Creates an admin user via API if needed, returns the admin token
 */
async function setupAdminUser(): Promise<string> {
    const adminToken = "admin-token-123";
    const adminUser = { name: "Admin User", token: adminToken, type: "admin" };
    console.log("Creating admin user:", adminUser);
    try {
        const response = await requestHelper.post("/user/create.json", adminUser);
        console.log("Admin user created, response:", response.status);
    } catch (e: any) {
        console.log("Admin user creation error:", e.response?.status, e.message || e);
        // User might already exist, ignore
        if (!e.response || e.response.status !== 400) {
            console.log("Admin user creation info:", e.message || e);
        }
    }
    return adminToken;
}

export async function setup(): Promise<void> {
    console.log("=== Test Environment Setup ===");
    console.log("[GLOBAL_SETUP] setup() called at", new Date().toISOString());

    // Setup database (handles both node and worker modes)
    await dbHelper.globalSetup();

    if (config.useMockServer) {
        console.log("Starting mock AI server...");
        mockServerProcess = await mockServer.startMockServer();
        console.log("[GLOBAL_SETUP] Mock AI server started");
    }

    await startTestServer();
    console.log("[GLOBAL_SETUP] Test server started");

    // Create initial admin user for tests (via API in both modes)
    await setupAdminUser();
    console.log("[GLOBAL_SETUP] Initial admin user created");

    console.log("Test environment ready!");
}

export async function teardown(): Promise<void> {
    console.log("=== Test Environment Teardown ===");
    console.log(
        "[GLOBAL_TEARDOWN] teardown() called at",
        new Date().toISOString(),
    );

    await stopTestServer();
    console.log("[GLOBAL_TEARDOWN] Test server stopped");

    if (mockServerProcess) {
        await mockServer.stopMockServer(mockServerProcess);
        mockServerProcess = null;
        console.log("[GLOBAL_TEARDOWN] Mock AI server stopped");
    }

    // Teardown database (handles both node and worker modes)
    await dbHelper.globalTeardown(config.TEST_OPTIONS.cleanup);

    console.log("Test environment teardown complete!");
}

export { setupAdminUser };

function startTestServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        const isWorkerMode = config.TEST_MODE === "worker";

        let command: string[];
        let env: NodeJS.ProcessEnv = { ...process.env };
        const startupTimeout = isWorkerMode ? 30000 : 3000;

        if (isWorkerMode) {
            // Worker mode: use wrangler dev with test config
            command = [
                "wrangler",
                "dev",
                "--local",
                "--config",
                TEST_WRANGLER_CONFIG,
                "--port",
                config.SERVER_CONFIG.port.toString(),
            ];
            env.PORT = config.SERVER_CONFIG.port.toString();
        } else {
            // Node mode: use tsx src/local.ts
            const serverPath = join(process.cwd(), "src", "local.ts");
            command = ["tsx", serverPath];
            env.PORT = config.SERVER_CONFIG.port.toString();
            env.DB_PATH = config.DB_CONFIG.path;
            env.ROOT_TOKEN = "test-root-token-123";
        }

        console.log(
            `Starting test server in ${config.TEST_MODE} mode on port ${config.SERVER_CONFIG.port}`,
        );
        if (!isWorkerMode) {
            console.log("Database path:", config.DB_CONFIG.path);
        }

        testServerProcess = spawn("npx", command, {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let serverStarted = false;

        testServerProcess.stdout?.on("data", (data) => {
            const output = data.toString().trim();
            if (config.TEST_OPTIONS.verbose) {
                console.log("[SERVER]", output);
            }
            // 监听服务器启动成功的消息
            if (!serverStarted) {
                if (isWorkerMode) {
                    // Wrangler dev typically outputs something like:
                    // "Ready on http://localhost:8787" or contains "Ready"
                    if (
                        output.includes("Ready") ||
                        output.includes("localhost:" + config.SERVER_CONFIG.port)
                    ) {
                        serverStarted = true;
                        resolve();
                    }
                } else {
                    if (output.includes("Server listening")) {
                        serverStarted = true;
                        resolve();
                    }
                }
            }
        });

        testServerProcess.stderr?.on("data", (data) => {
            const error = data.toString().trim();
            // Some wrangler output goes to stderr but is not an error
            if (
                isWorkerMode &&
                (error.includes("⛅️") ||
                    error.includes("http://") ||
                    error.includes("GET"))
            ) {
                if (config.TEST_OPTIONS.verbose) {
                    console.log("[SERVER INFO]", error);
                }
                if (
                    !serverStarted &&
                    (error.includes("Ready") ||
                        error.includes("localhost:" + config.SERVER_CONFIG.port))
                ) {
                    serverStarted = true;
                    resolve();
                }
                return;
            }
            console.error("[SERVER ERROR]", error);
            reject(new Error(error));
        });

        testServerProcess.on("error", (err) => {
            reject(err);
        });

        // 设置超时
        setTimeout(() => {
            if (!serverStarted) {
                reject(
                    new Error(`Server startup timeout (${startupTimeout}ms)`),
                );
            }
        }, startupTimeout);
    });
}

function stopTestServer(): Promise<void> {
    return new Promise((resolve) => {
        if (testServerProcess) {
            console.log("Stopping test server...");
            testServerProcess.kill("SIGTERM");
            testServerProcess = null;
        }
        resolve();
    });
}