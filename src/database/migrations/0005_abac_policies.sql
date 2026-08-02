-- SPEC 004 — ABAC: tabela de políticas, permissões que governam sua administração e a
-- política de sistema de posse. Toda instrução é idempotente (IF NOT EXISTS / ON CONFLICT),
-- para o migrate poder reaplicar sem erro e para o seed nunca duplicar.

CREATE TABLE IF NOT EXISTS policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  effect        TEXT NOT NULL CHECK (effect IN ('permit', 'deny')),
  resource_type TEXT NOT NULL,               -- 'user', 'session', … ou '*'
  action        TEXT NOT NULL,               -- 'read', 'delete', … ou '*'
  condition     JSONB NOT NULL,              -- árvore de condição na gramática fechada
  priority      INT NOT NULL DEFAULT 0,      -- só ordena a política decisiva; não muda o veredito
  enabled       BOOLEAN NOT NULL DEFAULT true,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- O PDP seleciona por (resource_type, action) a cada decisão e só enxerga políticas ligadas;
-- o índice parcial mantém fora da árvore tudo que está desabilitado.
CREATE INDEX IF NOT EXISTS idx_policies_target
  ON policies (resource_type, action) WHERE enabled;

-- Permissões que governam a administração das próprias políticas, no mesmo formato
-- recurso:acao do RBAC. O superadmin as recebe via o curinga `*` que já possui; o vínculo
-- explícito abaixo existe para quem inspeciona role_permissions e para papéis derivados.
INSERT INTO permissions (name, is_system) VALUES
  ('policies:read', true),
  ('policies:write', true),
  ('policies:delete', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.name = 'superadmin'
   AND p.name IN ('policies:read', 'policies:write', 'policies:delete')
ON CONFLICT DO NOTHING;

-- Posse: o sujeito age sobre o recurso cujo owner_id é ele mesmo. resource_type/action `*`
-- porque a regra vale para qualquer recurso self-service que declare owner_id ao carregar.
-- `value` como {"ref": …} compara dois atributos do contexto, não um literal.
INSERT INTO policies (name, description, effect, resource_type, action, condition, is_system)
VALUES (
  'system-ownership',
  'Permite ao dono agir sobre o próprio recurso',
  'permit', '*', '*',
  '{"op":"eq","attr":"resource.owner_id","value":{"ref":"subject.sub"}}'::jsonb,
  true
)
ON CONFLICT (name) DO NOTHING;

-- Sem esta, ligar o ABAC num endpoint administrativo tiraria o acesso de quem administra:
-- a posse nega todo mundo que não seja o dono, inclusive o superadministrador. O ABAC é
-- aditivo ao RBAC — passa quem é dono OU quem carrega o curinga de superadministração.
-- A checagem é sobre a claim `perm` do token, o mesmo atributo que o guard do RBAC lê.
INSERT INTO policies (name, description, effect, resource_type, action, condition, is_system)
VALUES (
  'system-privilege-override',
  'Permite a quem carrega o curinga de superadministração',
  'permit', '*', '*',
  '{"op":"contains","attr":"subject.perm","value":"*"}'::jsonb,
  true
)
ON CONFLICT (name) DO NOTHING;
