// 失败原因码 → 中文标签（详情页报错 Tab 与活动日志时间线共用）
export const FAILED_CODE_LABELS: Record<string, string> = {
    client_disconnected: '客户端断开连接',
    upstream_disconnected: '上游断开连接',
    stream_incomplete: '流式响应不完整',
    upstream_parse_error: '上游返回错误',
    upstream_timeout: '上游响应超时',
    no_available_upstream: '无可用上游',
    recovered_orphan: '孤儿记录回收',
    unknown_error: '未知错误',
};
