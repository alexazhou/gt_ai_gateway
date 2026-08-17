import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, unlinkSync, readFileSync, mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import initLogger, { Logger, resetLogger, getLogger } from "../../../src/util/loggerUtil";

describe("Logger", () => {
    const testLogDir = join(process.cwd(), "test-log");
    const testLogFileName = `app-${new Date().toISOString().split("T")[0]}.log`;

    afterAll(() => {
        // 清理测试日志目录
        if (existsSync(testLogDir)) {
            rmSync(testLogDir, { recursive: true, force: true });
        }
    });

    afterEach(() => {
        // 每个测试后重置 logger 实例
        resetLogger();
    });

    it("应该在启用时创建日志目录和文件", () => {
        const logger = new Logger(testLogDir, true);

        expect(logger).toBeInstanceOf(Logger);
        expect(existsSync(testLogDir)).toBe(true);
    });

    it("应该正确记录 info 级别日志并写入文件", () => {
        const logger = new Logger(testLogDir, true);
        const testMessage = "Test info message";

        logger.info(testMessage);

        const testLogPath = join(testLogDir, testLogFileName);
        expect(existsSync(testLogPath)).toBe(true);

        const logContent = readFileSync(testLogPath, "utf-8");
        expect(logContent).toContain(testMessage);
        expect(logContent).toContain("[INFO]");
    });

    it("应该正确记录 warn 级别日志并写入文件", () => {
        const logger = new Logger(testLogDir, true);
        const testMessage = "Test warn message";

        logger.warn(testMessage);

        const testLogPath = join(testLogDir, testLogFileName);
        const logContent = readFileSync(testLogPath, "utf-8");

        expect(logContent).toContain(testMessage);
        expect(logContent).toContain("[WARN]");
    });

    it("应该正确记录 error 级别日志并写入文件", () => {
        const logger = new Logger(testLogDir, true);
        const testMessage = "Test error message";

        logger.error(testMessage);

        const testLogPath = join(testLogDir, testLogFileName);
        const logContent = readFileSync(testLogPath, "utf-8");

        expect(logContent).toContain(testMessage);
        expect(logContent).toContain("[ERROR]");
    });

    it("应该正确记录 debug 级别日志并写入文件", () => {
        const logger = new Logger(testLogDir, true);
        const testMessage = "Test debug message";

        logger.debug(testMessage);

        const testLogPath = join(testLogDir, testLogFileName);
        const logContent = readFileSync(testLogPath, "utf-8");

        expect(logContent).toContain(testMessage);
        expect(logContent).toContain("[DEBUG]");
    });

    it("日志应包含毫秒时间戳", () => {
        const logger = new Logger(testLogDir, true);
        const testMessage = "Test timestamp";

        logger.info(testMessage);

        const testLogPath = join(testLogDir, testLogFileName);
        const logContent = readFileSync(testLogPath, "utf-8");

        // 验证时间戳格式：YYYY-MM-DD HH:MM:SS.mmm
        const timestampPattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/;
        expect(logContent).toMatch(timestampPattern);
    });

    it("日志应包含日期作为文件名的一部分", () => {
        const logger = new Logger(testLogDir, true);

        logger.info("Test filename");

        const files = require("fs").readdirSync(testLogDir);
        const today = new Date().toISOString().split("T")[0];
        const expectedFileName = `app-${today}.log`;

        expect(files).toContain(expectedFileName);
    });

    it("应该正确处理带参数的日志", () => {
        const logger = new Logger(testLogDir, true);
        const testMessage = "Test with params";
        const testParam1 = "param1";
        const testParam2 = 123;

        logger.info(testMessage, testParam1, testParam2);

        const testLogPath = join(testLogDir, testLogFileName);
        const logContent = readFileSync(testLogPath, "utf-8");

        expect(logContent).toContain(testMessage);
        expect(logContent).toContain("param1");
        expect(logContent).toContain("123");
    });

    it("应该正确处理对象参数", () => {
        const logger = new Logger(testLogDir, true);
        const testMessage = "Test with object";
        const testObj = { key: "value", num: 42 };

        logger.info(testMessage, testObj);

        const testLogPath = join(testLogDir, testLogFileName);
        const logContent = readFileSync(testLogPath, "utf-8");

        expect(logContent).toContain(testMessage);
        expect(logContent).toContain("key");
        expect(logContent).toContain("value");
        expect(logContent).toContain("42");
    });

    it("应该在禁用时不写入文件", () => {
        // 使用一个新的日志目录，避免之前的测试创建的文件干扰
        const disabledTestDir = join(testLogDir, "disabled-test");
        const logger = new Logger(disabledTestDir, false);
        const testMessage = "Test disabled";

        logger.info(testMessage);

        const disabledLogFileName = `app-${new Date().toISOString().split("T")[0]}.log`;
        const testLogPath = join(disabledTestDir, disabledLogFileName);
        expect(existsSync(testLogPath)).toBe(false);
    });

    it("应该追加而不是覆盖日志", () => {
        const logger = new Logger(testLogDir, true);
        const message1 = "First message";
        const message2 = "Second message";

        logger.info(message1);
        logger.info(message2);

        const testLogPath = join(testLogDir, testLogFileName);
        const logContent = readFileSync(testLogPath, "utf-8");

        expect(logContent).toContain(message1);
        expect(logContent).toContain(message2);

        // 验证 message1 出现在 message2 之前
        const firstIndex = logContent.indexOf(message1);
        const secondIndex = logContent.indexOf(message2);
        expect(firstIndex).toBeLessThan(secondIndex);
    });

    it("initLogger 应该创建单例实例", () => {
        const logger1 = initLogger(testLogDir, true);
        const logger2 = initLogger(testLogDir, true);

        expect(logger1).toBe(logger2);
    });

    it("getLogger 应该返回当前 logger 实例", () => {
        initLogger(testLogDir, true);

        const logger = getLogger();

        expect(logger).toBeInstanceOf(Logger);
    });

    it("resetLogger 应该重置 logger 实例", () => {
        const logger1 = initLogger(testLogDir, true);
        resetLogger();
        const logger2 = initLogger(testLogDir, true);

        expect(logger1).not.toBe(logger2);
    });

    describe("日志轮转", () => {
        const rotateLogDir = join(process.cwd(), "test-log-rotate");
        const today = new Date().toISOString().split("T")[0];
        const activeFileName = `app-${today}.log`;

        afterEach(() => {
            if (existsSync(rotateLogDir)) {
                rmSync(rotateLogDir, { recursive: true, force: true });
            }
            resetLogger();
        });

        it("超过 maxFileSize 时应轮转为 app-DATE.N.log 并新建空活动文件", () => {
            const logger = new Logger(rotateLogDir, true, {
                maxFileSize: 200,
                maxFileCount: 5,
            });

            const activePath = join(rotateLogDir, activeFileName);
            // 写入足够多内容触发轮转（每条 > 50 字节，200 字节上限下几条即触发）
            for (let i = 0; i < 10; i++) {
                logger.info(`rotation test line ${i} with some padding content`);
            }

            const files = readdirSync(rotateLogDir);
            // 应存在至少一个轮转文件 app-DATE.1.log
            expect(files.some((f) => new RegExp(`^app-${today}\\.1\\.log$`).test(f))).toBe(true);
            // 活动文件仍存在
            expect(files).toContain(activeFileName);
            // 活动文件大小应小于上限
            expect(statSync(activePath).size).toBeLessThan(200);
        });

        it("应只保留 maxFileCount 个文件，删除最旧的", () => {
            // 预置几个旧文件，确保轮转后总数不超过 maxFileCount
            mkdirSync(rotateLogDir, { recursive: true });
            const oldFiles = [
                `app-2020-01-01.log`,
                `app-2020-01-02.log`,
                `app-2020-01-03.log`,
                `app-2020-01-04.log`,
            ];
            for (const name of oldFiles) {
                writeFileSync(join(rotateLogDir, name), "old\n");
            }

            const logger = new Logger(rotateLogDir, true, {
                maxFileSize: 100,
                maxFileCount: 5,
            });

            // 触发一次轮转，会清理超出 5 个的最旧文件
            for (let i = 0; i < 10; i++) {
                logger.info(`prune test line ${i} padding content here`);
            }

            const files = readdirSync(rotateLogDir).filter((f) => /^app-.*\.log$/.test(f));
            expect(files.length).toBeLessThanOrEqual(5);
        });

        it("未达上限时不应轮转", () => {
            const logger = new Logger(rotateLogDir, true, {
                maxFileSize: 1024 * 1024,
                maxFileCount: 5,
            });

            logger.info("small log line");

            const files = readdirSync(rotateLogDir);
            expect(files).toEqual([activeFileName]);
        });
    });
});