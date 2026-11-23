-- 清掉 migrate_0033 建的两张表（跨 isolate 限流 / 上游冷却），**不修改历史迁移**
--
-- 背景：#287 已把限流与上游冷却改回内存实现，这两张表不再被任何代码读写。
-- 但 migrate_0033 是已发布过的历史迁移（随 v1.9.1-beta1），**文件与 _migrations 记录都保留**，
-- 只在它之后追加本迁移做表清理 —— 迁移历史只增不改。
--
-- 顺序契约：本迁移只做 DROP，不触碰 _migrations（runner 会在本 SQL 执行完之后
-- 自己 INSERT 一条 migrate_0034）。历史记录（含 migrate_0033）一律保留。
--
-- 全新库上同样安全：0033 先建表，本迁移随后删表，终态一致；DROP IF EXISTS 无表可删也不报错。

DROP TABLE IF EXISTS rate_limit_bucket;
DROP TABLE IF EXISTS upstream_health;
