import { join } from "path";
import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync, unlinkSync, rmSync } from "fs";
import config from "./config";
import dbHelper from "./helpers/dbHelper";
import mockServer from "./helpers/mockServer";
import requestHelper from "./helpers/requestHelper";

// Worker mode configuration - use test database
const TEST_DB_NAME = "serverless_ai_gateway_test";
const TEST_WRANGLER_CONFIG = "wrangler.test.toml";
const WRANGLER_D1_DIR = join(process.cwd(), ".wrangler", "state", "v3", "d1");

let testServerProcess: ChildProcess | null = null;
let mockServerProcess: any | null = null;

// Helper to run wrangler D1 commands (worker mode only)
function runD1Command(args: string[]): string {
    const cmd = `npx wrangler d1 execute ${TEST_DB_NAME} --local --config ${TEST_WRANGLER_CONFIG} ${args.join(" ")}`;
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
}

// Clear D1 local database file - worker mode only
function clearD1LocalDatabase(): void {
    console.log("[WORKER_SETUP] Clearing D1 test database...");

    try {
        // D1 local databases are stored in .wrangler/state/v3/d1/{database_name}
        const dbDir = join(WRANGLER_D1_DIR, TEST_DB_NAME);
        if (existsSync(dbDir)) {
            rmSync(dbDir, { recursive: true, force: true });
            console.log("[WORKER_SETUP] D1 test database deleted");
        } else {
            console.log("[WORKER_SETUP] D1 test database not found, skipping");
        }
    } catch (e) {
        console.error("[WORKER_SETUP] Failed to clear D1 test database:", e);
    }
}

// Clear D1 database tables (but keep schema) - worker mode only
function clearD1Tables(): void {
    console.log("[WORKER_SETUP] Clearing D1 database tables...");

    try {
        // Get all tables except system tables
        const output = runD1Command([
            "--json",
            "--command=\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'\"",
        ]);

        const match = output.match(/\[.*\]/s);
        if (match) {
            const parsed = JSON.parse(match[0]);
            const tables =
                Array.isArray(parsed) &&
                parsed.length > 0 &&
                Array.isArray(parsed[0]?.results)
                    ? (parsed[0].results as { name: string }[])
                    : [];

            for (const table of tables) {
                runD1Command([`--command="DELETE FROM ${table.name}"`]);
            }

            console.log(`[WORKER_SETUP] Cleared ${tables.length} tables`);
        }
    } catch (e) {
        console.error("[WORKER_SETUP] Failed to clear D1 tables:", e);
    }
}

// Setup admin user in worker mode (for D1 direct operations)
function setupAdminUser(): void {
    console.log("[WORKER_SETUP] Setting up admin user...");
    const now = new Date().toISOString();
    try {
        runD1Command([
            `--command="INSERT INTO user (name, token, type, created_at, updated_at) VALUES ('Admin User', 'admin-token-123', 'admin', '${now}', '${now}')"`,
        ]);
        console.log("[WORKER_SETUP] Admin user created");
    } catch (e) {
        console.log("[WORKER_SETUP] Admin user might already exist:", (e as any).message || e);
    }
}

export async function setup(): Promise<void> {
    console.log("=== Test Environment Setup ===");
    console.log("[GLOBAL_SETUP] setup() called at", new Date().toISOString());
    console.log("[GLOBAL_SETUP] Test mode:", config.TEST_MODE);

    const isWorkerMode = config.TEST_MODE === "worker";

    if (isWorkerMode) {
        console.log("[GLOBAL_SETUP] Worker mode: D1 database managed by wrangler");
        // Clear D1 test database for clean test environment
        clearD1LocalDatabase();
        // Run migrations for D1 using command line with test config
        console.log("[GLOBAL_SETUP] Running migrations for D1...");
        try {
            execSync(`npx tsx script/db.ts migrate --env worker-local --db-name ${TEST_DB_NAME} --config ${TEST_WRANGLER_CONFIG}`, {
                stdio: "inherit",
            });
        } catch (e) {
            console.error("[GLOBAL_SETUP] Failed to run migrations:", e);
        }
    } else {
        cleanupTestDatabaseFile();
        console.log("[GLOBAL_SETUP] Database file deleted");

        console.log("Initializing test database...");
        await dbHelper.init();
        console.log("[GLOBAL_SETUP] Database initialized");
    }

    if (config.useMockServer) {
        console.log("Starting mock AI server...");
        mockServerProcess = await mockServer.startMockServer();
        console.log("[GLOBAL_SETUP] Mock AI server started");
    }

    await startTestServer();
    console.log("[GLOBAL_SETUP] Test server started");

    // Create initial admin user for tests (via API in both modes)
    try {
        await requestHelper.post("/user/create.json", {
            name: "Admin User",
            token: "admin-token-123",
            type: "admin",
        });
        console.log("[GLOBAL_SETUP] Initial admin user created");
    } catch (e: any) {
        // User might already exist, ignore
        if (!e.response || e.response.status !== 400) {
            console.log("[GLOBAL_SETUP] Admin user creation info:", e.message || e);
        }
    }

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

    if (config.TEST_OPTIONS.cleanup) {
        const isWorkerMode = config.TEST_MODE === "worker";

        if (isWorkerMode) {
            console.log("[GLOBAL_TEARDOWN] Worker mode: Cleaning up D1 local database...");
            clearD1LocalDatabase();
            console.log("[GLOBAL_TEARDOWN] D1 local database cleaned up");
        } else {
            console.log("Cleaning up test database...");
            await dbHelper.cleanup();
            cleanupTestDatabaseFile();
            console.log(
                "[GLOBAL_TEARDOWN] Database cleaned up and file deleted",
            );
        }
    }

    console.log("Test environment teardown complete!");
}

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

function cleanupTestDatabaseFile(): void {
    const isWorkerMode = config.TEST_MODE === "worker";

    if (isWorkerMode) {
        // Worker mode uses D1, no local file to delete
        console.log("[WORKER_MODE] Using D1 database, no local file to delete");
        return;
    }

    if (existsSync(config.DB_CONFIG.path)) {
        console.log("Removing test database file:", config.DB_CONFIG.path);
        unlinkSync(config.DB_CONFIG.path);
    }
}

// Export functions for dbHelper.truncate() to call in worker mode
export { clearD1Tables, setupAdminUser };