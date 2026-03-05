import { join } from "path";
import { spawn, ChildProcess } from "child_process";
import { existsSync, unlinkSync, mkdirSync, createWriteStream } from "fs";
import config from "./config";
import dbHelper from "./helpers/dbHelper";
import mockServer from "./helpers/mockServer";
import requestHelper from "./helpers/requestHelper";

// Worker mode configuration
const TEST_WRANGLER_CONFIG = "wrangler.test.toml";

let testServerProcess: ChildProcess | null = null;
let mockServerProcess: any | null = null;
let appLogStream: ReturnType<typeof createWriteStream> | null = null;
let mockLogStream: ReturnType<typeof createWriteStream> | null = null;

/**
 * Global cleanup for when tests are interrupted
 */
function globalCleanup(): void {
    console.log("[CLEANUP] Interrupted, stopping servers...");
    if (testServerProcess) {
        testServerProcess.kill("SIGTERM");
    }
    if (mockServerProcess) {
        mockServer.stopMockServer(mockServerProcess);
    }
}

// Register cleanup handlers for process interruption
process.on("SIGINT", globalCleanup);
process.on("SIGTERM", globalCleanup);

/**
 * Setup admin user via API
 * Creates an admin user via API if needed, returns the admin token
 */
async function setupAdminUser(): Promise<string> {
    const rootToken = "test-root-token-123";
    const adminToken = "admin-token-123";
    const adminUser = { name: "Admin User", token: adminToken, type: "admin" };
    console.log("Creating admin user:", adminUser);

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await requestHelper.post(
                "/user/create.json",
                adminUser,
                rootToken,
            );
            console.log("Admin user created, response:", response.status);
            break;
        } catch (e: any) {
            console.log(`Admin user creation attempt ${attempt}/${maxRetries} failed:`, e.message || e);
            if (attempt < maxRetries) {
                // Wait before retry - D1 database may be locked by wrangler d1 execute
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                console.log("Admin user creation failed after all retries");
            }
        }
    }
    return adminToken;
}

export async function setup(): Promise<void> {
    console.log("=== Test Environment Setup ===");
    console.log("[GLOBAL_SETUP] setup() called at", new Date().toISOString());

    // Ensure log directory exists
    if (!existsSync(config.LOG_CONFIG.dir)) {
        mkdirSync(config.LOG_CONFIG.dir, { recursive: true });
    }

    // Create app.log file stream (use 'w' mode to overwrite old logs on each run)
    const appLogPath = join(config.LOG_CONFIG.dir, config.LOG_CONFIG.appLogFile);
    appLogStream = createWriteStream(appLogPath, { flags: 'w' });

    // Setup database (handles both node and worker modes)
    await dbHelper.initDatabase();

    if (config.useMockServer) {
        console.log("Starting mock AI server...");
        // Initialize mock server logger
        mockServer.initMockLogger(
            config.LOG_CONFIG.dir,
            config.LOG_CONFIG.mockServerLogFile,
        );
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

    // Close log streams
    if (appLogStream) {
        appLogStream.end();
        appLogStream = null;
    }
    if (mockLogStream) {
        mockLogStream.end();
        mockLogStream = null;
    }

    // Teardown database (handles both node and worker modes)
    await dbHelper.clearDatabase(config.TEST_OPTIONS.cleanup);

    console.log("Test environment teardown complete!");
}

export { setupAdminUser };

function startTestServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        const isWorkerMode = config.TEST_MODE === "worker";
        const port = config.SERVER_CONFIG.port;

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
                port.toString(),
            ];
            env.PORT = port.toString();
        } else {
            // Node mode: use tsx src/local.ts
            const serverPath = join(process.cwd(), "src", "local.ts");
            command = ["tsx", serverPath];
            env.PORT = port.toString();
            env.DB_PATH = config.DB_CONFIG.path;
            env.ROOT_TOKEN = "test-root-token-123";
        }

        console.log(
            `Starting test server in ${config.TEST_MODE} mode on port ${port}`,
        );
        if (!isWorkerMode) {
            console.log("Database path:", config.DB_CONFIG.path);
        }

        testServerProcess = spawn("npx", command, {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let serverStarted = false;
        let timeoutId: NodeJS.Timeout;

        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        };

        testServerProcess.stdout?.on("data", (data) => {
            const output = data.toString().trim();
            if (config.TEST_OPTIONS.verbose) {
                console.log("[SERVER]", output);
            }
            // Write to app.log
            if (appLogStream) {
                appLogStream.write(
                    `[${new Date().toISOString()}] [SERVER STDOUT] ${output}\n`,
                );
            }
            // 监听服务器启动成功的消息
            if (!serverStarted) {
                if (isWorkerMode) {
                    // Wrangler dev typically outputs something like:
                    // "Ready on http://localhost:8787" or contains "Ready"
                    if (
                        output.includes("Ready") ||
                        output.includes("localhost:" + port)
                    ) {
                        serverStarted = true;
                        cleanup();
                        resolve();
                    }
                } else {
                    if (output.includes("Server listening")) {
                        serverStarted = true;
                        cleanup();
                        resolve();
                    }
                }
            }
        });

        testServerProcess.stderr?.on("data", (data) => {
            const error = data.toString().trim();
            // Write all stderr to app.log
            if (appLogStream) {
                appLogStream.write(
                    `[${new Date().toISOString()}] [SERVER STDERR] ${error}\n`,
                );
            }

            if (isWorkerMode) {
                // After server is started, don't treat stderr as fatal
                if (serverStarted) {
                    if (config.TEST_OPTIONS.verbose) {
                        console.log("[SERVER STDERR]", error);
                    }
                    return;
                }
                // Before server is started, check for startup signal in stderr
                if (config.TEST_OPTIONS.verbose) {
                    console.log("[SERVER INFO]", error);
                }
                if (
                    error.includes("Ready") ||
                    error.includes("localhost:" + port)
                ) {
                    serverStarted = true;
                    cleanup();
                    resolve();
                }
                return;
            }
            console.error("[SERVER ERROR]", error);
        });

        testServerProcess.on("error", (err) => {
            cleanup();
            reject(err);
        });

        testServerProcess.on("exit", () => {
            cleanup();
            testServerProcess = null;
        });

        // 设置超时
        timeoutId = setTimeout(() => {
            cleanup();
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

            // Try graceful shutdown with SIGTERM
            testServerProcess.kill("SIGTERM");

            // Wait for process to exit (up to 5 seconds)
            const timeout = setTimeout(() => {
                // If process doesn't exit, use SIGKILL as last resort
                console.log("[CLEANUP] Force killing test server...");
                testServerProcess!.kill("SIGKILL");
                testServerProcess = null;
                resolve();
            }, 5000);

            testServerProcess.once("exit", () => {
                clearTimeout(timeout);
                testServerProcess = null;
                console.log("Test server stopped");
                resolve();
            });
        } else {
            resolve();
        }
    });
}