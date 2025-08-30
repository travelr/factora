/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [
    // Point the plugin to your test-specific tsconfig
    tsconfigPaths({ projects: ['./tsconfig.test.json'] }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: 'tests/vitest.setup.ts',
  },
});
