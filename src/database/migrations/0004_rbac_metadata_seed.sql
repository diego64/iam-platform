-- SPEC 003 — RBAC: metadados de papéis/permissões + seed idempotente.
-- As quatro tabelas de RBAC nascem na 0001; esta migração só acrescenta colunas de
-- metadado, o índice do join de permissões efetivas e o seed das permissões-base e do
-- papel superadmin. Toda instrução é idempotente (IF NOT EXISTS / ON CONFLICT), para o
-- migrate poder reaplicar sem erro e para o seed nunca duplicar.

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_system  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE permissions
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_system  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- O login expande papéis → permissões a cada emissão de token; sem este índice o join
-- varre role_permissions inteira. FK já cobre role_id? Não: FK não cria índice no
-- Postgres. Este é o índice do caminho quente.
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

-- Permissões-base desta SPEC. O curinga `*` (superadmin) não segue o formato recurso:acao
-- de propósito — ele é semeado aqui, nunca criado pela API (o schema Zod da rota o rejeita).
-- Vínculo usuário↔papel é operação exclusiva do superadmin, então não há permissões
-- user_roles:* — o guard dessas rotas checa o papel, não uma permissão.
INSERT INTO permissions (name, is_system) VALUES
  ('roles:read', true),
  ('roles:write', true),
  ('roles:delete', true),
  ('permissions:read', true),
  ('permissions:write', true),
  ('permissions:delete', true),
  ('*', true)
ON CONFLICT (name) DO NOTHING;

-- Papel superadmin imutável, dono do curinga. A atribuição dele ao primeiro admin é
-- bootstrap operacional (runbook), fora do escopo desta migração.
INSERT INTO roles (name, description, is_system)
  VALUES ('superadmin', 'Acesso total ao IAM', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.name = 'superadmin' AND p.name = '*'
ON CONFLICT DO NOTHING;
