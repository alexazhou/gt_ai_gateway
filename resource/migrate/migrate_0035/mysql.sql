-- 通用请求插件规则化 v3（design/2026-11-24-generic-plugin/step2_technical.md §3.1 / §3.2）
--
-- 与 sqlite.sql 同一语义与同一执行顺序：
--   1) rule 表加 priority / source / biz_id / note 四列（存量规则 priority 由 DEFAULT 回填 100）；
--   2) 合并旧前端遗留的 tracking 配置键名（以旧键保存值为准）；
--   3) 四条系统规则**不再**由本迁移预置，改由运行期 ensureSystemRules() 生成（见文末说明）。
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

-- 3) 系统规则不再由迁移预置（2026-11-28 改）---------------------------------
-- 四条系统规则（屏蔽 Claude Code 跟踪 / 强制改写 CCH / Responses API 粘性路由 / 自动生成 session header）
-- 改由运行期 `ensureSystemRules()`（src/plugin/systemRulesSync.ts）按 src/plugin/systemRules.ts 的常量
-- 生成与纠偏；本迁移只负责结构变更与上面的旧配置键合并。
--
-- 为什么不在这里 INSERT：name / priority / note / plugin / pluginConfig 全是代码资产，写进 SQL 会与
-- TS 常量漂移（此前靠 tests/lifecycle/genericPluginMigration.node.test.ts 用红灯钉住），改一句文案还得
-- 再加一条迁移。已应用过本迁移的老库不会重跑，规则同样由启动 ensure 维护。
--
-- enabled 初值语义不变：新建行时 ensure 读该规则对应配置项的当前值（有配置行用行值，无行用后端默认值），
-- 与原 COALESCE 口径一致；**已存在的行 ensure 永不改写 enabled**（它是用户运行期开关）。
