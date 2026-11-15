import { describe, expect, it } from "vitest";
import sseEventUtil from "../../../../src/util/protocolUtil/sseEventUtil";

describe("sseEventUtil", () => {
    it("should split complete events and preserve remaining buffer", () => {
        const result = sseEventUtil.splitEvents(
            "event: one\ndata: 1\n\nevent: two\ndata: 2\n\ndata: partial",
        );

        expect(result.events).toEqual([
            { event: "one", data: "1" },
            { event: "two", data: "2" },
        ]);
        expect(result.remainingBuffer).toBe("data: partial");
    });

    it("should keep incomplete buffer when there are no complete events", () => {
        const result = sseEventUtil.splitEvents("event: one\ndata: partial");

        expect(result.events).toEqual([]);
        expect(result.remainingBuffer).toBe("event: one\ndata: partial");
    });

    it("should parse data, event and id fields", () => {
        const event = sseEventUtil.parseEvent("id: abc\nevent: message_delta\ndata: {\"type\":\"message_delta\"}");

        expect(event).toEqual({
            id: "abc",
            event: "message_delta",
            data: "{\"type\":\"message_delta\"}",
        });
    });

    it("should join multiple data lines", () => {
        const event = sseEventUtil.parseEvent("event: message\ndata: hello\ndata: world");

        expect(event?.data).toBe("hello\nworld");
    });

    it("should return null for events without data", () => {
        expect(sseEventUtil.parseEvent("event: ping")).toBeNull();
        expect(sseEventUtil.parseEvent("id: 7")).toBeNull();
    });

    it("纯空白 data 不再被 trim 成空事件（P1-03 语义变更）", () => {
        // 修复前 data 值走 `.trim()`，`data:   ` 会被吃成空串从而整条丢弃。
        // 规范只允许去掉 `data:` 后的**一个**前导空格，所以这里的数据是 "  "，是合法事件；
        // 丢掉它会让下游少一条事件（心跳式用法常见）。
        expect(sseEventUtil.parseEvent("data:   ")?.data).toBe("  ");
    });

    it("should split CRLF-framed events (\\r\\n line endings)", () => {
        const result = sseEventUtil.splitEvents("data: {\"a\":1}\r\n\r\ndata: {\"b\":2}\r\n\r\n");

        expect(result.events).toEqual([
            { data: "{\"a\":1}" },
            { data: "{\"b\":2}" },
        ]);
        expect(result.remainingBuffer).toBe("");
    });

    it("should parse comment-only lines as heartbeat events", () => {
        expect(sseEventUtil.parseEvent(": ping")).toEqual({ data: "", comment: ": ping" });
        expect(sseEventUtil.parseEvent(": ping\n: hb")).toEqual({ data: "", comment: ": ping\n: hb" });
    });

    it("should keep heartbeat comment events and split CRLF between real events", () => {
        const result = sseEventUtil.splitEvents(
            "data: {\"a\":1}\r\n\r\n: hb\r\n\r\ndata: {\"b\":2}\r\n\r\n",
        );

        expect(result.events).toEqual([
            { data: "{\"a\":1}" },
            { data: "", comment: ": hb" },
            { data: "{\"b\":2}" },
        ]);
        expect(result.remainingBuffer).toBe("");
    });

    it("should ignore comment lines inside data events", () => {
        const event = sseEventUtil.parseEvent("data: hello\n: hb");

        expect(event).toEqual({ data: "hello" });
    });
});
