ALTER TABLE model ADD COLUMN enable TINYINT(1) DEFAULT 1 NOT NULL;
DROP INDEX IF EXISTS name_index ON model;
-- MySQL 不支持 SQLite 的部分索引（CREATE INDEX ... WHERE）。
-- 这里退化为普通唯一索引（enable 语义由应用层保证）。
CREATE UNIQUE INDEX enabled_model_name_index ON model (name);
