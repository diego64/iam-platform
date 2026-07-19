// ESLint 9 flat config — TypeScript strict
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      'no-console': 'error',
    },
  },
  // src/config/env.ts é o único ponto de leitura de process.env (SPEC 021, design.md §4).
  // Qualquer outro módulo consome a configuração já validada via `import { env }`.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    ignores: ['src/config/env.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Use `import { env } from "@config/env.js"` — process.env só em src/config/env.ts.',
        },
      ],
    },
  },

  // Scripts k6 (runtime Goja) e bootstrap do mongosh rodam fora do Node e fora do projeto
  // TypeScript — não podem ser analisados pelas regras type-checked.
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'tests/performance/k6/',
      'infra/',
      '*.config.js',
      '*.config.ts',
    ],
  },
);
