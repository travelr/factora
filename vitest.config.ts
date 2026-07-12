/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@/types': fileURLToPath(new URL('./src/types', import.meta.url)),
      '@adapter': fileURLToPath(new URL('./src/adapter', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@test-helper': fileURLToPath(new URL('./tests/helper', import.meta.url)),
      '@test-utils': fileURLToPath(new URL('./tests/utils', import.meta.url)),
      '@utils': fileURLToPath(new URL('./src/utils', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: 'tests/vitest.setup.ts',
    coverage: {
      thresholds: {
        statements: 89,
        branches: 81,
        functions: 87,
        lines: 90,
      },
    },
  },
});
