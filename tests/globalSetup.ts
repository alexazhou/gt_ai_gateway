import { join } from "path";
import { spawn, ChildProcess } from "child_process";
import { existsSync, unlinkSync } from "fs";
import config from "./config";
import dbHelper from "./helpers/dbHelper";
import mockServer from "./helpers/mockServer";

let testServerProcess: ChildProcess | null = null;
let mockServerProcess: any | null = null;

export async function setup(): Promise<void> {
    console.log("=== Test Environment Setup ===");
    console.log("[GLOBAL_SETUP] setup() called at", new Date().toISOString());
    console.log("[GLOBAL_SETUP] Test mode:", config.TEST_MODE);

    const isWorkerMode = config.TEST_MODE === "worker";

    if (isWorkerMode) {
        console.log(
            "[GLOBAL_SETUP] Worker mode: D1 database managed by wrangler, no local init needed",
        );
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
            console.log(
                "[GLOBAL_TEARDOWN] Worker mode: D1 database cleanup skipped (managed by wrangler)",
            );
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

        if (isWorkerMode) {
            // Worker mode: use wrangler dev
            command = [
                "wrangler",
                "dev",
                "--local",
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
                        output.includes(
                            "localhost:" + config.SERVER_CONFIG.port,
                        )
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
                (error.includes("⛅️") || error.includes("http://"))
            ) {
                if (config.TEST_OPTIONS.verbose) {
                    console.log("[SERVER INFO]", error);
                }
                if (
                    (!serverStarted && error.includes("Ready")) ||
                    error.includes("localhost:" + config.SERVER_CONFIG.port)
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

        // 设置超时 - worker mode needs more time
        const timeout = isWorkerMode
            ? config.WORKER_CONFIG.startupTimeout
            : 3000;
        setTimeout(() => {
            if (!serverStarted) {
                reject(new Error(`Server startup timeout (${timeout}ms)`));
            }
        }, timeout);
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
