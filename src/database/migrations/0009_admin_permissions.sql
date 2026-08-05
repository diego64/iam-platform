-- Painel administrativo: permissões das visões agregadas e da administração de sessões.
-- Nenhuma tabela nova — o painel lê o que os outros módulos já escrevem.
--
-- As permissões não são associadas a papel nenhum aqui: quem distribui privilégio é o
-- superadmin, pelos endpoints de atribuição de papel e de associação de permissão. Semear
-- um vínculo seria conceder acesso administrativo por migração, sem ninguém decidir.

INSERT INTO permissions (name, description, is_system) VALUES
  ('admin:read',      'Ler as visões administrativas agregadas', true),
  ('sessions:read',   'Listar as sessões de qualquer usuário',   true),
  ('sessions:revoke', 'Revogar as sessões de qualquer usuário',  true)
ON CONFLICT (name) DO NOTHING;
