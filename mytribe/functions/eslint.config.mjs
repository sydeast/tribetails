// Flat config (eslint 9+ removed .eslintrc support). Same rule set the old
// .eslintrc.cjs carried; typescript-eslint is the unified package that replaced
// the separate parser + plugin pair.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['lib/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Build-time tooling, not deployed code. `no-console` is here to keep
    // stray debug logging out of the functions, where the structured logger is
    // the only sanctioned output; a CLI's whole job is to report on stdout.
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
