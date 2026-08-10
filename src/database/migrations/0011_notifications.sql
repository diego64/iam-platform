-- SPEC 019 — Notifications: a permissão de disparar a mensagem de teste de entrega.
-- Não há tabela. Nada desta SPEC persiste no PostgreSQL: o destinatário é lido de `users`,
-- o dispositivo já visto vive no MongoDB com TTL, e o envio não é registrado — o que saiu
-- está no log estruturado e nas métricas.
-- Idempotente (ON CONFLICT), para o migrate poder reaplicar sem erro.

-- Disparar a mensagem de teste gasta cota do provedor e manda e-mail de verdade para os
-- endereços de operação. Não expõe dado de usuário, mas é uma ação que sai da plataforma
-- para a rede — e ação que sai não fica sem dono.
INSERT INTO permissions (name, description, is_system) VALUES
  ('notifications:send', 'Disparar a mensagem de teste de entrega', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.name = 'superadmin' AND p.name = 'notifications:send'
ON CONFLICT DO NOTHING;
