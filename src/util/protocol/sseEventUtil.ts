import type { ProtocolStreamEvent } from "../protocolConverter/protocolTypes";

/** 完整解析出的 SSE 块：带 data 的真实事件，或仅含注释行的心跳 */
interface SSESplitBlock extends ProtocolStreamEvent {
    /** 事件块内原样的注释行（如 `: ping`）；纯注释块（心跳）以此字段透传 */
    comment?: string;
}

/** 拆帧结果：仅保留对下游有效的内容（有效事件 + 心跳块） */
interface SplitSSEValidResult {
    events: SSESplitBlock[];   // 完整块（含心跳）
    remainingBuffer: string;
}

function splitEvents(buffer: string): SplitSSEValidResult {
    // SSE 规范允许 \n / \r\n / \r 三种换行，先统一成 \n 再按空行切帧
    const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rawEvents = normalized.split("\n\n");
    const remainingBuffer = rawEvents.pop() ?? "";
    const events = rawEvents
        .map(parseEvent)
        .filter((event): event is SSESplitBlock => event !== null);
    return { events, remainingBuffer };
}


function parseEvent(event: string): SSESplitBlock | null {
    const lines = event.split("\n");
    const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

    // 无 data：
    // - 仅含注释行（以 : 开头）→ 心跳事件，调用方原样透传做下游 keep-alive
    // - 完全空白 → 不是事件，返回 null 剔除
    if (!data) {
        const comment = lines.filter((line) => line.startsWith(":")).join("\n");
        return comment ? { data: "", comment } : null;
    }

    const eventType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || undefined;
    const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim() || undefined;
    return { data, event: eventType, id };
}


export default {
    splitEvents,
    parseEvent,
};
