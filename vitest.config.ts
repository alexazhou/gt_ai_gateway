import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // `**/*.mysql.test.ts` 由 `vitest.mysql.config.ts`（T7 本地 MySQL 门）单独收集。
    // 放在这里排除是为了**不改变 sqlite 全量门的用例计数**（新增门是加法，不动既有门的语义）。
    exclude: ['node_modules', '**/*.mysql.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    // Run tests sequentially to avoid database and port conflicts
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['node_modules', '**/*.test.ts', '**/*.spec.ts', 'tests/**'],
      // 覆盖率门禁（P2-21）：地板已按「实测到 60% 再抬」的口径抬到 60。
      // 关键前提：API 用例跑在 spawn 出来的子进程里，V8 统计不到，所以真正的抓手是
      // 进程内 app.request() 用例（tests/api/inprocess/adminRoutes.test.ts、
      // tests/unit/entry/spaFallback.test.ts）——它们把 routes→middleware→controller→service
      // 主链路纳入统计后，实测从 57.9/53.5/60.5/57.8 提升到
      // 65.31 stmts / 57.45 branch / 68.28 funcs / 65.53 lines。
      // 地板取整到 60/52/60/60，留出余量，禁止为凑数字去硬盖入口文件。
      thresholds: {
        statements: 60,
        branches: 52,
        functions: 60,
        lines: 60,
      },
    },
    hookTimeout: 60000,
  },
})
