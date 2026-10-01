import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dbMigrationService from "../../src/service/dbMigrationService";
import { createMigrationTestDb, type MigrationTestDb } from "../helpers/migrationTestDb";

/**
 * MIGRATION_MODE 在真实启动路径上的行为。
 *
 * 这里另起独立的 local.ts 进程：它要连一个自己的空库，而共享的测试服务是 globalSetup
 * 按默认模式、连着已被迁移过的库起好的，没法在它身上改环境变量或换库。
 */

const REPO_ROOT = join(__dirname, "../..");
const LOG_DIR = mkdtempSync(join(tmpdir(), "gt-migration-mode-logs-"));

/** 让后端进程连到这个临时库：mysql 换库名，sqlite 换文件路径，其余连接参数从环境继承 */
function spawnBackend(db: MigrationTestDb, extraEnv: Record<string, string> = {}) {
    const dbEnv = db.databaseName
        ? { DB_DRIVER: "mysql", DB_NAME: db.databaseName }
        : { DB_DRIVER: "sqlite", DB_PATH: db.filePath };

    const child = spawn("npx", ["tsx", "src/local.ts"], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            ...dbEnv,
            LOG_DIR,
            HOST: "127.0.0.1",
            PORT: "0",
            ROOT_TOKEN: "migration-mode-test-token",
            ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));

    return { child, readOutput: () => output };
}

async function waitForOutput(
    readOutput: () => string,
    needle: string,
    timeoutMs = 30000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (readOutput().includes(needle)) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for "${needle}". Output so far:\n${readOutput()}`);
}

// 实测启动到退出约 0.6s；15s 既够宽松、又不会让「本该退出却没退出」的回归等太久
async function waitForExit(child: ChildProcess, timeoutMs = 15000): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Timed out waiting for the process to exit"));
        }, timeoutMs);
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

describe("MIGRATION_MODE on the startup path", () => {
    const running: ChildProcess[] = [];
    let db: MigrationTestDb | null = null;

    afterEach(async () => {
        while (running.length > 0) {
            running.pop()?.kill("SIGKILL");
        }
        await db?.close();
        db = null;
    });

    afterAll(() => {
        rmSync(LOG_DIR, { recursive: true, force: true });
    });

    it("refuses to start on a database that is behind, listing the pending migrations", async () => {
        db = await createMigrationTestDb();
        const { child, readOutput } = spawnBackend(db, { MIGRATION_MODE: "check" });
        running.push(child);

        const code = await waitForExit(child);

        expect(code).not.toBe(0);
        expect(readOutput()).toContain("Database is behind");
        expect(readOutput()).toContain("migrate_0001");
        expect(readOutput()).not.toContain("Server listening");
    }, 60000);

    it("starts when the database is already migrated", async () => {
        db = await createMigrationTestDb();
        await dbMigrationService.migrate(db.adapter, "test");

        const { child, readOutput } = spawnBackend(db, { MIGRATION_MODE: "check" });
        running.push(child);

        await waitForOutput(readOutput, "Server listening");
        expect(readOutput()).toContain("MIGRATION_MODE=check: database is up to date");

        child.kill("SIGTERM");
    }, 60000);

    it("applies pending migrations on startup in execute mode (the Docker first-run path)", async () => {
        db = await createMigrationTestDb();
        const { child, readOutput } = spawnBackend(db);
        running.push(child);

        await waitForOutput(readOutput, "Server listening");

        // 空库已被就地迁移：entrypoint 不再单独迁移，这条路径由后端负责
        const { pending } = await dbMigrationService.check(db.adapter);
        expect(pending).toEqual([]);

        child.kill("SIGTERM");
    }, 60000);

    it("rejects an unknown MIGRATION_MODE instead of silently migrating", async () => {
        db = await createMigrationTestDb();
        const { child, readOutput } = spawnBackend(db, { MIGRATION_MODE: "checks" });
        running.push(child);

        const code = await waitForExit(child);

        expect(code).not.toBe(0);
        expect(readOutput()).toContain("Invalid MIGRATION_MODE");
        expect(readOutput()).not.toContain("Server listening");
    }, 60000);
});
