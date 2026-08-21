-- model：名字恢复为全局唯一（无论是否启用）。去掉"仅启用时唯一"的条件索引
DROP INDEX IF EXISTS enabled_model_name_index;
CREATE UNIQUE INDEX name_index ON model(name);

-- client_config：去掉"每 client 仅一个启用配置"条件索引；改为每 client 内名字唯一。
-- (client, name) 联合索引左前缀仍覆盖按 client 的查询（listByClient / disableAllByClient），
-- 因此原 client_config_client_index 一并删除。
DROP INDEX IF EXISTS client_config_enabled_client_unique;
DROP INDEX IF EXISTS client_config_client_index;
CREATE UNIQUE INDEX client_config_client_name_unique ON client_config(client, name);

-- vendor_model：本就存在 UNIQUE(vendor_id, model_id)，其最左前缀已覆盖所有按 vendor_id 的查询，
-- 单独建的 idx_vendor_model_vendor_id 冗余，删除。
DROP INDEX IF EXISTS idx_vendor_model_vendor_id;
