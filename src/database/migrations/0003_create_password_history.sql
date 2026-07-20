-- SPEC 009 — histórico de hashes de senha para bloqueio de reuso (RF-12).
-- Guarda apenas hashes (formato scrypt$...), nunca a senha em claro. A coluna
-- users.password_hash guarda a senha corrente; esta tabela guarda as anteriores.
CREATE TABLE IF NOT EXISTS password_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A checagem de reuso lê as últimas N linhas de um usuário, ordenadas por tempo desc.
CREATE INDEX IF NOT EXISTS idx_password_history_user
  ON password_history (user_id, created_at DESC);
