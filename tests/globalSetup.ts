import { join } from "path";
import net from "node:net";
import { spawn, ChildProcess } from "child_process";
import { existsSync, unlinkSync, mkdirSync, createWriteStream } from "fs";
import config from "./config";
import dbHelper from "./helpers/dbHelper";
import mockServer from "./helpers/mockServer";
import mockProxy from "./helpers/mockProxyServer";
import mockSocks from "./helpers/mockSocksServer";
import requestHelper from "./helpers/requestHelper";
import userFixtures from "./fixtures/userFixtures";

// Worker mode configuration
const TEST_WRANGLER_CONFIG = "wrangler.test.toml";

let testServerProcess: ChildProcess | null = null;
let mockServerProcess: any | null = null;
let mockProxyProcess: any | null = null;
let mockSocksProcess: any | null = null;
let appLogStream: ReturnType<typeof createWriteStream> | null = null;
let mockLogStream: ReturnType<typeof createWriteStream> | null = null;

/**
 * 杀掉测试服务的**整个进程组**，而不只是 spawn 出来的那个句柄。
 *
 * 为什么必须这样（#27 的根因，实测而不是推断）：
 *   `npx tsx src/local.ts` 实测是**两层**进程
 *     wrapper：`node …/node_modules/.bin/tsx src/local.ts`（不监听任何端口）
 *     loader ：`node --require …/tsx/dist/preflight.cjs … src/local.ts`（**真正持 socket 的那个**）
 *   原来只 `testServerProcess.kill("SIGTERM")` 杀 wrapper，loader 收不到信号 → 被 reparent 成
 *   `ppid=1` 孤儿，并且会换到 5xxxx 临时端口继续活着。
 *   → 所以 **`lsof -iTCP:9720` 为空不等于没有僵尸**：9720 是关掉了，进程换个端口还在。
 *     这正是「`Test environment teardown complete!` 自称成功」的机制（R5 型）。
 * 修法：spawn 时 `detached: true` 建独立进程组（pgid == pid），teardown 用 `process.kill(-pid)` 打整组。
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (!pid) {
        return;
    }
    try {
        process.kill(-pid, signal); // 负 PID = 整个进程组
        return;
    } catch (e: any) {
        if (e?.code === "ESRCH") {
            return; // 整组都已经没了
        }
        // Windows 没有负 PID 语义 / 非 detached 场景：退化成只杀直接子进程（退而求其次，但不静默）
        console.error(
            `[CLEANUP] 进程组 kill 失败（${e?.code ?? e?.message}），退化为只杀直接子进程 pid=${pid}`,
        );
        try {
            child.kill(signal);
        } catch {
            /* 已退出 */
        }
    }
}

/** 端口是否空闲（自己 bind 一次，不依赖 lsof/PATH） */
function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once("error", (e: any) => resolve(e?.code !== "EADDRINUSE"));
        srv.once("listening", () => srv.close(() => resolve(true)));
        srv.listen(port, "127.0.0.1");
    });
}

/** 轮询等端口释放；返回**仍未**释放的端口（空数组 = 全释放） */
async function waitPortsReleased(
    ports: number[],
    timeoutMs: number,
): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    let busy: number[] = [];
    do {
        busy = [];
        for (const port of ports) {
            if (!(await isPortFree(port))) {
                busy.push(port);
            }
        }
        if (busy.length === 0 || Date.now() >= deadline) {
            return busy;
        }
        await new Promise((r) => setTimeout(r, 100));
    } while (true);
}

/** 列出仍残留的测试服务进程（只打印，不代杀 —— 杀进程不是 teardown 的职责） */
function listResidualServerProcesses(): string[] {
    try {
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        return execSync("ps -Ao pid,ppid,command", { encoding: "utf8" })
            .split("\n")
            .filter(
                (l) =>
                    /src\/local\.ts|wrangler dev/.test(l) &&
                    !/ps -Ao pid,ppid,command/.test(l),
            )
            .slice(0, 10)
            .map((l) => l.trim());
    } catch {
        return [];
    }
}

