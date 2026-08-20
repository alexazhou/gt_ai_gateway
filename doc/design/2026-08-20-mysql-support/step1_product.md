# MySQL 数据库支持 — 产品文档 (step1)

## 背景与目标

当前 Node 本地模式数据库固定使用 SQLite（better-sqlite3），Cloudflare Workers 模式使用 D1。SQLite 是嵌入式单机数据库，存在以下限制：

- 单文件、单写者，写入并发与多实例部署受限
- 不适合需要**独立数据库服务**的部署形态（如与现有 MySQL 基础设施共建、多后端实例水平扩展）
- 大表 / 高并发写入场景性能与运维能力（权限、备份、监控生态）不如 MySQL

**目标**：为 Node 本地模式增加 **MySQL** 作为可选的数据库后端，通过**环境变量**在 SQLite 与 MySQL 之间切换，不改动现有 SQLite 与 Cloudflare Workers D1 路径，保持默认行为完全不变。

## 功能特性

### 1. 环境变量控制数据库驱动

- 新增 `DB_DRIVER` 环境变量，取值 `sqlite`（默认）或 `mysql`
- `DB_DRIVER=sqlite`（或不设置）→ 行为与现在完全一致，使用 `DB_PATH` 指定的 SQLite 文件
- `DB_DRIVER=mysql` → 使用 MySQL 连接，需配置连接参数

### 2. MySQL 连接配置

- 使用独立的连接环境变量显式配置（清晰、无歧义）：
  - `DB_HOST`（默认 `127.0.0.1`）
  - `DB_PORT`（默认 `3306`）
  - `DB_USER`、`DB_PASSWORD`
  - `DB_NAME`（必填，目标数据库名）
- 同时提供可选 `DB_URL`（`mysql://user:pass@host:port/db`）作为一键式配置；若设置了 `DB_URL` 则优先于离散变量
- 支持通过 `DB_POOL_*`（可选）控制连接池大小等参数

### 3. 迁移与建表

- 首次启动 / 手动迁移时，自动在 MySQL 中建表并执行与 SQLite 等价的 schema
- 迁移机制沿用现有 `script/db.ts` 与 `_migrations` 记录表，但为 MySQL 提供独立的迁移 SQL 集，避免方言冲突

### 4. 运行时行为等价

- 调用方（controller / service / manager / model）无需关心底层是 SQLite 还是 MySQL
- 鉴权、计费、路由、协议转换、请求记录、仪表盘统计等全部功能在两种驱动下行为一致

## 产品边界（非目标）

- **不改动 Cloudflare Workers（D1）路径**：Worker 仍使用 D1，MySQL 仅作为 Node 本地模式的增强
- **不提供 SQLite → MySQL 的数据迁移工具**：本次仅新增 MySQL 作为新数据库使用；存量 SQLite 数据迁移为可选后续项
- **不做自动故障转移 / 高可用**：连接池与基础健壮性由 mysql2 提供，不引入集群方案
- **不引入新的方言翻译层**：采用「MySQL 独立迁移 SQL + 运行时复用原有 knex/sutando ORM 自动适配」的策略，避免在不支持的 DDL 上做脆弱的自动翻译

## 验收标准

1. `DB_DRIVER` 未设置或为 `sqlite` 时，启动与功能表现与当前版本完全一致（回归测试通过）
2. `DB_DRIVER=mysql` + 正确连接参数时，Node 模式可连接 MySQL、自动建表、正常启动
3. 在 MySQL 后端下，以下核心链路均通过：登录取证、用户/厂商/模型管理、发起 LLM 请求（非流式+流式）、计费、请求记录、仪表盘统计、客户端配置管理
4. `schema 校验`（`verifySchema`）在 MySQL 后端能正确校验表结构
5. MySQL 迁移支持 `migrate / status / clear / init` 四个命令
6. 默认（SQLite）测试套件全部通过
7. **CI 在 MySQL 环境跑完整测试套件**：`test-node-mysql` job 使用 `services: mysql` 容器 + `DB_DRIVER=mysql` 运行全部 node 模式测试并全绿，与 SQLite job 并行且互不影响
