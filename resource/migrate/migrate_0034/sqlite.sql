-- 收敛「装过 v1.9.1-beta1 的库」：撤销 migrate_0033（跨 isolate 限流 / 上游冷却两张表）
--
-- 背景：#287 已把限流与冷却改回内存实现，migrate_0033 目录整目录删除。但装过
-- v1.9.1-beta1 的库（git tag --contains 5b29b86 仅该 tag）里仍留着这两张空表与
-- 一条 migrate_0033 记录，而迁移判据 pending = available − applied 只覆盖
-- 「目录有、库里没有」，反向差异永远不进判据 ⇒ migrate() 会一直报 up to date，
-- 表与记录永久残留。本迁移做显式收敛，让所有库自动对齐代码目录。
--
-- 顺序：runner 在迁移 SQL 执行完之后才 INSERT INTO _migrations 记 0034，
-- 所以这里删 0033 的记录与随后写 0034 的记录不冲突。
-- 新库上执行同样安全：DROP IF EXISTS 无表可删，DELETE 无行可删。

DROP TABLE IF EXISTS rate_limit_bucket;
DROP TABLE IF EXISTS upstream_health;

DELETE FROM _migrations WHERE name = 'migrate_0033';
