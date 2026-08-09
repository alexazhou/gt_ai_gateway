# 余额存储 Decimal 化改造需求文档

> 状态：方案评审中，待确认设计决策后实施
> 关联：`doc/design/backend/v4_billing_product.md`、`v4_billing_technical.md`

## 1. 背景与问题现象

网关为每个用户维护一个「余额」字段，用于 LLM 调用计费扣减。当前 `user.balance` 列定义为：

```sql
ALTER TABLE user ADD COLUMN balance DECIMAL(10, 2) DEFAULT 0.0 NOT NULL;
-- resource/migrate/migrate_0007.sql
```

实际使用中出现两类问题：

**问题 A：余额出现浮点噪声**
余额为 `0` 的用户调用一次后，扣费得到极小负数，且带浮点误差：

```text
期望：-0.000000122   （即 -1.22e-7）
实际：-1.2199999999999998e-7
```

**问题 B：前端出现科学计数法与 -0.00 显示**
- 余额列表/表格把 `-1.2199999999999998e-7` 直接显示成科学计数法（`a-statistic` 对科学计数数字不处理 `precision`）。
- 余额调整弹窗用 `balance.toFixed(2)`，对 `-1.22e-7` 得到 `"-0.00"`，显示成 `¥-0.00`。

## 2. 根因分析

### 2.1 SQLite 没有真正的定点 DECIMAL 类型

项目运行在 **SQLite（本地 node 模式）与 Cloudflare D1（Worker 模式）** 上，二者都是 SQLite 内核。SQLite 是动态类型系统，只有 5 种存储类：`NULL / INTEGER / REAL / TEXT / BLOB`，**没有 MySQL/Postgres 那种原生定点 decimal（底层按十进制存储、精确算术）**。

`CREATE TABLE` 里写的 `DECIMAL(10, 2)` 只是 **affinity（类型亲和）提示**，映射为 `NUMERIC` 亲和。实际存储规则：

| 插入的值 | 实际存储 | `typeof()` |
|---------|---------|-----------|
| `0`、`100`（整数） | INTEGER | `integer` |
| `1.22e-7`、`0.3`（非整数） | **REAL（binary64 浮点）** | `real` |
| `'abc'`（非数字） | TEXT | `text` |

因此 `DECIMAL(10, 2)` 的小数位精度声明**在 SQLite 中被忽略**，非整数值一律存成 binary64 浮点，浮点加减的误差（如 `0 - 1.22e-7 = -1.2199999999999998e-7`）原样落入数据库。

> 实证（sqlite3 实际执行）：
> ```sql
> CREATE TABLE t (d DECIMAL(10,2), s TEXT, i INTEGER);
> INSERT INTO t VALUES (0.1 + 0.2, '0.1+0.2精确文本', 300000000);
> SELECT typeof(d), typeof(s), typeof(i) FROM t;   -- real / text / integer
> ```

### 2.2 成本量级导致极小值

`calculateCost` 原按「每 1000 token」计价：`(tokens / 1000) * price`。token 数少、单价低时成本只有 `1e-7` 量级，极易触发浮点噪声与科学计数显示。

## 3. 已完成的配套改动（供评审背景）

在讨论存储方案前，已先行完成以下改动（均已本地验证）：

| 改动 | 说明 |
|------|------|
| 计价单位改「每百万 token」 | `usageUtils.calculateCost` 由 `/1000` 改为 `/1_000_000`（`PRICE_UNIT_TOKENS`） |
| 价格下限 0.0001 | `modelService.validatePrices`：已填写的价格必须 `>= 0.0001`，留空表示不收费 |
| 最小扣减单位 0.000001 元（1e-6） | 新增 `billingUtils`：费用 `quantizeAmount`（正费用取整到 1e-6 整数倍，不足也按 1e-6 扣）；余额 `roundBalance`（取整到 1e-6 整数倍） |
| 前端余额格式化 | 新增 `formatBalance`：`\|值\| < 0.005` 显示 `0.00`，应用于余额/用户表格与余额调整弹窗，消除科学计数与 `-0.00` |

这些改动**缓解**了显示问题，但**没有根治存储层**：余额在 DB 里仍是 REAL 浮点，重复扣费仍可能累积浮点漂移。值得说明的是：**取整粒度定为 0.000001 元后，任何非零值最小也是 1e-6**，而 JS `String(0.000001)` 正好是常规十进制（`"0.000001"`）而非科学计数法，因此即便不做 DB 迁移，存储/显示层也已不会再出现 `1.2e-7` 这类极小科学计数。

