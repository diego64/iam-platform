import { defineConfig } from 'vitest/config';

// Configuração base do Vitest — suites separadas por diretório via scripts do package.json
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/**/index.ts', 'src/**/types/**'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@config': new URL('./src/config', import.meta.url).pathname,
      '@modules': new URL('./src/modules', import.meta.url).pathname,
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@database': new URL('./src/database', import.meta.url).pathname,
    },
  },
});
