-- 跨 isolate 共享状态（P0-2 限流 / P0-3 上游冷却）
-- 说明：本迁移在 MySQL 实例上同样建表以保证 schema 一致；
-- MySQL 下限流仍走进程内内存实现（单进程天然正确），这两张表只在 Worker(D1) 路径被读写。

CREATE TABLE IF NOT EXISTS `rate_limit_bucket`
(
    `bucket_key` VARCHAR(255) NOT NULL,
    `tokens`     DOUBLE       NOT NULL,
    `last_ms`    BIGINT       NOT NULL,
    PRIMARY KEY (`bucket_key`),
    KEY `idx_rate_limit_bucket_last_ms` (`last_ms`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `upstream_health`
(
    `health_key` VARCHAR(255) NOT NULL,
    `failed_at`  BIGINT       NOT NULL,
    PRIMARY KEY (`health_key`),
    KEY `idx_upstream_health_failed_at` (`failed_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
