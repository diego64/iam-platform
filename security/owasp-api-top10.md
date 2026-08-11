# OWASP API Security Top 10 (2023) — controle e prova

Cada item aponta o controle que o endereça e o teste que prova que ele está ligado.
`tests/contract/documentos-seguranca.test.ts` verifica que todo caminho citado existe.

Item marcado **Lacuna** não tem cobertura completa. A marcação é deliberada: um item
declarado coberto sem estar é pior que um item declarado em aberto, porque ninguém volta
para olhar.

---

## API1 — Broken Object Level Authorization

**Controle:** política por atributo com verificação de propriedade, avaliada por recurso e
não por rota. O identificador vindo do cliente nunca é suficiente para autorizar.

**Testes:**

- `tests/integration/abac/ownership.test.ts`
- `tests/unit/modules/abac/policy-engine.test.ts`

## API2 — Broken Authentication

**Controle:** senha com scrypt de custo alto e sal por usuário; erro de login genérico com
tempo equalizado; segundo fator com teto de tentativas; token assinado em EdDSA com
verificação de algoritmo fixa; revogação por identificador de token com falha fechada.

**Testes:**

- `tests/unit/modules/auth/auth.service.test.ts`
- `tests/unit/modules/auth/verify-access-token.test.ts`
- `tests/unit/shared/crypto/password.service.test.ts`
- `tests/unit/modules/mfa/mfa-challenge.service.test.ts`

## API3 — Broken Object Property Level Authorization

**Controle:** corpo validado com esquema estrito — campo não previsto reprova, em vez de
ser ignorado ou atribuído. Resposta montada por objeto de transferência explícito, nunca
serializando a entidade inteira.

**Testes:**

- `tests/unit/modules/users/user.schema.test.ts`
- `tests/unit/modules/users/user.dto.test.ts`

## API4 — Unrestricted Resource Consumption

**Controle:** limite de requisição em três dimensões (endereço, conta, cliente) com contador
compartilhado entre réplicas; teto de corpo, de tempo de requisição, de conexão ociosa e de
comprimento de parâmetro.

**Testes:**

- `tests/integration/rate-limit/dimensoes.test.ts`
- `tests/integration/rate-limit/compartilhado.test.ts`
- `tests/integration/app/limites.test.ts`

## API5 — Broken Function Level Authorization

**Controle:** guard por permissão com falha fechada — permissão não resolvida recusa. A
atribuição de papel é restrita e verificada no serviço, não só na rota.

**Testes:**

- `tests/unit/modules/rbac/require-permission.test.ts`
- `tests/unit/modules/rbac/assignment.service.test.ts`
- `tests/contract/permissoes.test.ts`

## API6 — Unrestricted Access to Sensitive Business Flows

**Lacuna parcial.** Os fluxos sensíveis (login, troca de senha, emissão de token, verificação
de segundo fator) têm teto por conta e por cliente, e a detecção de força bruta e de teste de
credencial em massa está ligada. O que **não** existe é prova de humanidade nem análise de
comportamento — um adversário com muitas contas e ritmo abaixo do teto não é barrado.

Aceito para um provedor de identidade de uso interno. Reavaliar se a plataforma passar a
aceitar cadastro público.

**Testes:**

- `tests/integration/security-events/deteccao.test.ts`
- `tests/unit/modules/security-events/detector.test.ts`

## API7 — Server Side Request Forgery

**Controle:** a aplicação não busca recurso em endereço fornecido pelo cliente. A única saída
HTTP é o transporte de notificação, cujo destino vem de configuração validada no boot e nunca
do corpo de uma requisição.

**Testes:**

- `tests/unit/modules/notifications/transportes.test.ts`
- `tests/unit/config/env.test.ts`

## API8 — Security Misconfiguration

**Controle:** política de cabeçalhos escrita por extenso e verificada contra toda rota
servida; origem de navegador fechada por default; documentação interativa ausente em
produção; configuração validada no boot, que falha em vez de assumir default.

**Testes:**

- `tests/contract/cabecalhos-seguranca.contract.test.ts`
- `tests/integration/app/cabecalhos.test.ts`
- `tests/integration/app/montagem.test.ts`
- `tests/integration/app/swagger-exposicao.test.ts`
- `tests/integration/config/env-example.test.ts`

## API9 — Improper Inventory Management

**Controle:** contrato bidirecional entre o que o processo serve e o que o documento
descreve — falha nos dois sentidos. Inventário de rotas registrado no boot. Canal de
divulgação publicado na própria superfície HTTP.

**Testes:**

- `tests/contract/rotas-montadas.contract.test.ts`
- `tests/integration/app/security-txt.test.ts`
- `tests/integration/server/bootstrap.test.ts`

## API10 — Unsafe Consumption of APIs

**Controle:** a aplicação consome PostgreSQL, MongoDB e, opcionalmente, um transporte de
notificação. Não há consumo de API de terceiro cuja resposta alimente decisão de segurança.
A resposta do transporte de notificação é tratada como não confiável: só o sucesso ou falha
do envio é observado, nada dela é interpretado.

**Testes:**

- `tests/unit/modules/notifications/transportes.test.ts`
- `tests/unit/modules/notifications/canal-de-email.test.ts`

---

## Resumo

| Item                                       | Situação                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| API1 — Object Level Authorization          | Coberto                                                                 |
| API2 — Authentication                      | Coberto                                                                 |
| API3 — Object Property Level Authorization | Coberto                                                                 |
| API4 — Resource Consumption                | Coberto                                                                 |
| API5 — Function Level Authorization        | Coberto                                                                 |
| API6 — Sensitive Business Flows            | **Lacuna parcial** — sem prova de humanidade nem análise comportamental |
| API7 — SSRF                                | Coberto (superfície mínima)                                             |
| API8 — Security Misconfiguration           | Coberto                                                                 |
| API9 — Inventory Management                | Coberto                                                                 |
| API10 — Unsafe Consumption                 | Coberto (superfície mínima)                                             |
