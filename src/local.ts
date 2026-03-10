import { join } from "path";
import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import ormService from "./service/ormService";
import app, { Env } from "./routes";
import initLogger, { Logger } from "./util/logger";

// 加载环境变量
config({ path: join(process.cwd(), ".dev.vars") });

const DB_PATH = process.env.DB_PATH || join(process.cwd(), "local.db");

async function startServer() {
    // 保存原始 console 方法
    const originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        debug: console.debug,
    };

    // 初始化日志系统（在重写 console 之前，使用原始 console）
    const logger: Logger = initLogger(process.cwd(), true);
    originalConsole.log("Starting server...");

    // 重写 console 方法以记录日志
    console.log = (...args: unknown[]) => {
        originalConsole.log(...args);
        const message = args.map((arg) => {
            if (typeof arg === "object") {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        }).join(" ");
        logger["write"]("info", message);
    };

    console.error = (...args: unknown[]) => {
        originalConsole.error(...args);
        const message = args.map((arg) => {
            if (typeof arg === "object") {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        }).join(" ");
        logger["write"]("error", message);
    };

    console.warn = (...args: unknown[]) => {
        originalConsole.warn(...args);
        const message = args.map((arg) => {
            if (typeof arg === "object") {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        }).join(" ");
        logger["write"]("warn", message);
    };

    console.debug = (...args: unknown[]) => {
        originalConsole.debug(...args);
        const message = args.map((arg) => {
            if (typeof arg === "object") {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        }).join(" ");
        logger["write"]("debug", message);
    };

    // 初始化本地配置
    await ormService.init({
        mode: "local",
        dbPath: DB_PATH,
    });

    // 启动服务器
    const port = parseInt(process.env.PORT || "3000", 10);

    // 构建环境变量
    const bindings: Env = {
        DB: ormService.dbAdapter.db,
        ROOT_TOKEN: process.env.ROOT_TOKEN || "",
    };

    // Static file serving (frontend) - only for local development
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
        if (pathname.startsWith("/assets/")) {
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
        if (pathname.startsWith("/v1/") || pathname.includes(".json")) {
            return c.json({ error: "Not found" }, 404);
        }

        // Return index.html for SPA routing
        return c.html(indexHtml, 200);
    });

    // Static file serving for assets only (JS, CSS)
    app.use("/assets/*", serveStatic({ root: distPath }));

    serve({
        fetch: (request) => app.fetch(request, bindings),
        port,
    });

    console.log(`Server listening on http://localhost:${port}`);
    console.log(`ROOT_TOKEN: ${bindings.ROOT_TOKEN}`);
}

startServer().catch((err) => {
    console.error("Failed to start server:", err);
});