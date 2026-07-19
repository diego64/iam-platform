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
