import { spawn, ChildProcess, execSync } from "child_process";
import config from "./config";
import mockServer from "./helpers/mockServer";

// Worker mode uses wrangler dev on port 8787
const WORKER_PORT = 8787;
const WORKER_STARTUP_TIMEOUT = 30000; // 30 seconds
const DB_ID = "serverless_ai_gateway";

let testServerProcess: ChildProcess | null = null;
let mockServerProcess: any | null = null;

// Helper to run wrangler D1 commands
function runD1Command(args: string[]): string {
    const cmd = `npx wrangler d1 execute ${DB_ID} --local ${args.join(" ")}`;
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
}

// Clear D1 database tables (but keep schema)
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

export async function setup(): Promise<void> {
    console.log("=== Test Environment Setup (Worker Mode) ===");
    console.log("[GLOBAL_SETUP] setup() called at", new Date().toISOString());
    console.log("[GLOBAL_SETUP] Test mode: worker");

    console.log("[GLOBAL_SETUP] Worker mode: D1 database managed by wrangler");

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
    console.log("=== Test Environment Teardown (Worker Mode) ===");
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
        console.log(
            "[GLOBAL_TEARDOWN] Worker mode: D1 database cleanup skipped (managed by wrangler)",
        );
    }

    console.log("Test environment teardown complete!");
}

function startTestServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        // Worker mode: use wrangler dev
        const command = [
            "wrangler",
            "dev",
            "--local",
            "--port",
            WORKER_PORT.toString(),
        ];
        const env: NodeJS.ProcessEnv = { ...process.env };
        env.PORT = WORKER_PORT.toString();

        console.log(
            `Starting test server in worker mode on port ${WORKER_PORT}`,
        );

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
                // Wrangler dev typically outputs something like:
                // "Ready on http://localhost:8787" or contains "Ready"
                if (
                    output.includes("Ready") ||
                    output.includes("localhost:" + WORKER_PORT)
                ) {
                    serverStarted = true;
                    resolve();
                }
            }
        });

        testServerProcess.stderr?.on("data", (data) => {
            const error = data.toString().trim();
            // Some wrangler output goes to stderr but is not an error
            if (
                error.includes("⛅️") ||
                error.includes("http://") ||
                error.includes("GET")
            ) {
                if (config.TEST_OPTIONS.verbose) {
                    console.log("[SERVER INFO]", error);
                }
                if (
                    !serverStarted &&
                    (error.includes("Ready") ||
                        error.includes("localhost:" + WORKER_PORT))
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
        setTimeout(() => {
            if (!serverStarted) {
                reject(
                    new Error(
                        `Server startup timeout (${WORKER_STARTUP_TIMEOUT}ms)`,
                    ),
                );
            }
        }, WORKER_STARTUP_TIMEOUT);
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

// Export clearD1Tables so tests can use it for proper isolation
export { clearD1Tables };
