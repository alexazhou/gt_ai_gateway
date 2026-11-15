import type { BaseConverter, StopReasonSource } from "../protocolConverter/BaseConverter";

/**
 * `request_activity` 的 result 阶段里 `stop_reason_source` 的计算与落库形状（纯函数，无副作用）。
 *
 * 背景：上游漏发 `finish_reason` 时，转换器会用兜底值（如 `end_turn`）补齐收尾，记录里
 * 与「上游真给了 `end_turn`」完全一样，运维无法区分。转换器在收尾点记下来源
 * （见 `BaseConverter.getStopReasonSource()`），handler 收尾时据此落一个标记。
 *
 * 口径（三条，写死在这里以免各处解释不同）：
 * - 有转换器且转换器已确定 ⇒ 用转换器的判定（`upstream` / `synthesized`）；
 * - **无转换器**（同协议直通）⇒ `upstream`：我方没有任何 stop_reason 合成点，值就是上游原值；
 * - 有转换器但没走到收尾点（返回 null）⇒ **不写这个键**（宁可缺，不写错的）。
 *
 * 只影响记录，不影响任何客户端可见输出（body / header / 状态码都不碰）。
 */

/** 记录里 stop_reason 的来源；null = 本次无法确定（不写进活动） */
export function resolveStopReasonSource(converter: BaseConverter | null): StopReasonSource | null {
    if (!converter) return "upstream";
    return converter.getStopReasonSource();
}

/** result 活动的 details 片段：能确定时带 `stop_reason_source`，否则返回空对象 */
export function stopReasonSourceDetail(source: StopReasonSource | null): { stop_reason_source?: StopReasonSource } {
    return source ? { stop_reason_source: source } : {};
}

/** 便捷组合：从 converter 直接拿 details 片段（成功收尾时用） */
export function stopReasonDetailsForConverter(
    converter: BaseConverter | null,
): { stop_reason_source?: StopReasonSource } {
    return stopReasonSourceDetail(resolveStopReasonSource(converter));
}

export default {
    resolveStopReasonSource,
    stopReasonSourceDetail,
    stopReasonDetailsForConverter,
};
