import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Disable parallel execution - run tests sequentially
    pool: 'threads',
    threads: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['node_modules', '**/*.test.ts', '**/*.spec.ts', 'tests/**'],
    },
    hookTimeout: 60000,
  },
})
