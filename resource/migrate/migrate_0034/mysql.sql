-- 清掉 migrate_0033 建的两张表（跨 isolate 限流 / 上游冷却），**不修改历史迁移**
--
-- 与 sqlite 版同一语义，见 sqlite.sql 头部说明。
-- migrate_0033 的文件与 _migrations 记录都保留；本迁移只 DROP 表，不动迁移历史。

DROP TABLE IF EXISTS `rate_limit_bucket`;
DROP TABLE IF EXISTS `upstream_health`;
