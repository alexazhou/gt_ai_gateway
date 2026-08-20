# MySQL 数据库支持 — 技术文档 (step2)

## 架构概览

```
┌─────────────────────────────── Node 本地模式 ──────────────────────────────┐
│                                                                           │
│   src/local.ts                                                            │
│     └─ ormService.init({ mode: NODE, dbPath })                            │
│           └─ 根据 DB_DRIVER 选择连接：                                    │
│                ├─ sqlite(默认): sutando client=better-sqlite3             │
│                └─ mysql:       sutando client=mysql2  ← 本特性新增         │
│                                                                           │
│   sutando / knex 查询构建器 (模型层 model/ + 各 manager)                   │
│        │  ← 跨方言，自动生成对应 dialect 的 SQL，无需改动                  │
│        ├─ SQLiteAdapter        (util/dbAdapterUtil.ts)                    │
│        ├─ D1Adapter            (同上, worker 模式)                        │
│        └─ MySQLAdapter         (本特性新增)                                │
│                                                                           │
│   script/db.ts 迁移 (CLI + 启动)                                          │
│        ├─ LocalDBAdapter    (sqlite)                                       │
│        ├─ WranglerDBAdapter (D1)                                          │
│        └─ MySQLDBAdapter    (本特性新增)                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

**核心思路**：运行时数据访问全部经由 `sutando/knex` 查询构建器，它已内置 `better-sqlite3` 与 `mysql2` 两个方言；因此**业务查询代码零改动**即可跨 SQLite / MySQL。本特性需要处理的是「初始化的方言选择」「迁移 DDL」与「少数几处方言特有 raw SQL」。

---

## 环境变量设计

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `DB_DRIVER` | `sqlite` | 数据库驱动：`sqlite` / `mysql` |
| `DB_PATH` | `./local.db` | (sqlite) 数据库文件路径，现有逻辑不变 |
| `DB_HOST` | `127.0.0.1` | (mysql) 主机 |
| `DB_PORT` | `3306` | (mysql) 端口 |
| `DB_USER` | - | (mysql) 用户名 |
| `DB_PASSWORD` | - | (mysql) 密码 |
| `DB_NAME` | - | (mysql) 库名，必填 |
| `DB_URL` | - | (mysql) 可选连接串，`mysql://user:pass@host:port/db`，设置后优先于离散变量 |
| `DB_POOL_MIN` / `DB_POOL_MAX` | 由 mysql2 默认 | (mysql) 可选连接池下限/上限 |

> 在 Node 模式下，`src/local.ts` 已通过 dotenv 加载 `.dev.vars`（override:false），因此上述变量可直接写入 `.dev.vars`。新增变量需同步登记到 `.dev.vars.template`。

---

## 初始化与连接（ormService.init）

`src/service/ormService.ts` 的 `init()` 在 `mode === NODE` 分支中，当前硬编码 `better-sqlite3`。改造为：

```
若 DB_DRIVER === "mysql":
    const conn = DB_URL ? { uri: DB_URL } : { host, port, user, password, database }
    sutando.addConnection({
        client: "mysql2",
        connection: { ...conn, pool: { min, max } },
        useNullAsDefault: true,
    })
    创建运行时 MySQLAdapter，并将 ormService._dbAdapter 指向它
    执行 mysql 迁移（dbScript.migrate 传 MySQLDBAdapter + "node"）
否则:
    现有 sqlite 逻辑不变
```

`prepareDBConnection` / `connectWorker` 仅在 `RunMode.WORKER` 下生效，MySQL 不影响该路径。

**运行时 `DatabaseAdapter` 抽象**（`util/dbAdapterUtil.ts`）：新增 `MySQLAdapter`，实现 `exec / prepare / all / first / run`，底层使用 `mysql2/promise` 连接池。当前运行时仅 `statsController.ts:33-34` 走该接口，且其 SQL 为 ANSI 标准（`COUNT/SUM/CASE WHEN`），MySQL 兼容。

---

## 迁移策略

### 迁移文件组织

每个迁移一个目录，目录内按方言存放 SQL 文件（SQLite 与 D1 共用 `sqlite.sql`，MySQL 用 `mysql.sql`，两者一致时只需 `common.sql`）：

