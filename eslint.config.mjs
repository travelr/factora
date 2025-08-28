import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import parser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import checkFile from 'eslint-plugin-check-file';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import promisePlugin from 'eslint-plugin-promise';
import arrayFunc from 'eslint-plugin-array-func';
import unusedImports from 'eslint-plugin-unused-imports';
import vitestPlugin from 'eslint-plugin-vitest';

export default [
  // Base recommended rules
  eslint.configs.recommended,
  arrayFunc.configs.recommended,

  // Core TypeScript and Plugin Configuration for Library Source
  ...tseslint.config({
    files: ['src/**/*.ts'], // Apply only to library source files
    languageOptions: {
      parser,
      parserOptions: {
        project: './tsconfig.json', // Use base tsconfig
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
      prettier: prettierPlugin,
      'simple-import-sort': simpleImportSort,
      'check-file': checkFile,
      'react-hooks': reactHooksPlugin,
      promise: promisePlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      // --- Formatting ---
      'prettier/prettier': 'error',
      'linebreak-style': ['error', 'unix'],

      // --- TypeScript ---
      '@typescript-eslint/no-unused-vars': 'off', // Handled by unused-imports
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn', // Warn instead of allowing `any` freely

      // --- Imports ---
      'import/first': 'error',
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'import/no-cycle': 'error',
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: false },
      ], // Strict for library code

      // --- Code Quality & Conventions ---
      'check-file/filename-naming-convention': [
        'error',
        { 'src/**/*.ts': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      'no-underscore-dangle': ['error', { allow: ['__test_only_apiRegistry'] }], // Allow specific test exports
      'no-console': 'error',
      'promise/always-return': 'error',
      'promise/catch-or-return': 'error',
    },
  }),

  // Configuration Overrides for Test Files
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/tests/**/*.{ts,tsx}',
    ],
    plugins: {
      vitest: vitestPlugin,
    },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
      // Allow importing from devDependencies in test files
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],

      // Relax rules that are often noisy in tests
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'off',
      'no-underscore-dangle': 'off',
      'promise/avoid-new': 'off',
    },
  },
];
