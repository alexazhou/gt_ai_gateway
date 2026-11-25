import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import {
    DEFAULT_LOG_LEVEL,
    Logger,
    LOG_LEVEL_PRIORITY,
    parseLogLevel,
    resetLogger,
} from "../../../src/util/loggerUtil";

const baseDir = join(process.cwd(), "test-log-level");
const today = new Date().toISOString().split("T")[0];
const activeFile = (dir: string) => join(dir, `app-${today}.log`);
const originalLogLevel = process.env.LOG_LEVEL;

/** 只统计 app-*.log，按名字排序便于断言「保留的是新的」 */
function appLogFiles(dir: string): string[] {
    return readdirSync(dir)
        .filter((name) => /^app-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name))
        .sort();
}

function freshDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
}

/** 写一个历史日志文件并把 mtime 指到指定日期（prune 按 mtime 保留最新的） */
function writeOldLog(dir: string, date: string, base: Date): void {
    const path = join(dir, `app-${date}.log`);
    writeFileSync(path, "old\n");
    const secs = Math.floor(base.getTime() / 1000);
    utimesSync(path, secs, secs);
}

afterEach(() => {
    resetLogger();
    if (originalLogLevel === undefined) {
        delete process.env.LOG_LEVEL;
    } else {
        process.env.LOG_LEVEL = originalLogLevel;
    }
});

describe("parseLogLevel", () => {
    it("大小写与首尾空白都不敏感", () => {
        expect(parseLogLevel("DEBUG")).toBe("debug");
        expect(parseLogLevel(" WarN ")).toBe("warn");
        expect(parseLogLevel("error")).toBe("error");
        expect(parseLogLevel("info")).toBe("info");
    });

    it("空值与非法值回退 info（存量 config 没有该字段时不能静默丢日志）", () => {
        for (const raw of [undefined, null, "", "   ", "verbose", "1"]) {
            expect(parseLogLevel(raw as string | null | undefined)).toBe("info");
        }
        expect(DEFAULT_LOG_LEVEL).toBe("info");
    });

    it("优先级单调递增（改反了等于把 error 当最吵的级别）", () => {
        expect(LOG_LEVEL_PRIORITY.debug).toBeLessThan(LOG_LEVEL_PRIORITY.info);
        expect(LOG_LEVEL_PRIORITY.info).toBeLessThan(LOG_LEVEL_PRIORITY.warn);
        expect(LOG_LEVEL_PRIORITY.warn).toBeLessThan(LOG_LEVEL_PRIORITY.error);
    });
});

describe("级别过滤", () => {
    const dir = join(baseDir, "filter");

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("默认 info：debug 既不落盘也不打控制台，info 及以上照常", () => {
        delete process.env.LOG_LEVEL;
        freshDir(dir);
        const logger = new Logger(dir, true);

        expect(logger.getLevel()).toBe("info");
        expect(logger.isDebugEnabled()).toBe(false);
        expect(logger.shouldLog("debug")).toBe(false);
        expect(logger.shouldLog("info")).toBe(true);
        expect(logger.shouldLog("warn")).toBe(true);
        expect(logger.shouldLog("error")).toBe(true);

        logger.debug("filtered-debug-line");
        logger.info("kept-info-line");

        const content = readFileSync(activeFile(dir), "utf8");
        expect(content).toContain("kept-info-line");
        expect(content).not.toContain("filtered-debug-line");
        expect(content).not.toContain("[DEBUG]");
    });

    it("LOG_LEVEL=debug 驱动生效级别：四个级别全部落盘", () => {
        process.env.LOG_LEVEL = "DEBUG";
        freshDir(dir);
        const logger = new Logger(dir, true);

        expect(logger.getLevel()).toBe("debug");
        expect(logger.isDebugEnabled()).toBe(true);
        for (const level of ["debug", "info", "warn", "error"] as const) {
            expect(logger.shouldLog(level)).toBe(true);
        }

        logger.debug("debug-line");
        logger.info("info-line");
        logger.warn("warn-line");
        logger.error("error-line");

        const content = readFileSync(activeFile(dir), "utf8");
        expect(content).toContain("[DEBUG] debug-line");
        expect(content).toContain("[INFO] info-line");
        expect(content).toContain("[WARN] warn-line");
        expect(content).toContain("[ERROR] error-line");
    });

    it("error 级别只留 error，warn/info/debug 全部丢弃", () => {
        freshDir(dir);
        const logger = new Logger(dir, true, { level: "error" });

        expect(logger.shouldLog("debug")).toBe(false);
        expect(logger.shouldLog("info")).toBe(false);
        expect(logger.shouldLog("warn")).toBe(false);
        expect(logger.isDebugEnabled()).toBe(false);

        logger.warn("dropped-warn");
        logger.error("kept-error");

        const content = readFileSync(activeFile(dir), "utf8");
        expect(content).toContain("[ERROR] kept-error");
        expect(content).not.toContain("dropped-warn");
    });

    it("显式 level 选项优先于 LOG_LEVEL 环境变量", () => {
        freshDir(dir);
        process.env.LOG_LEVEL = "debug";
        expect(new Logger(dir, true, { level: "error" }).getLevel()).toBe("error");

        resetLogger();
        process.env.LOG_LEVEL = "error";
        const logger = new Logger(dir, true, { level: "debug" });
        expect(logger.getLevel()).toBe("debug");
        expect(logger.isDebugEnabled()).toBe(true);
    });

    it("setLevel 运行期可切换", () => {
        freshDir(dir);
        const logger = new Logger(dir, true);
        expect(logger.shouldLog("debug")).toBe(false);

        logger.setLevel("debug");
        expect(logger.shouldLog("debug")).toBe(true);
        expect(logger.isDebugEnabled()).toBe(true);

        logger.setLevel("error");
        expect(logger.shouldLog("info")).toBe(false);
    });
});

describe("pruneOldFiles 补齐触发点", () => {
    const dir = join(baseDir, "prune");

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("构造时就清到 maxFileCount（原来只在 100MB 轮转时清，按天滚动会无限累积）", () => {
        freshDir(dir);
        const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05", "2020-01-06", "2020-01-07"];
        dates.forEach((date, i) => writeOldLog(dir, date, new Date(2020, 0, 1 + i)));
        expect(appLogFiles(dir)).toHaveLength(7);

        const logger = new Logger(dir, true, { maxFileCount: 5 });
        expect(logger).toBeInstanceOf(Logger);

        const left = appLogFiles(dir);
        expect(left).toHaveLength(5);
        expect(left).not.toContain("app-2020-01-01.log");
        expect(left).not.toContain("app-2020-01-02.log");
        expect(left).toContain("app-2020-01-07.log");
    });

    it("跨天滚动后也清一次（新一天第一条日志落盘时触发，活动文件永不删）", () => {
        freshDir(dir);
        const logger = new Logger(dir, true, { maxFileCount: 5 });
        logger.info("day one");

        // 构造之后才冒出来的历史文件（构造期清理看不到它们）
        for (let i = 1; i <= 6; i += 1) {
            writeOldLog(dir, `2020-03-0${i}`, new Date(2020, 2, i));
        }
        expect(appLogFiles(dir)).toHaveLength(7);

        // 把内部日期指到过去，下一次写日志即走 rollOverIfNewDay
        (logger as unknown as { currentDateStr: string }).currentDateStr = "2020-01-01";
        logger.info("day two");

        const left = appLogFiles(dir);
        expect(left).toHaveLength(5);
        expect(left).toContain(`app-${today}.log`);
        expect(left).not.toContain("app-2020-03-01.log");
        expect(left).not.toContain("app-2020-03-02.log");
    });
});
