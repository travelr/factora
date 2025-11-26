/**
 * @fileoverview Rollup configuration for building the Factora library.
 */

// @ts-expect-error: Missing type definitions for this plugin
import peerDepsExternal from 'rollup-plugin-peer-deps-external';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';
import del from 'rollup-plugin-delete';
import alias from '@rollup/plugin-alias';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// --- ESM Compatibility Setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read package.json manually
const packageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
);

// --- Entry Point Strategy ---
const entryPoints = {
  index: 'src/index.ts',
  pure: 'src/pure.ts',
  'adapter/axios': 'src/adapter/axios.ts',
  'adapter/loglevel': 'src/adapter/loglevel.ts',
};

/**
 * Use JSDoc for typing to avoid "import type" syntax errors
 * @type {import('rollup').RollupOptions[]}
 */
const config = [
  // --- STEP 1: Main JavaScript/TypeScript Bundles ---
  {
    input: entryPoints,
    output: [
      // CommonJS output
      {
        dir: 'dist',
        entryFileNames: '[name].js',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      // ESM output
      {
        dir: 'dist',
        entryFileNames: '[name].mjs',
        format: 'esm',
        sourcemap: true,
      },
    ],
    plugins: [
      // Clean dist directory BEFORE build to prevent stale files
      del({ targets: 'dist/*', runOnce: true }),

      // Automatically externalize peer dependencies (matches package.json)
      peerDepsExternal(),

      // Resolve third-party modules from node_modules
      resolve(),

      // Convert CommonJS modules to ESM
      commonjs(),

      // Transpile TypeScript with modern configuration
      typescript({
        tsconfig: './tsconfig.json',
        declaration: true,
        declarationDir: 'dist/types_temp',
        rootDir: 'src',
        sourceMap: true,
        exclude: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*', 'dist/**/*'],
      }),

      // Minify production bundles
      terser(),
    ],
    // Explicitly list peer dependencies as external
    external: ['react', 'zustand', 'axios', 'loglevel'],
  },

  // --- STEP 2: TypeScript Declaration Bundling ---
  {
    input: {
      index: 'dist/types_temp/index.d.ts',
      pure: 'dist/types_temp/pure.d.ts',
      'adapter/axios': 'dist/types_temp/adapter/axios.d.ts',
      'adapter/loglevel': 'dist/types_temp/adapter/loglevel.d.ts',
    },
    output: {
      // Keep original working structure
      dir: 'dist/types',
      entryFileNames: '[name].d.ts',
      format: 'esm',
    },
    plugins: [
      alias({
        entries: [
          // No trailing slashes needed - these are directory mappings
          {
            find: '@',
            replacement: path.resolve(__dirname, 'dist/types_temp'),
          },
          {
            find: '@core',
            replacement: path.resolve(__dirname, 'dist/types_temp/core'),
          },
          {
            find: '@adapter',
            replacement: path.resolve(__dirname, 'dist/types_temp/adapter'),
          },
          {
            find: '@/types',
            replacement: path.resolve(__dirname, 'dist/types_temp/types'),
          },
          {
            find: '@utils',
            replacement: path.resolve(__dirname, 'dist/types_temp/utils'),
          },
        ],
      }),

      // Use default export for dts plugin (works with --bundleConfigAsCjs)
      dts(),

      // Clean up the temp folder after the build is done
      del({ targets: 'dist/types_temp', hook: 'buildEnd' }),
    ],
    external: ['react', 'zustand', 'axios', 'loglevel'],
  },
];

export default config;
