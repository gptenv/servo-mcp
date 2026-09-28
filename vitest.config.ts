import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**', 'test/helpers/**'],
      exclude: ['src/assets.d.ts', 'test/setup.ts'],
      all: true,
      thresholds: { lines: 100, functions: 100, statements: 100 },
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
