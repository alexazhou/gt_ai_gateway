import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { finishStreamLog } from "../../../src/service/streamLogService";

/**
 * P2-12：`finishStreamLog` —— 原来只调 end() 不等待，进程/isolate 在 flush 前结束会丢尾部；
 * 现在等 finish/close。
 *
 * 本文件原先还挂着 `appendStreamLog` 的 4 例采样断言，那个函数的生产调用点已被
 * `recordUpstreamChunk` 取代（#373），采样规则改由 `streamLogService.level.test.ts` 覆盖。
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
