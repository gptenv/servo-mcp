import { defineConfig } from 'vitest/config';
import { assetShimPlugin } from './test/helpers/vite-assets.ts';

export default defineConfig({
  plugins: [assetShimPlugin()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/assets.d.ts', 'src/browser-widget.html', 'test/setup.ts'],
      all: true,
      thresholds: { lines: 100, functions: 100, statements: 100 },
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
