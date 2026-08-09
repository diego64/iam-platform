-- SPEC 014 — Security Events: a permissão de leitura dos eventos detectados.
-- Não há tabela: o evento de segurança vive no MongoDB, com TTL. O que entra no PostgreSQL
-- é só a autoridade para lê-lo, que pertence ao catálogo do RBAC.
-- Idempotente (ON CONFLICT), para o migrate poder reaplicar sem erro.

-- Ler eventos de segurança é ver o mapa de quem está sob ataque na plataforma. Não expõe
-- identidade (o sujeito é sempre uma pista anonimizada), mas expõe alvo e volume — o
-- suficiente para orientar quem já está atacando.
INSERT INTO permissions (name, description, is_system) VALUES
  ('security:read', 'Ler os eventos de segurança detectados', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.name = 'superadmin' AND p.name = 'security:read'
ON CONFLICT DO NOTHING;
