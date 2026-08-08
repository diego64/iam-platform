-- SPEC 010 — MFA: fator TOTP por usuário e códigos de recuperação.
-- Toda instrução é idempotente (IF NOT EXISTS / ON CONFLICT), para o migrate poder
-- reaplicar sem erro.

CREATE TABLE IF NOT EXISTS user_mfa_factors (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL DEFAULT 'totp' CHECK (type IN ('totp')),
  -- Blob do envelope AES-256-GCM (`salt||iv||tag||ciphertext`). É cifra, e não hash,
  -- porque a verificação precisa do segredo em claro para recalcular o código.
  secret_encrypted BYTEA NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
  label            TEXT,
  -- Último passo de tempo aceito. O anti-replay da RFC 6238 §5.2 exige passo estritamente
  -- maior, o que invalida o código já usado mesmo dentro da janela de tolerância.
  last_step        BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  -- Ativo tem confirmação; pendente não tem. O banco é a última barreira contra um fator
  -- que protegeria a conta sem nunca ter provado posse do dispositivo.
  CONSTRAINT user_mfa_factors_confirmacao_coerente CHECK (
    (status = 'active') = (confirmed_at IS NOT NULL)
  )
);

-- Um ativo e no máximo um pendente por usuário/tipo. Índice parcial, e não UNIQUE simples,
-- porque um cadastro reiniciado precisa coexistir com o fator ativo que ainda protege a conta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mfa_factors_ativo
  ON user_mfa_factors (user_id, type) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mfa_factors_pendente
  ON user_mfa_factors (user_id, type) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 do código canônico, em hex. Sem sal: 120 bits de entropia não são senha de
  -- baixa entropia, e o índice único é o que dá busca O(1) na verificação.
  code_hash  TEXT NOT NULL UNIQUE,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Caminho quente: contar e consumir os códigos ainda válidos de um usuário.
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_validos
  ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- Remover o segundo fator de outra pessoa é operação de privilégio: é a saída para conta
-- travada e, ao mesmo tempo, o caminho que um atacante usaria para derrubar a proteção.
INSERT INTO permissions (name, description, is_system) VALUES
  ('mfa:reset', 'Remover o segundo fator de um usuário travado', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.name = 'superadmin' AND p.name = 'mfa:reset'
ON CONFLICT DO NOTHING;
