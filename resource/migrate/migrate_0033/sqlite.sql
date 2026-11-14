-- 跨 isolate 共享状态（P0-2 限流 / P0-3 上游冷却）
-- Worker 每个 isolate 各有一份内存，令牌桶与冷却标记必须落库才能跨实例生效。

-- 限流令牌桶：bucket_key = rule:<id>:rpm
-- tokens 为浮点（按毫秒补液，允许小数），last_ms 为最后一次补液/扣减时刻
CREATE TABLE IF NOT EXISTS rate_limit_bucket
(
    bucket_key TEXT    NOT NULL PRIMARY KEY,
    tokens     REAL    NOT NULL,
    last_ms    INTEGER NOT NULL
);

-- 惰性清扫按 last_ms 扫描
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket_last_ms ON rate_limit_bucket (last_ms);

-- 上游冷却标记：health_key = upstream-health:<vendorId>:<vendorModelName>:<apiFormat>
CREATE TABLE IF NOT EXISTS upstream_health
(
    health_key TEXT    NOT NULL PRIMARY KEY,
    failed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upstream_health_failed_at ON upstream_health (failed_at);
