ALTER TABLE model ADD COLUMN enable TINYINT(1) DEFAULT 1 NOT NULL;
-- MySQL 不支持 DROP INDEX IF EXISTS
ALTER TABLE model DROP INDEX name_index;
-- MySQL 不支持 SQLite 的部分唯一索引（CREATE UNIQUE INDEX ... WHERE enable = 1）。
-- 用生成列 enabled_name 模拟「每个 enabled 模型名字唯一」：enable=1 时取 name，否则为 NULL
-- （NULL 不参与 MySQL 唯一性，故允许同名 disabled 模型共存）。与 client_config 的 enabled_client 做法一致。
ALTER TABLE model ADD COLUMN enabled_name VARCHAR(255) GENERATED ALWAYS AS (IF(enable = 1, name, NULL)) STORED;
CREATE UNIQUE INDEX enabled_model_name_index ON model (enabled_name);
-- name 列本身不再唯一，但按名字查询仍需普通索引
CREATE INDEX model_name_index ON model (name);
