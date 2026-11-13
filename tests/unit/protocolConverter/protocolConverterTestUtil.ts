import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";

/**
 * 解析第 index 条流式事件的 data 载荷，供各协议转换测试共用。
 */
function parseStreamEventData(events: ProtocolStreamEvent[], index: number = 0): any {
    return JSON.parse(events[index].data);
}

export default {
    parseStreamEventData,
};