/**
 * Global cleanup for when tests are interrupted
 */
function globalCleanup(): void {
    console.log("[CLEANUP] Interrupted, stopping servers...");
    if (testServerProcess) {
        killProcessTree(testServerProcess, "SIGTERM");
    }
    if (mockServerProcess) {
        mockServer.stopMockServer(mockServerProcess);
    }
    if (mockProxyProcess) {
        mockProxy.stopMockProxy(mockProxyProcess);
    }
    if (mockSocksProcess) {
        mockSocks.stopMockSocks(mockSocksProcess);
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
    const rootToken = "root-token-123";
    const adminToken = userFixtures.ADMIN_TOKEN;
    const adminUser = { name: "Admin User", token: adminToken, type: "admin" };
    console.log("Creating admin user:", adminUser);

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await requestHelper.post(
                "/user/create.json",
                adminUser,
                rootToken,
            );
            console.log("Admin user created, response:", response.status);
            
            if (response.status === 200 || response.status === 409) {
                break;
            }
            
            console.log(`Admin user creation attempt ${attempt}/${maxRetries} failed with status ${response.status}`);
        } catch (e: any) {
            console.log(`Admin user creation attempt ${attempt}/${maxRetries} failed:`, e.message || e);
        }
        
        if (attempt < maxRetries) {
            // Wait before retry - D1 database may be locked by wrangler d1 execute or server starting up
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            console.log("Admin user creation failed after all retries");
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
        const mockServerPort = new URL(config.UPSTREAM_CONFIG.mock.url).port || "9999";
        // Initialize mock server logger
        mockServer.initMockLogger(
            config.LOG_CONFIG.dir,
            config.LOG_CONFIG.mockServerLogFile,
        );
        mockServerProcess = await mockServer.startMockServer(parseInt(mockServerPort, 10));
        console.log("[GLOBAL_SETUP] Mock AI server started");

        // 启动 mock HTTP 代理服务器（供代理相关测试使用）
        const proxyPort = parseInt(process.env.TEST_PROXY_PORT || "9997", 10);
        mockProxyProcess = await mockProxy.startMockProxy(proxyPort);
        console.log("[GLOBAL_SETUP] Mock HTTP proxy started");

        // 启动 mock SOCKS5 代理服务器（供 SOCKS5 代理相关测试使用）
        const socksPort = parseInt(process.env.TEST_SOCKS_PORT || "9996", 10);
        mockSocksProcess = await mockSocks.startMockSocks(socksPort);
        console.log("[GLOBAL_SETUP] Mock SOCKS5 server started");
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

    if (mockProxyProcess) {
        await mockProxy.stopMockProxy(mockProxyProcess);
        mockProxyProcess = null;
        console.log("[GLOBAL_TEARDOWN] Mock HTTP proxy stopped");
    }

    if (mockSocksProcess) {
        await mockSocks.stopMockSocks(mockSocksProcess);
        mockSocksProcess = null;
        console.log("[GLOBAL_TEARDOWN] Mock SOCKS5 server stopped");
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

    // 终检：所有 server 都停完之后，端口必须**真的**空出来。
    // 为什么放这里而不是 stopTestServer 里：9999 是 in-process mock，停它要等上面的 stopMockServer。
    // 为什么要有这一步：`Test environment teardown complete!` 以前是**自称** —— 端口关了但进程还在
    // （换到 5xxxx 临时端口），机上一夜能攒几十个 ppid=1 孤儿（#27）。
    const portsToCheck = [config.SERVER_CONFIG.port];
    if (config.useMockServer) {
        const mockPort = parseInt(
            new URL(config.UPSTREAM_CONFIG.mock.url).port || "9999",
            10,
        );
        portsToCheck.push(mockPort);
    }
    const stillBusy = await waitPortsReleased(portsToCheck, 2000);
    if (stillBusy.length > 0) {
        console.error(
            `[GLOBAL_TEARDOWN][ERROR] 端口未释放：${stillBusy.join(", ")} —— teardown 不算成功`,
        );
        const residual = listResidualServerProcesses();
        if (residual.length > 0) {
            console.error("[GLOBAL_TEARDOWN][ERROR] 残留进程（只列出，不代杀）：");
            for (const l of residual) {
                console.error(`  ${l}`);
            }
        }
    } else {
        console.log(
            `[GLOBAL_TEARDOWN] 端口已确认释放：${portsToCheck.join(", ")}`,
        );
    }

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
            // Use --var to explicitly set ROOT_TOKEN and avoid interference from .dev.vars
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
            env.ROOT_TOKEN = "root-token-123";
            env.TEST_MODE = "node";
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
            // #27：独立进程组。`npx tsx` 会再 fork 出 loader 子进程，只有独立进程组才能
            // 在 teardown 时用 `process.kill(-pid)` 一次把 wrapper + loader 全部打掉。
            detached: true,
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

            if (
                output.toLowerCase().includes("eaddrinuse") ||
                output.toLowerCase().includes("address already in use") ||
                output.toLowerCase().includes("would you like to use port") ||
                output.toLowerCase().includes("is in use")
            ) {
                cleanup();
                reject(new Error(`Test server port ${port} is already in use. Server output: ${output}`));
                return;
            }

            // 监听服务器启动成功的消息
            if (!serverStarted) {
                if (isWorkerMode) {
                    // Wrangler dev typically outputs something like:
                    // "Ready on http://localhost:9720" or contains "Ready"
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

                if (
                    error.toLowerCase().includes("eaddrinuse") ||
                    error.toLowerCase().includes("address already in use")
                ) {
                    cleanup();
                    reject(new Error(`Test server port ${port} is already in use.`));
                    return;
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

        testServerProcess.on("exit", (code) => {
            cleanup();
            testServerProcess = null;
            if (!serverStarted) {
                reject(new Error(`Test server exited prematurely with code ${code}`));
            }
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

async function stopTestServer(): Promise<void> {
    if (!testServerProcess) {
        return;
    }

    const child = testServerProcess;
    // 先挂 exit 监听再发信号：wrapper 可能瞬间就退，晚一步就等不到事件
    const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        child.once("exit", () => resolve());
    });

    console.log("Stopping test server... (process group, SIGTERM)");
    killProcessTree(child, "SIGTERM");

    let stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);

    if (!stopped) {
        // 进程组还在 → 升级 SIGKILL（这是「不响应 SIGTERM」的唯一出路，反证见 t27 日志）
        console.log("[CLEANUP] 进程组 5s 未退出，升级 SIGKILL");
        killProcessTree(child, "SIGKILL");
        stopped = await Promise.race([
            exited.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
        ]);
    }

    testServerProcess = null;

    // 进程组退出 ≠ 端口已释放（后代可能已被 reparent 到 1）→ 用端口做终检。
    // 这一步就是「teardown 自称成功」的解药：不看到端口真空出来，不说 stopped。
    const stillBusy = await waitPortsReleased([config.SERVER_CONFIG.port], 2000);
    if (stillBusy.length > 0) {
        // ⚠️ 清理失败**只报错、不抛**：不得把一条本来全绿的测试门变成红（#27 要求 4）
        console.error(
            `[CLEANUP][ERROR] 测试服务端口未释放：${stillBusy.join(", ")}` +
                `（进程组 ${stopped ? "已退出" : "未在 7s 内退出"}）`,
        );
        const residual = listResidualServerProcesses();
        if (residual.length > 0) {
            console.error("[CLEANUP][ERROR] 残留进程（只列出，不代杀）：");
            for (const l of residual) {
                console.error(`  ${l}`);
            }
        }
    } else {
        console.log(`Test server stopped（端口 ${config.SERVER_CONFIG.port} 已释放）`);
    }
}