```
resource/migrate/
├── migrate_0001/
│   ├── sqlite.sql        # SQLite / D1 方言（原 migrate_0001.sql）
│   └── mysql.sql         # MySQL 方言
├── migrate_0004/
│   └── common.sql        # 方言一致时仅此文件
└── ...
```

**执行语义（排他优先级）**：一个迁移只执行一个文件——当前方言文件存在就用它，否则回退 `common.sql`。
- `DB_DRIVER=mysql`（node）：先找 `mysql.sql`，没有再找 `common.sql`
- node 默认 / worker(D1)：先找 `sqlite.sql`，没有再找 `common.sql`

**迁移标识**：`_migrations.name` 记录的是**目录名**（如 `migrate_0001`），跨方言稳定、同一迁移只记一次。

**方言一致 ↔ 拆分原则**：SQLite 与 MySQL 完全一致的迁移只写 `common.sql`（如纯 `DROP COLUMN` / 可移植 `ALTER ... RENAME`）；有差异的写 `sqlite.sql` + `mysql.sql`。

`script/db.ts` 的 `listMigrations()` 扫描目录、`migrationSqlFile(dir, dialect)` 按上述优先级取文件；`getAdapter("node")` 在 `DB_DRIVER=mysql` 时返回 `MySQLDBAdapter`。

### `_migrations` 记录表（方言差异）

SQLite：`_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`

MySQL：`_migrations (id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`

`MySQLDBAdapter` 需在 `exec` 中创建该表（建表语句按 MySQL 方言）。

### MySQLDBAdapter（script/db.ts）

实现既有 `DBAdapter` 接口，使用 `mysql2/promise`：

- `exec(sql)`：建一个连接，开启 `multipleStatements: true` 执行（迁移文件含多条语句）
- `query<T>(sql)`：`SELECT` 返回行数组
- `run(sql, ...params)`：`execute` 预处理参数
- `execTransaction(sqls)`：`BEGIN` → 逐条执行 → `COMMIT`（异常 `ROLLBACK`）
- `close()`：释放连接池
- 类型映射说明：MySQL 驱动返回的字段与列别名保持一致（如 `today_requests`），现有读取代码无需改动

---

## 代码组织重构：适配器与迁移逻辑下沉到 src

现状问题：迁移侧适配器（`DBAdapter` 接口、`LocalDBAdapter`、`MySQLDBAdapter`、`WranglerDBAdapter`）及迁移编排都定义在 CLI 脚本 `script/db.ts` 中，导致 **`src/service/ormService.ts` 反向依赖 `script/`**，且测试助手（`tests/helpers/dbHelper.ts`）也要从 `script/` 取值——依赖方向倒置、基础逻辑归属错误。

**目标结构**：基础适配器 / 方言辅助下沉到 `src/util/db/`，迁移编排下沉到 `src/service/`，`script/db.ts` 退化为**仅含命令行参数解析与分发的薄 CLI**。

```
src/util/db/
├── dbAdapter.ts              # DBAdapter 接口 + 方言/文件/建表辅助
│                             #   （getDialect / migrationSqlFile / listMigrations / migrationsTableDdl）
├── sqliteDBAdapter.ts        # SQLiteDBAdapter（原 LocalDBAdapter，better-sqlite3）
├── mysqlDBAdapter.ts         # MySQLDBAdapter（mysql2/promise）
├── wranglerDBAdapter.ts      # WranglerDBAdapter（d1 execute CLI）
└── index.ts                  # 聚合导出
src/service/
└── dbMigrationService.ts     # migrate / status / clear / init 编排 + createDBAdapter(env)
script/
└── db.ts                     # 薄 CLI：解析参数 → 调 dbMigrationService → 退出
```

**依赖方向（修正后）**
```
script/db.ts ──► src/service/dbMigrationService.ts ──► src/util/db/（适配器+辅助）
src/service/ormService.ts ──► dbMigrationService / SQLiteDBAdapter   （不再 import script/）
tests/helpers/dbHelper.ts ──► src/util/db/（DBAdapter 接口）
```

