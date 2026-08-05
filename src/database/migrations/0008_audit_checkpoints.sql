-- Auditoria: âncora da cadeia no PostgreSQL + permissões de leitura e verificação da trilha.
-- A trilha vive no Mongo, encadeada por hash. O encadeamento detecta edição e remoção no
-- MEIO da sequência, mas quem apaga os últimos eventos e reajusta o topo produz uma cadeia
-- internamente coerente. O checkpoint fica em OUTRO banco, com OUTRA credencial e em outro
-- backup: truncar além do último checkpoint passa a ser detectável.
-- Toda instrução é idempotente, para o migrate poder reaplicar sem erro.

CREATE TABLE IF NOT EXISTS audit_checkpoints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Posição do topo da cadeia no instante do checkpoint. UNIQUE porque gravar duas vezes a
  -- mesma posição é reexecução, não um segundo fato.
  seq        BIGINT      NOT NULL UNIQUE,
  hash       CHAR(64)    NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A consulta que importa é sempre "o checkpoint aplicável até esta posição", em ordem
-- decrescente e com LIMIT 1.
CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_seq ON audit_checkpoints (seq DESC);

-- Não são associadas a papel nenhum: quem distribui privilégio é o superadmin, pelos
-- endpoints de atribuição de papel e de associação de permissão.
INSERT INTO permissions (name, description, is_system) VALUES
  ('audit:read',   'Ler a trilha de auditoria', true),
  ('audit:verify', 'Verificar a integridade da trilha de auditoria', true)
ON CONFLICT (name) DO NOTHING;
