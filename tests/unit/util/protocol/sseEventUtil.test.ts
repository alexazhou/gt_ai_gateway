import { describe, expect, it } from "vitest";
import sseEvent from "../../../../src/util/protocol/sseEventUtil";

describe("sseEventUtil", () => {
    it("should split complete events and preserve remaining buffer", () => {
        const result = sseEvent.splitEvents(
            "event: one\ndata: 1\n\nevent: two\ndata: 2\n\ndata: partial",
        );

        expect(result.events).toEqual([
            "event: one\ndata: 1",
            "event: two\ndata: 2",
        ]);
        expect(result.remainingBuffer).toBe("data: partial");
    });

    it("should keep incomplete buffer when there are no complete events", () => {
        const result = sseEvent.splitEvents("event: one\ndata: partial");

        expect(result.events).toEqual([]);
        expect(result.remainingBuffer).toBe("event: one\ndata: partial");
    });

    it("should parse data, event and id fields", () => {
        const event = sseEvent.parseEvent("id: abc\nevent: message_delta\ndata: {\"type\":\"message_delta\"}");

        expect(event).toEqual({
            id: "abc",
            event: "message_delta",
            data: "{\"type\":\"message_delta\"}",
        });
    });

    it("should join multiple data lines", () => {
        const event = sseEvent.parseEvent("event: message\ndata: hello\ndata: world");

        expect(event?.data).toBe("hello\nworld");
    });

    it("should return null for events without data", () => {
        expect(sseEvent.parseEvent("event: ping")).toBeNull();
        expect(sseEvent.parseEvent("data:   ")).toBeNull();
    });
});
