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

1. **只增不改**：已应用过的迁移，**文件不许改、`_migrations` 记录不许删**。
   要撤销某个迁移建的东西，只能用**新编号追加一个反向迁移**（示例见 `migrate_0034`：它只 `DROP`
   了 `migrate_0033` 建的两张表，`migrate_0033` 的文件与记录原样保留）。
2. **递增、不跳号、不复用。** 当前最新是 `migrate_0034`，下一个用 **`migrate_0035`**。
3. 若某编号对应的迁移目录真的被删除过（历史遗留），那个编号**永久不可复用**：
   `readMigrationState()` 的判据是 `pending = available.filter(name => !appliedNames.has(name))`，
   只覆盖「目录里有、库里没有」；把新内容塞进「库里已有记录」的编号会被**静默跳过**
   （不报错、不建表、无日志，随后运行时报「表不存在」）。

## 反向差异是盲区（写迁移前必读）

判据没有反向分支，所以「**库里有记录、目录里没有**」这种情况 `migrate()` / `status()` 都不会提示，
只会显示 `up to date`（实测：库里留着已删迁移的记录时输出 `Applied: 33, Available: 32, Pending: 0`，
版本号仍报 33）。这正是上面第 3 条「编号不可复用」的成因。

正因如此，**不要靠删目录来"撤销"迁移** —— 走「新编号 + 反向迁移」。
若确实遇到历史遗留的这种状态，只能显式写一个迁移去清理，且清理时也只动对象、不动历史记录：

```sql
DROP TABLE IF EXISTS <该迁移建的表>;
```

（`DELETE FROM _migrations` 属于改写历史，**不要做**。）

> 待补用例：`tests/lifecycle/` 目前缺「库里有记录、目录里没有」的场景（任务单 #288），
> 补上后这里可以改成指向该用例。

## 本地与 CI 口径

- 本地只跑 sqlite（node / worker-local）；**MySQL 门交 GitHub CI**，本地不起 mysql 容器。
- 真库迁移必须在合并之后执行，不在开发分支上动真实数据。
