-- 通用请求插件规则化 v3（design/2026-11-24-generic-plugin/step2_technical.md §3.1 / §3.2）
--
-- 与 sqlite.sql 同一语义与同一执行顺序：
--   1) rule 表加 priority / source / biz_id / note 四列（存量规则 priority 由 DEFAULT 回填 100）；
--   2) 合并旧前端遗留的 tracking 配置键名（以旧键保存值为准）；
--   3) 按当前配置预置三条系统规则（priority 10 / 20 / 30，cross_tenant = 1，scope = const true）。
--
-- 方言差异：`INSERT IGNORE`（sqlite 为 `INSERT OR IGNORE`）；
-- 「两个键都存在时以旧键为准」用自连接 UPDATE（MySQL 不允许在 UPDATE 的子查询里引用目标表）。

-- 1) 加列 ------------------------------------------------------------------
ALTER TABLE `rule` ADD COLUMN priority INT NOT NULL DEFAULT 100;
ALTER TABLE `rule` ADD COLUMN source   VARCHAR(32) NOT NULL DEFAULT 'user';
ALTER TABLE `rule` ADD COLUMN biz_id   VARCHAR(128) NULL;
-- note：规则备注（自由文本注释），未填为 NULL
ALTER TABLE `rule` ADD COLUMN note     TEXT NULL;

-- 系统规则的 biz_id 全局唯一（MySQL 唯一索引允许多个 NULL，用户规则不受影响）
CREATE UNIQUE INDEX rule_biz_id_index ON `rule` (biz_id);
-- 规则缓存与列表统一按 (priority ASC, id ASC) 排序，走这个索引
CREATE INDEX rule_priority_index ON `rule` (priority, id);

-- 2) 旧 tracking 配置键合并 -------------------------------------------------
INSERT IGNORE INTO config (name, value)
SELECT 'claudecode_tracking_rewrite_enabled', value
FROM config WHERE name = 'claude_code_tracking_rewrite_enabled';

UPDATE config AS n
JOIN config AS o ON o.name = 'claude_code_tracking_rewrite_enabled'
SET n.value = o.value
WHERE n.name = 'claudecode_tracking_rewrite_enabled';

DELETE FROM config WHERE name = 'claude_code_tracking_rewrite_enabled';

-- 3) 预置三条系统规则 -------------------------------------------------------
-- enabled 跟随**迁移后的运行期口径**：配置有行 → 用行值；配置无行 → 用后端默认值 'true'
-- （migrate_0017 预置过 cch_rewrite_enabled = 'false'，与 configService 默认 true 不一致，
--   这里取运行期实际会读到的值，而不是"行不存在就当默认值"）。
INSERT IGNORE INTO `rule` (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id)
SELECT 'plugin',
       '屏蔽 Claude Code 跟踪',
       '{"type":"const","values":[true]}',
       '{"plugin":"claudeCodeTrackingRewriter","pluginConfig":{}}',
       CASE WHEN LOWER(COALESCE((SELECT value FROM config WHERE name = 'claudecode_tracking_rewrite_enabled'), 'true')) = 'false' THEN 0 ELSE 1 END,
       t.id, 1, 10, 'system', 'SYS:setting:claudecode_tracking_rewrite'
FROM tenant t WHERE t.name = 'main';

INSERT IGNORE INTO `rule` (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id)
SELECT 'plugin',
       '强制改写 CCH',
       '{"type":"const","values":[true]}',
       '{"plugin":"cchRewriter","pluginConfig":{}}',
       CASE WHEN LOWER(COALESCE((SELECT value FROM config WHERE name = 'cch_rewrite_enabled'), 'true')) = 'false' THEN 0 ELSE 1 END,
       t.id, 1, 20, 'system', 'SYS:setting:cch_rewrite'
FROM tenant t WHERE t.name = 'main';

INSERT IGNORE INTO `rule` (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id)
SELECT 'plugin',
       'Responses API 粘性路由',
       '{"type":"const","values":[true]}',
       '{"plugin":"responsesPromptCacheKeyRewriter","pluginConfig":{}}',
       CASE WHEN LOWER(COALESCE((SELECT value FROM config WHERE name = 'responses_prompt_cache_key_enabled'), 'true')) = 'false' THEN 0 ELSE 1 END,
       t.id, 1, 30, 'system', 'SYS:setting:responses_prompt_cache_key'
FROM tenant t WHERE t.name = 'main';
