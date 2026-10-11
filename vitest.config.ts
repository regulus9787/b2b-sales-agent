import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // 强制 Mock 模式 + 清空 API Key：测试绝不调用真实 LLM（省钱、稳定、快）
    setupFiles: ['./tests/setup.ts'],
    env: {
      LLM_API_KEY: '',
      LLM_PROVIDER: 'mock',
      LOG_LEVEL: 'silent',
    },
    reporters: ['default'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // better-sqlite3 是同步原生模块：使用 fork 池（每进程独立），避免线程池与非主线程 native 清理冲突
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // 串行执行测试文件，避免多个进程同时打开/关闭 SQLite 文件
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/services/**/*.ts', 'src/core/**/*.ts', 'src/harness/**/*.ts', 'src/db/**/*.ts'],
      exclude: ['src/db/init-db.ts', 'src/db/seed.ts', 'src/harness/run-cli.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
