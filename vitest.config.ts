import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/*.ts', 'src/agents/**/*.ts', 'src/workflows/**/*.ts', 'src/lib/**/*.ts', 'src/tools/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/lib/slo.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
