# MySQL 数据库支持 — 开发任务表 (step3)

> 状态：规划中（本特性尚未开工）。按依赖排序分组，验收清单见文末。

## 分组总览

| 组 | 主题 | 依赖 |
|----|------|------|
| G1 | 依赖与迁移基础设施（MySQL 驱动 + MySQLDBAdapter + 迁移 SQL） | - |
| G2 | 运行时初始化与适配器（ormService.init + MySQLAdapter） | G1 |
| G3 | 方言特有 SQL 改造（verifySchema / script clear / modelManager） | G1 |
| G4 | 环境变量与配置模板 | G1 |
| G5 | 测试与验证 | G1–G4 |
| G6 | CI MySQL 全量测试（test-node-mysql job） | G2、G5 |

---

## G1: 依赖与迁移基础设施

> 本组包含两个子块：G1a 适配器/迁移逻辑下沉到 src，G1b MySQL 方言与迁移目录。

### G1a 适配器下沉到 src（代码组织重构）

- [ ] `src/util/db/` 新建 `dbAdapter.ts`（`DBAdapter` 接口 + `getDialect`/`migrationSqlFile`/`listMigrations`/`migrationsTableDdl`）
- [ ] `sqliteDBAdapter.ts`（移自 `script/db.ts` 的 `LocalDBAdapter`，逻辑不变）
- [ ] `wranglerDBAdapter.ts`（移自 `script/db.ts` 的 `WranglerDBAdapter`）
- [ ] `src/service/dbMigrationService.ts`：迁入 `migrate/status/clear/init` 编排 + `createDBAdapter(env)` 工厂
- [ ] `script/db.ts` 收敛为薄 CLI（仅参数解析 + 命令分发）
- [ ] `src/service/ormService.ts` 改为从 `src` 引入（消除 `src → script` 反向依赖）；`tests/helpers/dbHelper.ts` 从 `src/util/db` 导入 `DBAdapter`

### G1b MySQL 方言与迁移目录

- [ ] 安装依赖：`mysql2`
- [ ] `src/util/db/mysqlDBAdapter.ts`（`mysql2/promise`，实现 `exec/query/run/execTransaction/close`）
  - [ ] `exec` 支持 `multipleStatements` 执行迁移文件
  - [ ] 建 `_migrations` 表（MySQL 方言 DDL）
- [ ] 迁移重构为「每迁移一目录」：`migrate_XXXX/{common|sqlite|mysql}.sql`（已完成）
  - [ ] 现有 SQLite 内容放入 `sqlite.sql`，方言一致者仅写 `common.sql`
  - [ ] 新增 23 个 `mysql.sql`（方言一致者无）
  - [ ] 类型转换按 step2 映射表（主键/自增/TEXT/BLOB/布尔/TIMESTAMP）
  - [ ] `storage_record.data` 用 `LONGBLOB`
- [ ] `listMigrations()` + `migrationSqlFile()`（方言文件||common）按 `DB_DRIVER` 选择
- [ ] 提交后可运行：`npm run db:status:node`（`DB_DRIVER=mysql`）正确列出 MySQL 迁移状态

## G2: 运行时初始化与适配器

- [ ] `util/dbAdapterUtil.ts` 新增运行时 `MySQLAdapter`（`DatabaseAdapter` 接口）
- [ ] `service/ormService.ts` `init()` Node 分支按 `DB_DRIVER` 选择：
  - [ ] `DB_DRIVER=mysql` 时以 `client:"mysql2"` 建立 sutando 连接（支持 `DB_URL` 与离散变量）
  - [ ] `_dbAdapter` 指向 `MySQLAdapter`；执行 mysql 迁移
  - [ ] 默认（sqlite）分支保持完全不变
- [ ] 启动验证：`DB_DRIVER=mysql` 可连接 MySQL、自动建表、`Server listening` 正常

## G3: 方言特有 SQL 改造

- [ ] `ormService.verifySchema()`：`DB_DRIVER=mysql` 时用 `information_schema.tables` 列表
- [ ] `script/db.ts clear()`：MySQL 分支用 `information_schema.tables` 列出并 DROP 表
- [ ] `manager/modelManager.ts filterByVendor()`：按驱动分支，SQLite 保持 `json_each`，MySQL 用 `JSON_TABLE`/`JSON_CONTAINS` 等价实现

## G4: 环境变量与配置模板

- [ ] 实现 `DB_DRIVER` / `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_URL` / `DB_POOL_*` 的读取
- [ ] `.dev.vars.template` 登记上述变量并加注释
- [ ] `BackendDevManual.md` / `TestManual.md` 补充 MySQL 配置与测试说明
- [ ] `GEMINI.md` / `AGENTS.md` 文档索引（如有必要）补充新设计文档

## G5: 测试与验证

- [ ] 默认 SQLite 全量测试通过（回归，无影响）
- [ ] 本机 MySQL 冒烟（`DB_DRIVER=mysql`）：登录取证→建库→发请求（非流式+流式）→计费→记录→仪表盘统计→客户端配置
- [ ] `verifySchema` 在 MySQL 后端「缺表告警」场景验证
- [ ] 前后端构建通过（`npm run backend:test:type`）

## G6: CI MySQL 全量测试（test-node-mysql job）

> 依赖 G2（运行时 MySQL 接入）与 G5（测试侧接线）就绪后实施。

### 测试侧接线

- [ ] `tests/config.ts`：`DB_CONFIG` 读取 `DB_DRIVER/DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`，`DB_DRIVER=mysql` 时选 MySQL 驱动
- [ ] `tests/helpers/dbHelper.ts`：
  - [ ] `createAdapter()`：`DB_DRIVER=mysql` 时返回 MySQL 测试适配器（复用 `script/db` 的 `MySQLDBAdapter`）
  - [ ] `runMigrations` 复用 `migrate()`（按方言自动选 `mysql.sql`）
  - [ ] 每类测试前的清表：MySQL 分支用 `information_schema` 列表 + `DELETE FROM` / 关闭外键检查（`SET FOREIGN_KEY_CHECKS=0`）

### CI 工作流

- [ ] `test.yml` 新增 job `test-node-mysql`（镜像现有 `test-node`，与 SQLite 并行，不参与部署 `needs`）
- [ ] 配置 `services: mysql:8`（root 密码、预建 `test` 库、暴露 3306、`mysqladmin ping` 健康检查）
- [ ] job 环境变量：`DB_DRIVER=mysql` + `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`
- [ ] `package.json` 新增脚本：`backend:test:node:mysql`（`TEST_MODE=node DB_DRIVER=mysql vitest --run`）
- [ ] 验证：CI 中 MySQL job 全量测试通过；MySQL job 挂掉不影响 SQLite job 与部署

---

## 验收清单（对应 step1_product 验收标准）

- [ ] `DB_DRIVER` 未设置 / `sqlite` 时，行为与现状完全一致（回归通过）
- [ ] `DB_DRIVER=mysql` + 正确连接参数，Node 模式连接 MySQL、自动建表、正常启动
- [ ] 在 MySQL 后端，鉴权 / 厂商模型管理 / LLM 请求（流式+非流式）/ 计费 / 记录 / 仪表盘 / 客户端配置全部通过
- [ ] `verifySchema` 表结构校验在 MySQL 生效
- [ ] `migrate / status / clear / init` 四命令在 MySQL 下可用
- [ ] 默认 SQLite 测试套件全绿
