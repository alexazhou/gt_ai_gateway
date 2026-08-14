import type { ProtocolStreamEvent } from "../protocolConverter/protocolTypes";

interface ParsedSSEEvent extends ProtocolStreamEvent {}

interface SplitSSEEventsResult {
    events: string[];
    remainingBuffer: string;
}

function splitEvents(buffer: string): SplitSSEEventsResult {
    const events = buffer.split("\n\n");
    const remainingBuffer = events.pop() ?? "";
    return { events, remainingBuffer };
}


function parseEvent(event: string): ParsedSSEEvent | null {
    const lines = event.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    const data = dataLines.map((line) => line.slice(5).trim()).join("\n");
    if (!data) {
        return null;
    }

    const eventType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || undefined;
    const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim() || undefined;
    return { data, event: eventType, id };
}


export default {
    splitEvents,
    parseEvent,
};
