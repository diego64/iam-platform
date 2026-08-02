-- Clientes de API: a segunda classe de identidade do IdP. Um serviço que fala com outro
-- não tem senha nem sessão — tem um par client_id/client_secret e um conjunto de escopos.
-- Toda instrução é idempotente (IF NOT EXISTS / ON CONFLICT), para o migrate poder
-- reaplicar sem erro.
--
-- O número 0007 deixa 0006 para a rotação de chaves, que entra antes pela ordem do roadmap.
-- As duas migrações são independentes: a ordem de aplicação entre elas não importa.

CREATE TABLE IF NOT EXISTS api_clients (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  TEXT NOT NULL UNIQUE,          -- 'cli_' + 22 chars base64url
  secret_hash                TEXT NOT NULL,                 -- scrypt$N$r$p$saltB64$hashB64
  -- Sobreposição de rotação: o segredo anterior continua aceito até expirar, para o
  -- cliente trocar sem uma janela em que as réplicas antigas já não autenticam.
  previous_secret_hash       TEXT,
  previous_secret_expires_at TIMESTAMPTZ,
  secret_rotated_at          TIMESTAMPTZ,
  name                       TEXT NOT NULL UNIQUE,
  description                TEXT,
  status                     TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'disabled', 'deleted')),
  grant_types                TEXT[] NOT NULL DEFAULT '{client_credentials}',
  access_token_ttl_seconds   INT CHECK (access_token_ttl_seconds BETWEEN 60 AND 3600),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at               TIMESTAMPTZ,
  deleted_at                 TIMESTAMPTZ,
  -- Só os três grants desta plataforma. A borda valida de novo; o banco é a última barreira.
  --
  -- `cardinality` e não `array_length`: para um array vazio, array_length devolve NULL, e um
  -- CHECK só reprova em FALSE — o cliente sem grant nenhum passaria direto. cardinality
  -- devolve 0, que reprova. O subconjunto sozinho também não barra: o conjunto vazio é
  -- subconjunto de qualquer coisa.
  CONSTRAINT api_clients_grant_types_validos CHECK (
    grant_types <@ ARRAY['client_credentials', 'password', 'refresh_token']::TEXT[]
    AND cardinality(grant_types) >= 1
  ),
  -- A sobreposição só existe com os dois campos preenchidos: um hash sem data de morte
  -- seria uma segunda via de autenticação permanente e invisível.
  CONSTRAINT api_clients_sobreposicao_coerente CHECK (
    (previous_secret_hash IS NULL) = (previous_secret_expires_at IS NULL)
  )
);

-- O escopo de um cliente é o nome de uma permissão do catálogo do RBAC, no mesmo formato
-- recurso:acao. Com isso o guard de autorização já existente autoriza um token de cliente
-- sem código novo, e o operador administra um vocabulário de autoridade só.
--
-- ON DELETE RESTRICT na permissão é deliberado: apagar uma permissão que ainda é escopo de
-- algum cliente derrubaria a autoridade dele em silêncio, e ele só descobriria na próxima
-- chamada negada. Falhar a remoção é o comportamento visível.
CREATE TABLE IF NOT EXISTS api_client_scopes (
  client_id     UUID NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  PRIMARY KEY (client_id, permission_id)
);

-- Caminho quente da autenticação: busca por client_id de cliente não removido.
CREATE INDEX IF NOT EXISTS idx_api_clients_ativos
  ON api_clients (client_id) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_api_client_scopes_client
  ON api_client_scopes (client_id);

-- Permissões que governam a administração dos clientes.
--
-- Criar cliente e alterar seus escopos não aparecem aqui: conceder escopo é conceder
-- privilégio, e quem pudesse editá-lo criaria um cliente com autoridade que ele próprio não
-- tem. Essas duas operações checam o papel `superadmin`. O que sobra — rotacionar segredo,
-- desabilitar, corrigir nome — é operação de incidente e precisa ser delegável.
INSERT INTO permissions (name, description, is_system) VALUES
  ('clients:read',   'Listar e inspecionar clientes de API', true),
  ('clients:write',  'Rotacionar segredo e alterar status de clientes', true),
  ('clients:delete', 'Remover clientes de API', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.name = 'superadmin'
   AND p.name IN ('clients:read', 'clients:write', 'clients:delete')
ON CONFLICT DO NOTHING;
