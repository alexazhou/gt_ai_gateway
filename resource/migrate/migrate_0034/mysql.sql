-- 收敛「装过 v1.9.1-beta1 的库」：撤销 migrate_0033（跨 isolate 限流 / 上游冷却两张表）
--
-- 与 sqlite 版同一语义，见 sqlite.sql 头部说明。MySQL 下限流一直走进程内实现，
-- 这两张表在 MySQL 上从未被读写，删除对业务无影响。

DROP TABLE IF EXISTS `rate_limit_bucket`;
DROP TABLE IF EXISTS `upstream_health`;

DELETE FROM `_migrations` WHERE `name` = 'migrate_0033';
