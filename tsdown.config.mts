import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    pure: 'src/pure.ts',
    'adapter/axios': 'src/adapter/axios.ts',
    'adapter/loglevel': 'src/adapter/loglevel.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'browser',
  target: 'es2020',
  fixedExtension: true,
  sourcemap: true,
  minify: true,
  dts: {
    oxc: true,
  },
  env: {
    NODE_ENV: 'production',
  },
  define: {
    'import.meta.hot': 'undefined',
  },
  deps: {
    neverBundle: ['react', 'zustand', 'axios', 'loglevel'],
  },
  publint: {
    level: 'error',
  },
  attw: {
    profile: 'node16',
    level: 'error',
  },
});
