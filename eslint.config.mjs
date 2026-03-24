import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unusedVariablesRule = [
  'error',
  {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  },
];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
  {
    files: ['src/**/*.ts', '*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': unusedVariablesRule,
    },
  },
);