import { defineConfig } from 'vitest/config';

// Configuração base do Vitest — suites separadas por diretório via scripts do package.json
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // server.ts é exercitado por tests/integration/server/bootstrap.test.ts (6 casos,
      // incluindo os caminhos de saída 1), mas via `spawn` de dist/server.js — o provider
      // v8 não instrumenta processo filho, então apareceria como 0% e derrubaria o gate.
      // Exclusão é artefato de medição, não ausência de teste.
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
