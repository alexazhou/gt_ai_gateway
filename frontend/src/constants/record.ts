// 失败原因码 → 中文标签（详情页报错 Tab 与活动日志时间线共用）
export const FAILED_CODE_LABELS: Record<string, string> = {
    client_disconnected: '客户端断开连接',
    upstream_disconnected: '上游断开连接',
    stream_incomplete: '流式响应不完整',
    upstream_parse_error: '上游返回错误',
    no_available_upstream: '无可用上游',
};
