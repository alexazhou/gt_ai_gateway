-- tenant：多租户隔离的根实体，name 全局唯一（租户标识）
CREATE TABLE `tenant` (
    `id`          BIGINT       NOT NULL AUTO_INCREMENT,
    `name`        VARCHAR(255) NOT NULL,
    `description` TEXT         NULL,
    `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `tenant_name_index` (`name`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 主租户（自动生成，不可删除）
INSERT INTO tenant (name, description) VALUES ('main', '主租户（自动生成）');

-- 存量表归属租户（列可空，应用层回填后强制非空，沿用项目惯例）
ALTER TABLE `user`             ADD COLUMN `tenant_id` BIGINT NULL;
ALTER TABLE `model`            ADD COLUMN `tenant_id` BIGINT NULL;
ALTER TABLE `vendor`           ADD COLUMN `tenant_id` BIGINT NULL;
ALTER TABLE `record`           ADD COLUMN `tenant_id` BIGINT NULL;
ALTER TABLE `recharge_records` ADD COLUMN `tenant_id` BIGINT NULL;

-- 模型全局共享标记 + 请求规则归属租户 / 全局共享标记
ALTER TABLE `model` ADD COLUMN `cross_tenant` TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE `rule`  ADD COLUMN `tenant_id`    BIGINT NULL;
ALTER TABLE `rule`  ADD COLUMN `cross_tenant` TINYINT(1) NOT NULL DEFAULT 0;

-- 存量数据回填进主租户（main 租户 == 迁移前的全局状态），cross_tenant 保持 0
UPDATE `user`             SET `tenant_id` = (SELECT id FROM tenant WHERE name = 'main');
UPDATE `model`            SET `tenant_id` = (SELECT id FROM tenant WHERE name = 'main');
UPDATE `vendor`           SET `tenant_id` = (SELECT id FROM tenant WHERE name = 'main');
UPDATE `record`           SET `tenant_id` = (SELECT id FROM tenant WHERE name = 'main');
UPDATE `recharge_records` SET `tenant_id` = (SELECT id FROM tenant WHERE name = 'main');
UPDATE `rule`             SET `tenant_id` = (SELECT id FROM tenant WHERE name = 'main');

-- 删除 model 全局唯一 name 索引（migrate_0030 引入），否则跨租户同名模型会被它拦截；
-- 模型 / 供应商名称唯一性改由应用层按租户查重（enabled_model_name_index 已在 migrate_0030 删除）
DROP INDEX `name_index` ON `model`;

-- record 租户查询索引：多租户后查询模式改为按 tenant_id 过滤（含 dashboard 全量 COUNT），
-- 原 created_at 单列索引（migrate_0008 引入）覆盖不到，纯 tenant 过滤时退化为全表扫描；
-- 改为租户前置的单列 + 复合索引（复合索引左前缀即可服务纯 tenant_id 查询）
DROP INDEX `idx_record_created_at` ON `record`;
CREATE INDEX `idx_record_tenant_id` ON `record` (`tenant_id`);
CREATE INDEX `idx_record_tenant_created_at` ON `record` (`tenant_id`, `created_at`);

-- model 租户内名称唯一索引：LLM 调用按 name 解析模型、租户内名称查重都走 (tenant_id, name)；
-- 全局唯一 name_index 已在上方删除，改由本索引在 DB 层强制租户内名称唯一（跨租户同名仍允许）
--
-- 建索引前对同租户同名 model 做防御性去重：正常存量数据（migrate_0030 曾强制 name 全局唯一）
-- 不会重名，此 UPDATE 通常为空操作；若历史数据出现重名，保留 id 最小的一条，
-- 其余 name 追加 -<id> 改名（如 name → name-3），保证下方 UNIQUE 索引可建
-- （MySQL 不允许 UPDATE 直接引用目标表的子查询，用派生表 dup_ids 包一层规避）
UPDATE `model` SET `name` = CONCAT(`name`, '-', `id`)
WHERE `id` IN (
    SELECT id FROM (
        SELECT m.`id` FROM `model` m
        WHERE EXISTS (
            SELECT 1 FROM `model` m2
            WHERE m2.`tenant_id` = m.`tenant_id` AND m2.`name` = m.`name` AND m2.`id` < m.`id`
        )
    ) AS dup_ids
);
CREATE UNIQUE INDEX `idx_model_tenant_name` ON `model` (`tenant_id`, `name`);
