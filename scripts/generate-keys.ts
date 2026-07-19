/**
 * Responsabilidade: bootstrap do primeiro par Ed25519 — gera, cifra a privada (envelope AES-256-GCM)
 * e insere na tabela jwks com status active. Em dev, imprime as ENVs JWT_* em base64.
 * Regras: idempotente (não cria segunda chave active); jamais imprime a privada em produção.
 */
