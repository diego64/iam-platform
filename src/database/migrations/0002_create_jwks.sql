-- SPEC 007 — armazenamento de chaves de assinatura
CREATE TABLE IF NOT EXISTS jwks (
  kid             UUID PRIMARY KEY,
  algorithm       TEXT NOT NULL DEFAULT 'EdDSA',
  public_jwk      JSONB NOT NULL,
  private_key_enc BYTEA NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','next','retired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at    TIMESTAMPTZ,
  retired_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS jwks_one_active ON jwks (status) WHERE status = 'active';