要点：
- **`script/db.ts` 只保留**：`main()`、命令行参数解析（`--env/--config/--db-name`）、命令分发、`process.exit` 处理。不再直接持有 SQL/适配器/迁移逻辑。
- **`src/util/db/dbAdapter.ts`** 提供接口与纯静态辅助；`sqlite/mysql/wrangler` 三个适配器各一文件，便于独立复用与测试。
- **`dbMigrationService`** 持有编排（扫描、按方言取文件、事务/合并执行、`_migrations` 追踪、clear 列表）与 `createDBAdapter(env)` 工厂，被 CLI 与 `ormService.init()`（启动自动迁移）共用。
- **`ormService.init()`** 的启动迁移改为：`new SQLiteDBAdapter(dbPath)`（或 mysql 时的 `MySQLDBAdapter`）+ `dbMigrationService.migrate(adapter, "node")`，消除 `src → script` 反向依赖。
- **`tests/helpers/dbHelper.ts`** 从 `src/util/db/` 导入 `DBAdapter` 接口；其自带的 SQLite/D1 测试适配器可逐步复用 `src` 的实现（作为可选收敛项）。
- 运行时 `DatabaseAdapter`（`util/dbAdapterUtil.ts`，SQLite/D1）与迁移侧 `DBAdapter` 是两个抽象：本特性先各自保留，后续可评估是否统一（可选，非本次必做）。

---

## 方言特有 SQL 改动点（完整清单）

经全库排查，除迁移 DDL 外，SQLite 特有的点仅 4 处，全部改为「按驱动分支」：

| # | 位置 | 现状（SQLite） | MySQL 替代 |
|---|------|---------------|-----------|
| 1 | `ormService.verifySchema()` | `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'` | `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()` |
| 2 | `script/db.ts clear()` | `SELECT name FROM sqlite_master ...` | 同上（用 `information_schema.tables` 列出可 DROP 的表） |
| 3 | `script/db.ts _migrations` 建表 | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT PRIMARY KEY AUTO_INCREMENT`（在 `MySQLDBAdapter` 内按方言执行） |
| 4 | `manager/modelManager.ts filterByVendor()` | `json_each(model.routing_config, '$.upstreams')` + `json_extract(upstream.value,'$.vendor_id')` | 用 `JSON_TABLE(routing_config, '$.**' ...)` 或 `JSON_CONTAINS(routing_config, ?)` 实现等价过滤（按驱动分支） |

> 其余（`statsController` 仪表盘、`recordManager` 时间范围 `where("created_at",">=", opts.startTime)` 传 JS Date、分页 LIMIT/OFFSET、计数/求和等）均为 ANSI 标准 SQL 或 ORM 构建器生成，SQLite / MySQL 均兼容，无需改动。
>
> `json_each`（SQLite JSON1 扩展）与 `json_extract` 在 MySQL 中语义不同，是模型多上游过滤 `filterByVendor` 的唯一硬方言点，需在 SQL 生成处做驱动判断。`$$JSON` 字段（`routing_config`）在 MySQL 用 `JSON` 类型存储，初始化 `useNullAsDefault:true` 与写入序列化不受影响。

---

## 关键类型映射（迁移 DDL）

| SQLite | MySQL | 说明 |
|--------|-------|------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` | 主键 |
| `INTEGER` | `INT` / `BIGINT` | 整形（计费整数微元、金额用 `BIGINT`） |
| `TEXT` | `LONGTEXT` / `VARCHAR(n)` | 定长用 VARCHAR，大文本用 LONGTEXT |
| `REAL` | `DOUBLE` | - |
| `BLOB` | `LONGBLOB` | 请求/响应 payload（storage_record） |
| `BOOLEAN`（0/1） | `TINYINT(1)` | 布尔（可复用到现有 0/1 读写） |
| `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` | `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` | 兼容 |

> 注意：MySQL 默认 `AUTO_INCREMENT` 列需为 `NOT NULL + PRIMARY KEY`（或唯一键）；布尔类字段在 ORM 写入 0/1 时需确认类型（`TINYINT(1)`）。
> `storage_record.data` 用 `LONGBLOB` 存 `Buffer`，通过 ORM 传入的 Buffer 在 mysql2 下可直接绑定。

