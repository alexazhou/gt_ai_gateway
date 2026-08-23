-- tenant：多租户隔离的根实体，name 全局唯一（租户标识）
CREATE TABLE tenant (
    id          INTEGER   NOT NULL CONSTRAINT tenant_pk PRIMARY KEY AUTOINCREMENT,
    name        TEXT      NOT NULL,
    description TEXT      NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX tenant_name_index ON tenant (name);

-- 主租户（迁移生成，不可删除）
INSERT INTO tenant (name, description) VALUES ('main', '主租户（迁移生成）');

-- 存量表归属租户（列可空，应用层回填后强制非空，沿用项目惯例）
ALTER TABLE user             ADD COLUMN tenant_id BIGINT NULL;
ALTER TABLE model            ADD COLUMN tenant_id BIGINT NULL;
ALTER TABLE vendor           ADD COLUMN tenant_id BIGINT NULL;
ALTER TABLE record           ADD COLUMN tenant_id BIGINT NULL;
ALTER TABLE recharge_records ADD COLUMN tenant_id BIGINT NULL;

-- 模型全局共享标记 + 请求规则归属租户 / 全局共享标记
ALTER TABLE model ADD COLUMN cross_tenant TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE rule  ADD COLUMN tenant_id    BIGINT NULL;
ALTER TABLE rule  ADD COLUMN cross_tenant TINYINT(1) NOT NULL DEFAULT 0;

-- 存量数据回填进主租户（main 租户 == 迁移前的全局状态），cross_tenant 保持 0
UPDATE user             SET tenant_id = (SELECT id FROM tenant WHERE name = 'main');
UPDATE model            SET tenant_id = (SELECT id FROM tenant WHERE name = 'main');
UPDATE vendor           SET tenant_id = (SELECT id FROM tenant WHERE name = 'main');
UPDATE record           SET tenant_id = (SELECT id FROM tenant WHERE name = 'main');
UPDATE recharge_records SET tenant_id = (SELECT id FROM tenant WHERE name = 'main');
UPDATE rule             SET tenant_id = (SELECT id FROM tenant WHERE name = 'main');

-- 删除 model 全局唯一 name 索引（migrate_0030 引入），否则跨租户同名模型会被它拦截；
-- 模型 / 供应商名称唯一性改由应用层按租户查重（enabled_model_name_index 已在 migrate_0030 删除）
DROP INDEX IF EXISTS name_index;
