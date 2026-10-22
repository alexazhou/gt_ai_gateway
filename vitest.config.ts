import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules'],
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
      // 覆盖率门禁（P2-21）：先按"略低于当前实测值"的棘轮地板卡住回退，
      // 实测基线 58.37% lines / 58.41% stmts / 54.83% branch / 60.57% funcs，
      // 目标是把 lines 逐步抬到 60%+（入口文件 src/index.ts、src/local.ts 目前为 0%）。
      thresholds: {
        statements: 55,
        branches: 50,
        functions: 55,
        lines: 55,
      },
    },
    hookTimeout: 60000,
  },
})
