import { describe, expect, it } from "vitest";
import sseEventUtil from "../../../../src/util/protocol/sseEventUtil";

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
        expect(sseEventUtil.parseEvent("data:   ")).toBeNull();
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
