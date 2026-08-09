-- 请求活动日志：一个 record 对应一行，activities 为 JSON 数组，顺序存储该请求的全部活动消息（路由、上游尝试、失败切换、插件、协议转换、结果）
CREATE TABLE request_activity (
    record_id  INTEGER PRIMARY KEY,        -- 与 record 逻辑关联（不用外键）
    activities TEXT NOT NULL,              -- JSON 数组：该请求的全部活动消息
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
