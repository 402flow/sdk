import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@402flow/sdk': path.resolve(currentDirectory, './src/index.ts'),
    },
  },
  test: {
    coverage: {
      enabled: false,
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.*', '**/test/**'],
      reportOnFailure: true,
    },
  },
});