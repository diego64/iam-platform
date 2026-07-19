/**
 * Responsabilidade: aplicar migrations SQL de src/database/migrations em ordem,
 * registrando em schema_migrations; suportar --dry-run (valida sem aplicar).
 * Regras: transação por migration; idempotente; saída clara por arquivo aplicado/pulado.
 */
