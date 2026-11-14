/**
 * 纯单元测试专用 vitest 配置（免 globalSetup）。
 *
 * 为什么单独一份：`vitest.config.ts` 无条件挂 `tests/globalSetup.ts`，它会拉起被测服务
 * （9720）、Mock AI（9999）、Mock HTTP 代理（9997）、Mock SOCKS5（9996）四个进程并重建测试库。
 * 本机只要有一套全量门在跑，端口就被占住，连一条纯内存单测都跑不了。这份配置只收集纯单测，
 * 不挂 globalSetup、不碰端口和数据库，因此可以随时并行跑（`npm run backend:test:unit`）。
 *
 * 边界（重要）：
 * - 只是**新增**入口，`vitest.config.ts` / `vitest.worker.config.ts` 一字不改，四道门的收集语义不变。
 * - `exclude` 里 4 个文件是当前 `tests/unit/` 下会落盘建库、跑迁移或连真实 MySQL 的用例，
 *   它们随目录分层（`tests/lifecycle/`、`tests/integration/service/`）迁走后，本清单可整段删掉。
 * - 用例一旦要依赖 globalSetup 提供的东西（测试库 / 服务端口 / 管理员），就不该留在 `tests/unit/`。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        include: ["tests/unit/**/*.test.ts"],
        exclude: [
            "node_modules",
            // 跑全部 33 个迁移：真库 + 落盘临时库
            "tests/unit/service/dbMigrationService.test.ts",
            // 建临时 SQLite 文件验证迁移器底层 exec
            "tests/unit/db/sqliteDBAdapterExec.node.test.ts",
            // 连真实 MySQL 容器做引擎探活（只在 T7 本地 MySQL 门收集）
            "tests/unit/db/mysqlGateHeartbeat.mysql.test.ts",
            // 建临时目录 + 共享 SQLite 文件验证跨连接并发
            "tests/unit/service/rateLimitStore.crossIsolate.node.test.ts",
        ],
        environment: "node",
        pool: "forks",
        // 纯单元测试之间没有共享状态，放开并行才能做到秒级
        fileParallelism: true,
    },
});
