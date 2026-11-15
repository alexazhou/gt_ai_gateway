import { describe, expect, it } from "vitest";
import sseEventUtil from "../../../../src/util/protocolUtil/sseEventUtil";

/**
 * P1-02 / P1-03 红用例：SSE 拆帧在「chunk 边界」上的正确性。
 *
 * 线上上游的 chunk 边界由网络决定，**可以在任何位置切断**：既可能切在 `data:` 中间，
 * 也可能正好切在 CRLF 的 `\r` 和 `\n` 之间。拆分函数按「传入 buffer + 返回
 * remainingBuffer」增量工作，因此这里用 feed() 模拟上游分块投喂，断言的是
 * 「不管怎么切，最终解析结果必须一致」。
 *
 * 当前实现有两个缺口（本文件即为其验收门）：
 * 1. P1-02：`splitEvents` 对**整个 buffer**（含未完成的尾部）做 CRLF→LF 归一化，
 *    悬挂的 `\r` 被就地改写成 `\n` 放进 remainingBuffer，下个 chunk 开头真正的 `\n`
 *    又被拼上，于是凭空多出一个空行 → 假帧边界（一条事件被劈成两条 / 数据错位）。
 *    正确做法：先按原始 buffer 找**完整帧**，只对完整帧归一化，尾部原样保留。
 * 2. P1-03：`parseEvent` 对 data 值用 `.trim()`，把值首尾的空格都吃了；SSE 规范只
 *    允许去掉 `data:` 后面的**一个**前导空格，其余（含尾随空格、行首空格）必须原样保留。
 */

/** 模拟上游按 chunk 投喂：每喂一块就拆一次帧，未完成部分留到下一块 */
function feed(chunks: string[]): { events: any[]; tail: string } {
    let buffer = "";
    const events: any[] = [];
    for (const chunk of chunks) {
        buffer += chunk;
        const result = sseEventUtil.splitEvents(buffer);
        events.push(...result.events);
        buffer = result.remainingBuffer;
    }
    return { events, tail: buffer };
}

describe("splitEvents - 跨 chunk 边界拆帧（P1-02）", () => {
    it("CRLF 被切在 \\r 与 \\n 之间时，仍是一个事件一条数据", () => {
        // 上游原样是 "data: hel\r\ndata: lo\r\n\r\n"（两行 data），chunk 边界正好落在第一行 CRLF 中间
        const { events, tail } = feed(["data: hel\r", "\ndata: lo\r\n\r\n"]);

        expect(tail).toBe("");
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe("hel\nlo");
    });

    it("裸 \\r 作为换行符被切在帧中间时，不产生假帧边界", () => {
        const { events, tail } = feed(["data: line1\r", "data: line2", "\r\r"]);

        expect(tail).toBe("");
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe("line1\nline2");
    });

    it("多个事件被任意切碎后逐个投喂，事件数与顺序都不变", () => {
        // 等价于一次性喂 "data: a\n\ndata: b\n\ndata: c\n\n"
        const chunks = ["dat", "a: a\n\ndata:", " b\r", "\n\r\ndata: c\n\n"];
        const { events, tail } = feed(chunks);

        expect(tail).toBe("");
        expect(events.map((e) => e.data)).toEqual(["a", "b", "c"]);
    });

    it("一次性投喂与分块投喂结果一致（同一份流的两种到达方式）", () => {
        const payload = "data: alpha\n\ndata: beta\n\ndata: gamma\n\n";
        const atOnce = feed([payload]);
        const byteByByte = feed(payload.split(""));

        expect(byteByByte.events.map((e) => e.data)).toEqual(atOnce.events.map((e) => e.data));
        expect(byteByByte.tail).toBe("");
    });
});

describe("parseEvent - data 值精确保留（P1-03）", () => {
    it("只去掉 data: 后的一个前导空格，尾随空格必须保留", () => {
        const { events } = feed(["data:  two  spaces  \n\n"]);

        // data: 后面原样是 " two  spaces  "（一个前导空格被规范吃掉，其余全是值）
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe(" two  spaces  ");
    });

    it("多行 data 用 \\n 拼接，每行的前导/尾随空格都保留", () => {
        const { events } = feed(["data:  a \ndata:  b \n\n"]);

        expect(events[0].data).toBe(" a \n b ");
    });

    it("纯空格 data 是有效事件，不能被当成空事件丢弃", () => {
        // 规范：data 值为 " "（单个空格）时是合法心跳式事件，丢了下游会少一条
        const { events } = feed(["data:  \n\n"]);

        expect(events).toHaveLength(1);
        expect(events[0].data).toBe(" ");
    });
});

describe("parseEvent - 心跳注释与数据事件混排（P1-02 配套）", () => {
    it("注释行单独成块时作为心跳透传，且不影响相邻数据事件", () => {
        const { events } = feed([": ping\n\ndata: x\n\n: keep-alive\n\ndata: y\n\n"]);

        expect(events).toHaveLength(4);
        expect(events[0].comment).toBe(": ping");
        expect(events[1].data).toBe("x");
        expect(events[2].comment).toBe(": keep-alive");
        expect(events[3].data).toBe("y");
    });

    it("注释行与 data 同块时按心跳处理（不把注释当数据）", () => {
        const { events } = feed([": tick\n\ndata: payload\n\n"]);

        expect(events[0].comment).toBe(": tick");
        expect(events[1].data).toBe("payload");
    });
});
