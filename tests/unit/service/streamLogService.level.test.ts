import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import initLogger, { resetLogger } from "../../../src/util/loggerUtil";
import { recordUpstreamChunk } from "../../../src/service/streamLogService";

const logDir = join(process.cwd(), "test-log-stream-level");

/** 最小 WriteStream 替身：只要 write，用来验证「流日志不受级别影响」 */
class FakeWriteStream extends EventEmitter {
    public written: string[] = [];

    write(chunk: string): boolean {
        this.written.push(chunk);
        return true;
    }
}

describe("recordUpstreamChunk 日志分级", () => {
    let debugSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        rmSync(logDir, { recursive: true, force: true });
        mkdirSync(logDir, { recursive: true });
        debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        debugSpy.mockRestore();
        logSpy.mockRestore();
        resetLogger();
        rmSync(logDir, { recursive: true, force: true });
    });

    const printed = (spy: ReturnType<typeof vi.spyOn>) =>
        spy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");

    it("debug 级别：每个 chunk 都打完整原文，且带上 record id 与序号", () => {
        initLogger(logDir, true, { level: "debug" });

        const chunks = ['event: message\ndata: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"];
        chunks.forEach((chunk, i) => recordUpstreamChunk(4321, i + 1, chunk, null));

        expect(debugSpy, "debug 级别逐 chunk 一条，不走采样").toHaveBeenCalledTimes(3);
        expect(logSpy, "debug 级别不应再走采样摘要").not.toHaveBeenCalled();

        const text = printed(debugSpy);
        expect(text).toContain("record=4321");
        expect(text).toContain("#1");
        expect(text).toContain("#3");
        chunks.forEach((chunk) => expect(text, "必须含完整原文").toContain(chunk));
    });

    it("info 级别（默认）：只采样第 1 与每 200 条，且不打正文", () => {
        initLogger(logDir, true, { level: "info" });

        for (let i = 1; i <= 201; i += 1) {
            recordUpstreamChunk(7, i, `SECRET-BODY-${i}`, null);
        }

        expect(debugSpy).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledTimes(2);

        const text = printed(logSpy);
        expect(text).toContain("record=7");
        expect(text).toContain("#1");
        expect(text).toContain("#200");
        expect(text).not.toContain("#199");
        expect(text, "info 级别不得把正文写进控制台").not.toContain("SECRET-BODY");
    });

    it("warn/error 级别：控制台一条不打（采样摘要属于 info）", () => {
        initLogger(logDir, true, { level: "error" });

        for (let i = 1; i <= 200; i += 1) {
            recordUpstreamChunk(8, i, `chunk-${i}`, null);
        }

        expect(debugSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it("logStream 非空时无论级别都原样落盘（流日志与级别过滤互不影响）", () => {
        initLogger(logDir, true, { level: "error" });
        const stream = new FakeWriteStream() as unknown as Parameters<typeof recordUpstreamChunk>[3];

        recordUpstreamChunk(9, 1, "a", stream);
        recordUpstreamChunk(9, 2, "b", stream);
        recordUpstreamChunk(9, 200, "c", stream);

        expect((stream as unknown as FakeWriteStream).written).toEqual(["a", "b", "c"]);
    });

    it("logger 未初始化时按 info 采样，仍然输出（不因缺 logger 静默）", () => {
        resetLogger();
        recordUpstreamChunk(11, 1, "first-chunk", null);
        recordUpstreamChunk(11, 2, "second-chunk", null);

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(printed(logSpy)).toContain("#1");
        expect(debugSpy).not.toHaveBeenCalled();
    });
});
