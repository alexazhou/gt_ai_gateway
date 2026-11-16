# 数据库迁移目录

一个迁移一个目录，目录名即迁移标识：

```
resource/migrate/migrate_NNNN/
├── sqlite.sql   # SQLite / D1（worker 本地与云端）
└── mysql.sql    # MySQL（CI 的 mysql 门）
```

执行入口：`src/service/dbMigrationService.ts`（`npm run db:migrate:node` / `db:migrate:worker-local` 等）。
判据：库里 `_migrations` 表记录已应用的迁移名，`pending = available − applied`。

---

## 编号规则（硬规则）

1. **递增、不跳号、不复用。** 当前最新是 `migrate_0034`，下一个用 **`migrate_0035`**。
2. **已发布的编号永久退役，即使目录被删除也不能再用。**
   - **已退役：`migrate_0033`**（跨 isolate 限流 / 上游冷却，`rate_limit_bucket` / `upstream_health`）。
     它曾随 `v1.9.1-beta1` 发布出去（`git tag --contains 5b29b86` 仅该 tag），
     装过该 beta 的库里仍有它的记录；目录已删除，由 **`migrate_0034`** 收敛
     （drop 两张表 + 删 `migrate_0033` 记录）。
   - **为什么不能复用**：`readMigrationState()` 的判据是
     `pending = available.filter(name => !appliedNames.has(name))`，**只覆盖「目录里有、库里没有」**。
     若把新内容放进一个「库里已有记录」的编号，那个迁移会被**静默跳过**：不报错、不建表、
     无任何日志，随后在运行时报「表不存在」。

## 反向差异是盲区（写迁移前必读）

判据没有反向分支，所以「**库里有记录、目录里没有**」这种情况 `migrate()` / `status()` 都不会提示，
只会显示 `up to date`（实测：库里留着已删迁移的记录时输出 `Applied: 33, Available: 32, Pending: 0`，
版本号仍报 33）。

要收敛这种状态，**必须显式写一个新迁移**去做清理，例如 `migrate_0034`：

```sql
DROP TABLE IF EXISTS <该迁移建的表>;
DELETE FROM _migrations WHERE name = '<已删迁移的编号>';
```

顺序无关（runner 在迁移 SQL 执行完之后才 `INSERT INTO _migrations` 记录新迁移），
但 `DELETE` 的目标只能是**别的**编号，不要删自己。

> 待补用例：`tests/lifecycle/` 目前缺「库里有记录、目录里没有」的场景（任务单 #288），
> 补上后这里可以改成指向该用例。

## 本地与 CI 口径

- 本地只跑 sqlite（node / worker-local）；**MySQL 门交 GitHub CI**，本地不起 mysql 容器。
- 迁移只许新增：已执行过的迁移内容不许改（改了对已升级的库不生效，只会让新旧库分叉）。
- 真库迁移必须在合并之后执行，不在开发分支上动真实数据。
