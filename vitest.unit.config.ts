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
 * - 依赖真实 MySQL 容器的用例（`*.mysql.test.ts`）一律不收：它们归 T7 本地 MySQL 门。
 * - 用例一旦要落盘建库、跑迁移，或依赖 globalSetup 提供的东西（测试库 / 服务端口 / 管理员），
 *   就不该留在 `tests/unit/` —— 这类用例已按目录分层迁到 `tests/lifecycle/` 与 `tests/integration/`。
 *   这里保留 mysql 的全局排除是为了保持本门的「不落盘 / 不建库」纯度：以后谁再往 `tests/unit/`
 *   放 `*.mysql.test.ts`，会被本门直接挡在外面，而不是先跑绿再发现它污染了磁盘。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        include: ["tests/unit/**/*.test.ts"],
        exclude: ["node_modules", "**/*.mysql.test.ts"],
        environment: "node",
        pool: "forks",
        // 纯单元测试之间没有共享状态，放开并行才能做到秒级
        fileParallelism: true,
    },
});