## 4. 方案候选

### 方案 A：整数缩放存储（推荐）

把 `user.balance` 改为存 **粒度 0.000001 元（微元）的整数倍**，即余额换算成整数"微元"存储：

```text
余额(元)  -0.000014  →  整数单位(微元)  -14
```

- 所有加减都是整数运算，**完全精确、零浮点误差**，存储值永远是整数，不会出现 `1.2e-7` 这类极小浮点。
- 这是计费系统的标准做法（存"分"、"厘"或更小粒度）。
- 展示时再换算回"元"并格式化成普通小数。

**溢出边界**（粒度 ×1e6 已足够）：SQLite 64 位整数上限对应余额约 9.2 万亿元；真正的约束是 JS 安全整数 `2^53-1 ≈ 9.0e15`，对应余额上限约 **90 亿元**，远超任何实际余额。root 的哨兵余额 `Number.MAX_SAFE_INTEGER` 本身即为安全整数，且 root 不参与扣费，无影响。

### 方案 B：TEXT 字符串存储

把余额存成十进制字符串（如 `"-0.000013599"`）。

- 表示精确，但每次计算都要字符串解析/序列化，性能差、代码侵入大。
- 仅推荐用于"只读展示"字段，不适合作为计费算术字段。

### 方案 C：维持 REAL + 前端兜底格式化

不改存储，仅靠 `formatBalance` 兜底显示。

- 改动最小，但**存储层浮点误差与漂移依然存在**，属于治标不治本，不推荐作为长期方案。

### 方案 D：迁移到真定点数据库

- SQLite / D1 架构下不可行，超出本次范围，不讨论。

## 5. 方案 A（整数缩放）的实施改动（已实现）

| 模块 | 改动 |
|------|------|
| 迁移 | `migrate_0028.sql`：`ADD COLUMN balance_units INTEGER` → `UPDATE user SET balance_units = ROUND(balance / 0.000001)` 转换存量 → `DROP COLUMN balance` → `RENAME COLUMN balance_units TO balance`（无需表重建，规避外键） |
| `SgUser` 模型 | `balance` 字段语义为整数微元（注释标明）；不引入 ORM cast，直接代码换算 |
| `userService` | `adjustBalance` / `deductBalance` / `checkBalance` 全部整数微元运算；入参金额（元）经 `toUnits = Math.round(yuan * BALANCE_SCALE)` 换算；root 余额用大整数哨兵 |
| `senderService` | 余额预检 `balance < 0` 语义不变（负微元即欠费） |
| `userController` | **API 直接返回整数微元**（不转换），`balance` 字段全链路统一为微元 |
| 前端 | 展示时 `formatBalance(value / BALANCE_SCALE)` 换算为"元"；调整余额仍输入"元"、后端换算 |
| 测试 | 全量 node 测试 857 个通过；`billingUtils` 移除已无用的 `roundBalance`；billing 断言更新为微元 |

## 6. 设计决策（已定）

1. **API 契约**：**后端直接返回整数微元**（`balance` 字段全链路统一为微元，不在同一字段混两种语义）；前端展示时 `balance / BALANCE_SCALE` 换算为"元"。粒度 1e-6 下任何非零微元值除以 1e6 后 `String()` 均为常规十进制（不科学计数），`formatBalance` 保留兜底极小值。`adjustBalance` 请求的 `amount` 仍为"元"（管理员输入），由后端 `toUnits` 换算。
2. **存量迁移**：**已决策** —— `ROUND(balance / 0.000001)` 取整到微元。极小的历史浮点余额（如 `-1.22e-7` 元）归零，属可接受舍入；迁移为幂等不可回滚（DDL），发布前需备份 DB。
3. **最小扣减单位**：**已决策 0.000001 元（1e-6）**。任何非零余额/费用不小于 1e-6，JS `String()` 恒为常规十进制；余额上限约 90 亿元（JS 安全整数 `2^53-1` 约束），远超实际场景。
4. **`formatBalance` 前端兜底**：**保留**，作为对历史数据与第三方异常的兜底。

## 7. 结论

SQLite/D1 无原生定点 decimal，`DECIMAL(10,2)` 实际是浮点存储，是余额出现噪声与科学计数的根因。**已按方案 A（整数缩放，粒度 0.000001 元）实施**：DB 存整数微元、服务层整数运算、API 返回"元"（契约兼容）、前端 `formatBalance` 兜底。配合计价单位、价格下限、最小扣减单位改动，端到端消除浮点噪声与科学计数显示。
