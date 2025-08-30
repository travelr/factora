// rollup.config.ts

// A helper function to safely resolve modules with different export styles.
// This is the key to fixing the ".default is not a function" errors.
const interopDefault = (m) => (m && m.default) || m;

// --- Plugin Imports ---
const peerDepsExternal = interopDefault(
  require('rollup-plugin-peer-deps-external'),
);
const resolve = interopDefault(require('@rollup/plugin-node-resolve'));
const commonjs = interopDefault(require('@rollup/plugin-commonjs'));
const typescript = interopDefault(require('@rollup/plugin-typescript'));
const terser = interopDefault(require('@rollup/plugin-terser'));
const dts = interopDefault(require('rollup-plugin-dts'));

// --- Package.json Import ---
const packageJson = require('./package.json');

/**
 * @type {import('rollup').RollupOptions[]}
 */
const config = [
  // --- Main JavaScript/TypeScript Bundle ---
  {
    input: 'src/index.ts',
    output: [
      {
        file: packageJson.main,
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      {
        file: packageJson.module,
        format: 'esm',
        sourcemap: true,
      },
    ],
    plugins: [
      peerDepsExternal(),
      resolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        exclude: ['**/__tests__', '**/*.test.ts'],
      }),
      terser(), // Minifies the output
    ],
    // Explicitly list peer dependencies as external to be safe
    external: ['react', 'react-dom', 'zustand'],
  },

  // --- TypeScript Declaration (.d.ts) Bundle ---
  {
    input: 'dist/types/index.d.ts',
    output: [{ file: 'dist/index.d.ts', format: 'esm' }],
    plugins: [dts()],
  },
];

module.exports = config;
