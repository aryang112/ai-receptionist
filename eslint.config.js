import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// Flat-config equivalent of the old .eslintrc.cjs:
//   root: true,
//   parser: '@typescript-eslint/parser',
//   plugins: ['@typescript-eslint'],
//   extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
//   env: { node: true, es2020: true },
//   rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
//   overrides: [{ files: ['src/tests/**', 'scripts/**'], rules: { '@typescript-eslint/no-non-null-assertion': 'off' } }]
//
// The old `eslint . --ext .ts` invocation only ever linted `.ts` files, so
// every rule block here is scoped to `**/*.ts` to match that exactly.
// Flat config's default file targets include `.js`/`.mjs`/`.cjs` even when
// no rule block's `files` pattern matches them (confirmed empirically: with
// only the dir ignores below, `eslint .` still parsed — and reported parse
// errors from — two unrelated `.mjs` scripts under tasks/). Ignoring those
// extensions here is what actually reproduces the old `--ext .ts` scope,
// not just cosmetic.
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'outputs/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2020,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // eslint:recommended
      ...js.configs.recommended.rules,
      // plugin:@typescript-eslint/recommended's own "eslintrc/eslint-recommended"
      // layer: disables base JS rules already covered by the TS compiler, and
      // turns on a couple of TS-appropriate stylistic rules.
      'constructor-super': 'off',
      'getter-return': 'off',
      'no-class-assign': 'off',
      'no-const-assign': 'off',
      'no-dupe-args': 'off',
      'no-dupe-class-members': 'off',
      'no-dupe-keys': 'off',
      'no-func-assign': 'off',
      'no-import-assign': 'off',
      'no-new-native-nonconstructor': 'off',
      'no-new-symbol': 'off',
      'no-obj-calls': 'off',
      'no-redeclare': 'off',
      'no-setter-return': 'off',
      'no-this-before-super': 'off',
      'no-undef': 'off',
      'no-unreachable': 'off',
      'no-unsafe-negation': 'off',
      'no-var': 'error',
      'no-with': 'off',
      'prefer-const': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      // plugin:@typescript-eslint/recommended's own rules
      ...tsPlugin.configs.recommended.rules,
      // This workstream's addition (2026-09-16)
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['src/tests/**', 'scripts/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
