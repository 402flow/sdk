import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const tsconfigRootDir = import.meta.dirname;

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
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.typecheck.json'],
        tsconfigRootDir,
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': unusedVariablesRule,
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);