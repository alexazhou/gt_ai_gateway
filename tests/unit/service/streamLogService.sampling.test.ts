import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendStreamLog, finishStreamLog } from "../../../src/service/streamLogService";

/**
 * P2-12 流日志两处行为：
 * 1. 采样 —— 原来每个 chunk 都 console.log（上千 chunk 的流式响应 = 日志洪水 + 热路径两次 includes 扫描）；
 *    现在只保留「首个 + 每 200 个」一条，用来判断流有没有在动。
 * 2. finishStreamLog —— 原来只调 end() 不等待，进程/isolate 在 flush 前结束会丢尾部；现在等 finish/close。
 */

/** 最小 WriteStream 替身：只要 write/end/once 与事件能力 */
class FakeWriteStream extends EventEmitter {
    public written: string[] = [];
    public ended = false;

    write(chunk: string): boolean {
        this.written.push(chunk);
        return true;
    }

    end(): void {
        this.ended = true;
        // 模拟落盘完成后触发 finish
        setImmediate(() => this.emit("finish"));
    }
}

describe("appendStreamLog 采样（P2-12）", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
        logSpy?.mockRestore();
    });

    it("每个 chunk 都必须写进文件，只对 console.log 采样", () => {
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const stream = new FakeWriteStream() as any;

        appendStreamLog(stream, "chunk-1");
        appendStreamLog(stream, "chunk-2");
        appendStreamLog(stream, "chunk-3");

        expect(stream.written).toEqual(["chunk-1", "chunk-2", "chunk-3"]);
        expect(logSpy, "只有第 1 个 chunk 打日志").toHaveBeenCalledTimes(1);
    });

    it("第 1 个与第 200 个 chunk 打日志，199/201 不打（采样间隔 200）", () => {
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const stream = new FakeWriteStream() as any;

        for (let i = 1; i <= 201; i += 1) {
            appendStreamLog(stream, `c${i}`);
        }

        expect(stream.written).toHaveLength(201);
        // 第 1、200 两条
        expect(logSpy).toHaveBeenCalledTimes(2);
        const logged = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
        expect(logged).toContain("#1");
        expect(logged).toContain("#200");
        expect(logged).not.toContain("#199");
    });

    it("不同流各自独立计数（WeakMap 计数不串流）", () => {
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const a = new FakeWriteStream() as any;
        const b = new FakeWriteStream() as any;

        appendStreamLog(a, "a1");
        appendStreamLog(b, "b1");
        appendStreamLog(b, "b2");

        // 两条流的首个 chunk 都算 #1，各打一条
        expect(logSpy).toHaveBeenCalledTimes(2);
    });

    it("logStream 为 null（未开启流日志）时安全跳过", () => {
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(() => appendStreamLog(null, "chunk")).not.toThrow();
        expect(logSpy).not.toHaveBeenCalled();
    });
});

describe("finishStreamLog 等待落盘（P2-12）", () => {
    it("会 end() 并等到 finish 事件才 resolve", async () => {
        const stream = new FakeWriteStream() as any;
        expect(stream.ended).toBe(false);

        await finishStreamLog(stream);

        expect(stream.ended, "必须调用 end() 触发 flush").toBe(true);
    });

    it("close 事件也算落盘完成（不依赖 finish 是否触发）", async () => {
        const stream = new FakeWriteStream() as any;
        stream.end = () => {
            stream.ended = true;
            setImmediate(() => stream.emit("close"));
        };

        await expect(finishStreamLog(stream)).resolves.toBeUndefined();
        expect(stream.ended).toBe(true);
    });

    it("写日志失败不抛出（日志问题不能影响请求结果）", async () => {
        const stream = new FakeWriteStream() as any;
        stream.end = () => {
            stream.ended = true;
            setImmediate(() => stream.emit("error", new Error("ENOSPC")));
        };
        vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(finishStreamLog(stream)).resolves.toBeUndefined();
    });

    it("null 流直接 resolve（未开启流日志）", async () => {
        await expect(finishStreamLog(null)).resolves.toBeUndefined();
    });
});
