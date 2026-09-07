import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    env: { NODE_ENV: 'test' },
    // Each file gets its own in-memory MongoDB; running them in parallel
    // would spawn one mongod per file and thrash the machine.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
