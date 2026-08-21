-- model：去掉生成列 enabled_name 与"仅启用唯一"索引，恢复 name 全局唯一
-- （name_index 在 migrate_0005 已 drop，此处重建）
ALTER TABLE model DROP INDEX model_name_index;
ALTER TABLE model DROP INDEX enabled_model_name_index;
ALTER TABLE model DROP COLUMN enabled_name;
CREATE UNIQUE INDEX name_index ON model(name);

-- client_config：去掉生成列 enabled_client 与"每 client 仅一个启用配置"唯一约束；
-- 改为每 client 内名字唯一。联合索引左前缀覆盖按 client 的查询，故删除原 client 索引。
ALTER TABLE client_config DROP INDEX client_config_client_index;
ALTER TABLE client_config DROP INDEX client_config_enabled_client_unique;
ALTER TABLE client_config DROP COLUMN enabled_client;
CREATE UNIQUE INDEX client_config_client_name_unique ON client_config (client, name);

-- vendor_model：本就存在 UNIQUE(vendor_id, model_id)，其最左前缀已覆盖所有按 vendor_id 的查询，
-- 单独建的 idx_vendor_model_vendor_id 冗余，删除。
ALTER TABLE vendor_model DROP INDEX idx_vendor_model_vendor_id;
