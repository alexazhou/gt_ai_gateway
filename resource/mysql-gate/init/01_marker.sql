-- T7 本地 MySQL 门：实例身份标记（marker）
--
-- 为什么需要它：`SELECT version()` 成功只能证明「连到的是 MySQL」，
-- **证明不了「连到的是我们起的那个容器」**。若本机另有 MySQL 占着 3306、
-- 或容器起失败但留着旧的端口转发，两条心跳照样全绿 —— 而门是假的。
-- 这个 marker 表由 compose 的 init 脚本在**首次初始化数据目录**时创建，
-- 只存在于「本次容器自己的数据卷」里，因此它是实例同一性的证据。
--
-- 为什么放在**独立库 `t7_gate`**、而不是测试库 `test`（这一版是修 bug，不是洁癖）：
--   `tests/helpers/dbHelper.ts` 的 `initDatabase()` 在 MySQL 模式下第一件事就是
--   `dropAllMysqlTables()` —— **无条件 DROP 掉 `DATABASE()` 里的所有表**
--   （目的：每次从空库重跑 33 个迁移）。marker 表若在 `test` 库里：
--     第一跑：前置检查通过 → globalSetup 建库时 marker 被 DROP → 测试照跑 → 门红（正常）
--     第二跑：前置检查读不到 marker → **FATAL-④「连到的不是本次容器」** → 门被自己拦住
--   = 一条**只会给一次机会**的门，且第二次的错误归因是**假的**（容器其实是对的）。
--   实测于 `c12bf61`：连续第二次跑 `npm run test:mysql` 直接 exit 1 @ FATAL-④。
--   独立库不在 `DATABASE()` 作用域内，`dropAllMysqlTables()` 碰不到它。
--
-- 注：init 脚本只在**空数据卷**上执行一次。改动本文件后必须重建容器：
--   docker compose -f docker-compose.test-mysql.yml down -v && docker compose -f docker-compose.test-mysql.yml up -d
CREATE DATABASE IF NOT EXISTS t7_gate;
USE t7_gate;

CREATE TABLE IF NOT EXISTS _t7_gate_marker (
    id TINYINT PRIMARY KEY,
    marker VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO _t7_gate_marker (id, marker)
VALUES (1, 't7-local-mysql-gate')
ON DUPLICATE KEY UPDATE marker = VALUES(marker);
