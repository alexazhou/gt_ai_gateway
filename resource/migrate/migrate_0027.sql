-- 请求活动日志：一个 record 对应一行，activities 为 JSON 数组，顺序存储该请求的全部活动消息（路由、上游尝试、失败切换、插件、协议转换、结果）
-- id 自增主键；record_id 与 record 只是逻辑关联（无外键），建唯一索引，保证一个 record 一行
CREATE TABLE request_activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id  INTEGER NOT NULL UNIQUE,    -- 与 record 逻辑关联（不用外键），唯一
    activities TEXT NOT NULL,              -- JSON 数组：该请求的全部活动消息
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
