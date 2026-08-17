import { join } from "path";
import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import ormService from "./service/ormService";
import recordService from "./service/recordService";
import hostService from "./service/hostService";
import app, { Env } from "./routes";
import initLogger, { Logger } from "./util/loggerUtil";
import { RunMode } from "./constants";

// --api-only: 跳过前端静态文件服务，仅提供 API（桌面 sidecar 模式使用）
export const apiOnly = process.argv.includes("--api-only");
export const desktopMode = process.argv.includes("--desktop-mode");

// 加载环境变量
// Tauri 等环境传入的变量优先级最高，.dev.vars 仅作为兜底（不会覆盖已有变量）
config({ path: join(process.cwd(), ".dev.vars"), override: false });

const DB_PATH = process.env.DB_PATH || join(process.cwd(), "local.db");

// 在桌面版下，Tauri 进程会将自己的 stdin 管道连到这里。
// 一旦 Tauri 父进程异常退出，管道断开，我们通过监听 stdin 可以及时自动清理，避免产生孤儿进程。
if (desktopMode) {
    process.stdin.resume();
    process.stdin.on("end", () => {
        console.log("Stdin ended, parent process probably died. Exiting...");
        process.exit(0);
    });
    process.stdin.on("error", () => {
        console.log("Stdin error, parent process probably died. Exiting...");
        process.exit(0);
    });
    process.stdin.on("close", () => {
        console.log("Stdin closed, parent process probably died. Exiting...");
        process.exit(0);
    });
}

function formatConsoleArg(arg: unknown): string {
    if (arg instanceof Error) {
        return arg.stack || arg.message;
    }

    if (typeof arg === "object") {
        return JSON.stringify(arg, null, 2);
    }

    return String(arg);
}


async function startServer() {
    // 保存原始 console 方法
    const originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        debug: console.debug,
    };

    // 初始化日志系统（在重写 console 之前，使用原始 console）
    const logger: Logger = initLogger(true);
    originalConsole.log("Starting server...");

    // 重写 console 方法以记录日志
    console.log = (...args: unknown[]) => {
        originalConsole.log(...args);
        const message = args.map(formatConsoleArg).join(" ");
        logger["write"]("info", message);
    };

    console.error = (...args: unknown[]) => {
        originalConsole.error(...args);
        const message = args.map(formatConsoleArg).join(" ");
        logger["write"]("error", message);
    };

    console.warn = (...args: unknown[]) => {
        originalConsole.warn(...args);
        const message = args.map(formatConsoleArg).join(" ");
        logger["write"]("warn", message);
    };

    console.debug = (...args: unknown[]) => {
        originalConsole.debug(...args);
        const message = args.map(formatConsoleArg).join(" ");
        logger["write"]("debug", message);
    };

    // 初始化本地配置
    await ormService.init({
        mode: RunMode.NODE,
        dbPath: DB_PATH,
    });
    
    // 校验数据库表结构
    await ormService.verifySchema();

    // 启动服务器
    const port = parseInt(hostService.getLocalPort(), 10);

    // 构建环境变量
    const bindings: Env = {
        DB: (ormService.dbAdapter as any).db,
        ROOT_TOKEN: process.env.ROOT_TOKEN || "",
    };

    // Static file serving (frontend) - skip in API-only mode (desktop sidecar)
    if (!apiOnly) {
        const distPath = join(process.cwd(), "frontend", "dist");

        // Pre-read index.html for SPA fallback
        let indexHtml: string;
        try {
            indexHtml = readFileSync(join(distPath, "index.html"), "utf-8");
        } catch (e) {
            console.warn("Could not read index.html, SPA fallback will not work:", e);
            indexHtml = "<!doctype html><html><body>Frontend not built</body></html>";
        }

        // SPA fallback - return index.html for all non-API routes
        // This must be registered BEFORE static file serving to handle non-existent files
        app.get("*", async (c, next) => {
            const url = new URL(c.req.url);
            const pathname = url.pathname;

            // Let asset files pass through to serveStatic middleware
            if (pathname.startsWith("/assets/") || pathname.startsWith("/data_viewer/")) {
                return next();
            }

            // Handle SVG files directly
            if (pathname.endsWith(".svg")) {
                try {
                    const fileName = pathname.substring(1); // Remove leading /
                    const filePath = join(distPath, fileName);
                    const content = readFileSync(filePath, "utf-8");
                    return c.body(content, 200, { "Content-Type": "image/svg+xml" });
                } catch (e) {
                    return c.notFound();
                }
            }

            // Skip API routes
            if (pathname.startsWith("/v1/") || pathname.startsWith("/llm/") || pathname.includes(".json")) {
                return c.json({ error: "Not found" }, 404);
            }

            // Return index.html for SPA routing
            return c.html(indexHtml, 200);
        });

        // Static file serving for built frontend assets
        app.use("/assets/*", serveStatic({ root: distPath }));
        app.use("/data_viewer/*", serveStatic({ root: distPath }));
    }

    const hostname = hostService.getLocalHost();

    const server = serve({
        fetch: (request) => app.fetch(request, bindings),
        port,
        hostname,
    });

    server.on('error', (e: any) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`ERROR: Port ${port} is already in use. Exiting...`);
            process.exit(98);
        }
    });

    server.on('listening', () => {
        console.log(`ROOT_TOKEN: ${bindings.ROOT_TOKEN}`);
        // Bypass Node.js stdout block-buffering for pipes by using writeSync
        require('fs').writeSync(1, `Server listening on http://${hostname}:${port}\n`);
    });
}

startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
