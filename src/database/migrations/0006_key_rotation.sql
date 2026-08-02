-- Rotação de chaves de assinatura: a coluna que materializa o fim da vida útil de uma
-- chave, a invariante de uma única chave pré-publicada e as permissões que governam a
-- administração. Toda instrução é idempotente (IF NOT EXISTS / ON CONFLICT), para o migrate
-- poder reaplicar sem erro.

-- Instante em que a chave deixa de verificar tokens. NULL enquanto ela não foi aposentada.
--
-- Materializar o instante, em vez de calcular `retired_at + janela_de_graca` na consulta,
-- é o que permite encerrar uma chave comprometida na hora: revogar vira gravar `now()`
-- nesta coluna, o mesmo UPDATE da aposentadoria normal. Com o cálculo na consulta, mudar a
-- janela de graça mudaria retroativamente a validade de todas as chaves já aposentadas.
ALTER TABLE jwks ADD COLUMN IF NOT EXISTS verifiable_until TIMESTAMPTZ;

-- Espelha jwks_one_active: no máximo uma chave pré-publicada por vez, para que a promoção
-- nunca tenha que escolher entre duas candidatas.
CREATE UNIQUE INDEX IF NOT EXISTS jwks_one_next ON jwks (status) WHERE status = 'next';

-- A consulta do conjunto de verificação (caminho quente) e a varredura da purga passam
-- por aqui.
CREATE INDEX IF NOT EXISTS idx_jwks_verifiable ON jwks (status, verifiable_until);

-- Backfill das chaves aposentadas antes desta migração: a graça delas era contada a partir
-- de retired_at com a janela padrão de 15 minutos, o mesmo TTL do access token.
UPDATE jwks
   SET verifiable_until = retired_at + interval '15 minutes'
 WHERE status = 'retired'
   AND verifiable_until IS NULL
   AND retired_at IS NOT NULL;

-- Permissões que governam a administração das chaves, no mesmo formato recurso:acao do
-- RBAC. O superadmin as recebe via o curinga `*` que já possui; o vínculo explícito abaixo
-- existe para quem inspeciona role_permissions e para papéis derivados.
--
-- Revogar uma chave não aparece aqui de propósito: derrubar todos os tokens emitidos por
-- uma chave invalida sessões de todos os usuários de uma vez, então a rota de revogação
-- checa o papel `superadmin`, não uma permissão delegável.
INSERT INTO permissions (name, description, is_system) VALUES
  ('keys:read',  'Listar metadados de chaves de assinatura', true),
  ('keys:write', 'Preparar e promover chaves de assinatura', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.name = 'superadmin'
   AND p.name IN ('keys:read', 'keys:write')
ON CONFLICT DO NOTHING;
