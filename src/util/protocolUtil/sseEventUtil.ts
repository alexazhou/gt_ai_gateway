import type { ProtocolStreamEvent } from "../protocol/commonTypes";

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

/**
 * 帧分隔符 = 连续两个换行（中间没有其它字符）。三种换行可混用，所以要把组合显式列全，
 * 长串在前优先匹配，避免被短分支抢先吃掉：
 *   CRLF+CRLF / CRLF+LF / CRLF+CR / LF+CRLF / CR+CRLF / LF+LF / LF+CR / CR+CR
 * 注意不能写成 `(\r\n|\n|\r){2}`：它会把单个 CRLF 拆成 `\r`+`\n` 误判成两行
 * （`\r\n` 本身是一个换行，不是两个）。
 */
function createFrameSeparator(): RegExp {
    return /\r\n\r\n|\r\n\n|\r\n\r|\n\r\n|\r\r\n|\n\n|\n\r|\r\r/g;
}

/**
 * 单帧内的换行归一化。
 *
 * P1-02：归一化**只对已完成帧**做，`remainingBuffer` 必须保留原始字节。
 * 原来是对整个 buffer 先 replace 再 split，跨 chunk 的「半截 `\r\n`」会被就地改写成
 * `\n`：如 chunk1 结尾是 `\r`、chunk2 开头是 `\n`，拼起来本该是一个 CRLF，
 * 却被拆成两个换行，凭空多切出一帧（甚至切出空 data 的假事件）。
 */
function normalizeFrameNewlines(frame: string): string {
    return frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitEvents(buffer: string): SplitSSEValidResult {
    const events: SSESplitBlock[] = [];
    let cursor = 0;
    // 每次新建（带 g 的 RegExp 带 lastIndex 状态，复用会在并发/重入时串味）
    const separator = createFrameSeparator();

    let match: RegExpExecArray | null;
    while ((match = separator.exec(buffer)) !== null) {
        const rawFrame = buffer.slice(cursor, match.index);
        cursor = match.index + match[0].length;
        const event = parseEvent(normalizeFrameNewlines(rawFrame));
        if (event) {
            events.push(event);
        }
    }

    // 未闭合的尾部原样留到下一个 chunk（含悬挂的 `\r`，见 P1-02）
    return { events, remainingBuffer: buffer.slice(cursor) };
}


/** 取 `data:` 行的值：按规范只去掉一个前导空格，其余原样保留 */
function dataLineValue(line: string): string {
    const value = line.slice(5);
    return value.startsWith(" ") ? value.slice(1) : value;
}


function parseEvent(event: string): SSESplitBlock | null {
    const lines = event.split("\n");
    // P1-03：原来对每个 data 值做 `.trim()`（去首尾所有空白），会把内容里的
    // 缩进、行尾空格、以及纯空白数据 `data:  ` 都吃掉；多行 data 之间按规范用 `\n` 拼接。
    const data = lines
        .filter((line) => line.startsWith("data:"))
        .map(dataLineValue)
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
