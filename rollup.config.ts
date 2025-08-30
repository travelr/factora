/**
 * @fileoverview Rollup configuration for building the Factora library.
 *
 * This configuration is designed to produce a professional-grade JavaScript library
 * with the following features:
 *
 * 1.  **Multi-Entry Points:** Creates separate, independent bundles for core
 *     library (`index`, `pure`) and each adapter (`adapter/axios`, etc.) to enable
 *     optimal tree-shaking.
 *
 * 2.  **Dual Module Formats (CJS & ESM):** Generates both CommonJS (.js) and
 *     ESM (.mjs) bundles for each entry point, ensuring compatibility across
 *     Node.js, Webpack, Vite, and other modern tooling.
 *
 * 3.  **Bundled Type Definitions:** Uses a two-step process to generate clean,
 *     bundled TypeScript declaration files (.d.ts) with proper directory structure.
 *
 * 4.  **Peer Dependency Handling:** Correctly treats peer dependencies (`react`,
 *     `zustand`, `axios`, `loglevel`) as external to prevent bundling issues.
 *
 * Why this works:
 * - Keeps your original, proven DTS approach with alias plugin
 * - Only fixes the del plugin import issue
 * - Preserves the working directory structure
 * - Maintains compatibility with --bundleConfigAsCjs
 */

// --- Plugin Imports (CommonJS-compatible) ---
const peerDepsExternal = require('rollup-plugin-peer-deps-external');
const resolve = require('@rollup/plugin-node-resolve').default;
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const terser = require('@rollup/plugin-terser');
// Fixed import for rollup-plugin-dts (must use default export)
const dts =
  require('rollup-plugin-dts').default || require('rollup-plugin-dts');
// Fixed import for rollup-plugin-delete (CommonJS compatibility)
const delPlugin = require('rollup-plugin-delete');
const del =
  typeof delPlugin === 'function' ? delPlugin : delPlugin.default || delPlugin;
const alias = require('@rollup/plugin-alias');
const path = require('path');

const packageJson = require('./package.json');

// --- Entry Point Strategy ---
// Maps public API surface to source files. Must match "exports" in package.json.
const entryPoints = {
  index: 'src/index.ts',
  pure: 'src/pure.ts',
  'adapter/axios': 'src/adapter/axios.ts',
  'adapter/loglevel': 'src/adapter/loglevel.ts',
};

/**
 * @type {import('rollup').RollupOptions[]}
 */
const config = [
  // --- STEP 1: Main JavaScript/TypeScript Bundles ---
  {
    input: entryPoints,
    output: [
      // CommonJS output for Node.js and legacy bundlers
      {
        dir: 'dist',
        entryFileNames: '[name].js',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      // ESM output for modern tooling (Vite, Webpack 5+)
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
        declarationDir: 'dist/types_temp', // Keep original approach
        rootDir: 'src',
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
    ],
    // Keep external dependencies consistent
    external: ['react', 'zustand', 'axios', 'loglevel'],
  },
];

module.exports = config;