---

## 测试策略

- **默认（SQLite）全量回归**：现有 node 模式测试套件不改动，必须继续通过，保证默认路径零影响
- **verifySchema 校验**：在 MySQL 后端覆盖「缺表告警」场景

### CI MySQL 全量测试（新增 job）

在 CI 中起一个 MySQL 服务容器，用 `DB_DRIVER=mysql` **跑完整的 node 模式测试套件**（与 SQLite 全量并行、相互独立），确保 MySQL 后端与 SQLite 行为一致。

**GitHub Actions (`test.yml`) 新增 job `test-node-mysql`**（步骤镜像现有 `test-node`，与 SQLite 并行、不影响部署 job）：

- **MySQL 服务容器**：`services: mysql:8`，设置 root 密码、预建 `test` 库，暴露 `3306` 端口并用 `mysqladmin ping` 做健康检查，等待就绪后再跑测试
- **Job 环境变量**：`DB_DRIVER=mysql` + `DB_HOST=127.0.0.1` / `DB_PORT=3306` / `DB_USER=root` / `DB_PASSWORD` / `DB_NAME=test`
- **执行命令**：`npm run backend:test:node:mysql`（新增测试脚本：`TEST_MODE=node DB_DRIVER=mysql vitest --run`）
- 步骤与现有 node 测试一致：checkout → setup-node → `npm ci` → 前端构建 → 类型检查 → 跑测试

**测试侧接线**（`tests/`，依赖 G2 的运行时 MySQL 接入已就绪）：

- `tests/config.ts`：`DB_CONFIG` 读取 `DB_DRIVER / DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME`；`DB_DRIVER=mysql` 时选择 MySQL 驱动
- `tests/helpers/dbHelper.ts`：
  - `createAdapter()`：`DB_DRIVER=mysql` 时返回 MySQL 测试适配器（复用 `script/db` 的 `MySQLDBAdapter`）
  - `runMigrations`：复用 `migrate()`（按方言自动选 `mysql.sql`）
  - 每类测试前的清表（`cleanupTasks` / `truncate`）：MySQL 分支用 `information_schema` 列表 + `DELETE FROM` / `SET FOREIGN_KEY_CHECKS=0`（重复用的 `script/db.ts clear()` 方言逻辑）
- **依赖关系**：该 CI job 依赖 **G2（`ormService.init` MySQL 分支 + 运行时 `MySQLAdapter`）** 已完成；否则测试服务器无法以 MySQL 启动

> MySQL 全量测试用独立 job 与 SQLite 并行，避免相互影响、也不阻塞 Cloudflare 部署。

---

## 关键改动文件清单

| 文件 | 改动 |
|------|------|
| `src/util/dbAdapterUtil.ts` | 新增 `MySQLAdapter`（运行时 DatabaseAdapter） |
| `src/util/db/*` | 新增：`DBAdapter` 接口 + 方言辅助 + 三个适配器（sqlite/mysql/wrangler） |
| `src/service/dbMigrationService.ts` | 新增：`migrate/status/clear/init` 编排 + `createDBAdapter(env)` |
| `src/service/ormService.ts` | `init()` 按 `DB_DRIVER` 分支；启动迁移改从 `src` 引入（消除向 `script/` 的反向依赖）；`verifySchema()` 方言分支 |
| `src/manager/modelManager.ts` | `filterByVendor()` 方言分支（json_each ↔ JSON_TABLE/JSON_CONTAINS） |
| `script/db.ts` | 收敛为薄 CLI（参数解析 + 命令分发），不再持有适配器/迁移 SQL |
| `resource/migrate/migrate_XXXX/` | 每个迁移改为目录，内含 `common.sql` / `sqlite.sql` / `mysql.sql` |
| `tests/helpers/dbHelper.ts` | 改从 `src/util/db` 导入 `DBAdapter`；MySQL 分支清表 |
| `package.json` | 新增依赖 `mysql2` |
| `.dev.vars.template` | 登记 `DB_DRIVER` 及 MySQL 连接变量 |
| 文档 | 本文档 + `TestManual.md` 补充 MySQL 测试说明 |
