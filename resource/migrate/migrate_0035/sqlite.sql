-- 通用请求插件规则化 v3（design/2026-11-24-generic-plugin/step2_technical.md §3.1 / §3.2）
--
-- 三件事，顺序有依赖：
--   1) rule 表加 priority / source / biz_id / note 四列（存量规则的 priority 由 DEFAULT 回填 100）；
--   2) 合并旧前端遗留的 tracking 配置键名（以旧键保存值为准）；
--   3) 按当前配置预置三条系统规则（priority 10 / 20 / 30，cross_tenant = 1，scope = const true）。
--
-- 与 mysql.sql 同一语义，只有方言差异（INSERT OR IGNORE / 自子查询 UPDATE）。
-- 本迁移只加列、加索引、搬数据，不改历史迁移、不动 _migrations。

-- 1) 加列 ------------------------------------------------------------------
-- priority：执行优先级（0~10000，越小越先执行）。给 NOT NULL DEFAULT 100，
-- 存量规则（限流 / 访问控制）由 sqlite 自己回填 100，不需要额外 UPDATE。
ALTER TABLE rule ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
-- source：system（系统规则，由高级设置联动）/ user（管理员手建）
ALTER TABLE rule ADD COLUMN source   TEXT    NOT NULL DEFAULT 'user';
-- biz_id：系统规则业务标识，用户规则为 NULL
ALTER TABLE rule ADD COLUMN biz_id   TEXT    NULL;
-- note：规则备注（自由文本注释），未填为 NULL
ALTER TABLE rule ADD COLUMN note     TEXT    NULL;

-- 系统规则的 biz_id 全局唯一；sqlite 的唯一索引允许多个 NULL，用户规则不受影响
CREATE UNIQUE INDEX rule_biz_id_index ON rule (biz_id);
-- 规则缓存与列表统一按 (priority ASC, id ASC) 排序，走这个索引
CREATE INDEX rule_priority_index ON rule (priority, id);

-- 2) 旧 tracking 配置键合并 -------------------------------------------------
-- 旧前端把「屏蔽 Claude Code 跟踪」写成 claude_code_tracking_rewrite_enabled，
-- 新口径是 claudecode_tracking_rewrite_enabled。
-- 两个键都存在时**以旧键为准**（用户最后一次保存的开关状态落在旧键里），搬完删掉旧键。
INSERT OR IGNORE INTO config (name, value)
SELECT 'claudecode_tracking_rewrite_enabled', value
FROM config WHERE name = 'claude_code_tracking_rewrite_enabled';

UPDATE config
SET value = (SELECT o.value FROM config AS o WHERE o.name = 'claude_code_tracking_rewrite_enabled')
WHERE name = 'claudecode_tracking_rewrite_enabled'
  AND EXISTS (SELECT 1 FROM config AS o WHERE o.name = 'claude_code_tracking_rewrite_enabled');

DELETE FROM config WHERE name = 'claude_code_tracking_rewrite_enabled';

-- 3) 预置三条系统规则 -------------------------------------------------------
-- enabled 跟随**迁移后的运行期口径**：配置有行 → 用行值；配置无行 → 用后端默认值 'true'。
-- 不能只看行是否存在：migrate_0017 预置过 cch_rewrite_enabled = 'false'，
-- 而 configService 的默认值是 true —— 两处口径不一致，这里按「运行期实际会读到的值」算。
-- 主租户由 migrate_0032 建好；查不到就不插（宁缺不错，缺了由启动自检/测试 seed 兜）。
INSERT OR IGNORE INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id)
SELECT 'plugin',
       '屏蔽 Claude Code 跟踪',
       '{"type":"const","values":[true]}',
       '{"plugin":"claudeCodeTrackingRewriter","pluginConfig":{}}',
       CASE WHEN LOWER(COALESCE((SELECT value FROM config WHERE name = 'claudecode_tracking_rewrite_enabled'), 'true')) = 'false' THEN 0 ELSE 1 END,
       t.id, 1, 10, 'system', 'SYS:setting:claudecode_tracking_rewrite'
FROM tenant t WHERE t.name = 'main';

INSERT OR IGNORE INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id)
SELECT 'plugin',
       '强制改写 CCH',
       '{"type":"const","values":[true]}',
       '{"plugin":"cchRewriter","pluginConfig":{}}',
       CASE WHEN LOWER(COALESCE((SELECT value FROM config WHERE name = 'cch_rewrite_enabled'), 'true')) = 'false' THEN 0 ELSE 1 END,
       t.id, 1, 20, 'system', 'SYS:setting:cch_rewrite'
FROM tenant t WHERE t.name = 'main';

INSERT OR IGNORE INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id)
SELECT 'plugin',
       'Responses API 粘性路由',
       '{"type":"const","values":[true]}',
       '{"plugin":"responsesPromptCacheKeyRewriter","pluginConfig":{}}',
       CASE WHEN LOWER(COALESCE((SELECT value FROM config WHERE name = 'responses_prompt_cache_key_enabled'), 'true')) = 'false' THEN 0 ELSE 1 END,
       t.id, 1, 30, 'system', 'SYS:setting:responses_prompt_cache_key'
FROM tenant t WHERE t.name = 'main';
