import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dbMigrationService from "../../src/service/dbMigrationService";
import { SQLiteDBAdapter } from "../../src/util/db/sqliteDBAdapter";

/**
 * MIGRATION_MODE 在真实启动路径上的行为。
 *
 * 这里另起独立的 local.ts 进程（各自一个临时库），因为共享的测试服务是 globalSetup
 * 按默认模式起好的，没法在它身上改环境变量。
 */

const REPO_ROOT = join(__dirname, "../..");

function makeTempDbPath(): string {
    return join(mkdtempSync(join(tmpdir(), "gt-migration-mode-")), "gateway.db");
}

function spawnBackend(dbPath: string, extraEnv: Record<string, string> = {}) {
    const child = spawn("npx", ["tsx", "src/local.ts"], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            DB_PATH: dbPath,
            LOG_DIR: join(dbPath, ".."),
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

    afterEach(() => {
        while (running.length > 0) {
            running.pop()?.kill("SIGKILL");
        }
    });

    it("refuses to start on a database that is behind, listing the pending migrations", async () => {
        const dbPath = makeTempDbPath();
        const { child, readOutput } = spawnBackend(dbPath, { MIGRATION_MODE: "check" });
        running.push(child);

        const code = await waitForExit(child);

        expect(code).not.toBe(0);
        expect(readOutput()).toContain("Database is behind");
        expect(readOutput()).toContain("migrate_0001");
        expect(readOutput()).not.toContain("Server listening");

        rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }, 60000);

    it("starts when the database is already migrated", async () => {
        const dbPath = makeTempDbPath();

        // 先按默认模式（execute）把这个临时库迁移到位
        const migrateAdapter = new SQLiteDBAdapter(dbPath);
        await dbMigrationService.migrate(migrateAdapter, "test");
        migrateAdapter.close();

        const { child, readOutput } = spawnBackend(dbPath, { MIGRATION_MODE: "check" });
        running.push(child);

        await waitForOutput(readOutput, "Server listening");
        expect(readOutput()).toContain("MIGRATION_MODE=check: database is up to date");

        child.kill("SIGTERM");
        rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }, 60000);

    it("applies pending migrations on startup in execute mode (the Docker first-run path)", async () => {
        const dbPath = makeTempDbPath();
        const { child, readOutput } = spawnBackend(dbPath);
        running.push(child);

        await waitForOutput(readOutput, "Server listening");

        // 空库已被就地迁移：entrypoint 不再单独迁移，这条路径由后端负责
        const verifyAdapter = new SQLiteDBAdapter(dbPath);
        const { pending } = await dbMigrationService.check(verifyAdapter);
        verifyAdapter.close();
        expect(pending).toEqual([]);

        child.kill("SIGTERM");
        rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }, 60000);

    it("rejects an unknown MIGRATION_MODE instead of silently migrating", async () => {
        const dbPath = makeTempDbPath();
        const { child, readOutput } = spawnBackend(dbPath, { MIGRATION_MODE: "checks" });
        running.push(child);

        const code = await waitForExit(child);

        expect(code).not.toBe(0);
        expect(readOutput()).toContain("Invalid MIGRATION_MODE");
        expect(readOutput()).not.toContain("Server listening");

        rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }, 60000);
});
