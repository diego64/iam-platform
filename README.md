# iam-platform

Provedor de Identidade (IdP/SSO) próprio: emissão e validação de tokens para
microsserviços, no padrão Keycloak/Auth0 simplificado.

Node.js 22 · TypeScript strict · Fastify 5 · PostgreSQL (`pg`) · MongoDB (driver nativo) ·
JWT EdDSA via `jose`. Sem ORM, sem ODM — ver `docs/decisions/`.

## Começando

```bash
pnpm install                 # --frozen-lockfile em CI
cp .env.example .env         # preencha POSTGRES_URL e MONGODB_URL
cp infra/compose/.env.example infra/compose/.env
pnpm infra:up                # sobe PostgreSQL e MongoDB locais
pnpm dev                     # aplicação no host, com hot reload
```

A aplicação roda no host, não em container: hot reload instantâneo, breakpoints do
editor e sem bind mount de `node_modules` entre musl e glibc. `infra/docker/Dockerfile.dev`
existe apenas para reproduzir problema que só aparece dentro do container.

`GET /health/live` responde em `http://localhost:3000/health/live`;
a documentação interativa fica em `/docs`.

## Comandos

| Comando                        | O que faz                               |
| ------------------------------ | --------------------------------------- |
| `pnpm dev`                     | Aplicação com hot reload                |
| `pnpm build` / `pnpm start`    | Compila para `dist/` e roda o build     |
| `pnpm lint` · `pnpm typecheck` | Gates estáticos                         |
| `pnpm test`                    | Testes unitários                        |
| `pnpm test:integration`        | Integração — exige `pnpm infra:test:up` |
| `pnpm test:contract`           | Contrato contra `openapi/openapi.yaml`  |
| `pnpm test:coverage`           | Cobertura                               |
| `pnpm openapi:validate`        | Spectral sobre o OpenAPI                |

### Infraestrutura

| Comando                                       | O que faz                                         |
| --------------------------------------------- | ------------------------------------------------- |
| `pnpm infra:up` / `pnpm infra:down`           | Bancos de desenvolvimento (5432 / 27017)          |
| `pnpm infra:test:up` / `pnpm infra:test:down` | Bancos efêmeros de teste (55432 / 57017)          |
| `pnpm infra:monitoring`                       | Prometheus, Loki, Tempo, Grafana e Collector OTel |

Os ambientes de desenvolvimento e de teste usam portas diferentes de propósito: dá para
rodar a suíte com o ambiente de desenvolvimento no ar. Tudo é publicado só em `127.0.0.1`.

### Container

| Comando             | O que faz                                 |
| ------------------- | ----------------------------------------- |
| `pnpm docker:build` | Imagem de produção (`iam-platform:local`) |
| `pnpm docker:run`   | Roda a imagem com o `.env` local          |

A imagem roda como usuário não-root (`iam`), sem toolchain de compilação, com
`HEALTHCHECK` apontando para `/health/live`.

### Smoke de um ambiente publicado

```bash
./scripts/healthcheck.sh https://iam.example.com
```

Sai 0 apenas com HTTP 200 e corpo `"status":"ok"`, com retry e backoff exponencial.

## Configuração

Toda variável de ambiente está documentada em `.env.example`. A validação acontece no
boot (`src/config/env.ts`): faltando ou malformada qualquer obrigatória, o processo
sai com código 1 antes de abrir socket, listando o que corrigir. Ver
`docs/decisions/adr-0004-zod-config-boundary.md`.

## Observabilidade

`GET /metrics` em formato Prometheus, traces via OTLP e `trace_id` em todo log de
requisição. As métricas expostas, como abrir um trace a partir de um log e como desligar
a telemetria estão em [`docs/observabilidade.md`](docs/observabilidade.md).

> `/metrics` expõe topologia, nomes de rota e volume de tráfego — **não deve ser público**.
> Em produção o endpoint recusa requisição vinda do proxy externo; abrir exige
> `METRICS_PUBLIC=true`, uma decisão explícita na configuração.

## Entrega

O pipeline está documentado em [`docs/ci-cd.md`](docs/ci-cd.md), incluindo o runbook de
incidente. Em resumo:

| Etapa                    | Gatilho                                | Barreira                                |
| ------------------------ | -------------------------------------- | --------------------------------------- |
| Verificação              | pull request                           | checks verdes bloqueiam o merge         |
| Build, scan e assinatura | merge na `main`                        | automático                              |
| **Deploy em produção**   | manual                                 | **aprovação no Environment `producao`** |
| Rollback                 | manual ou automático em falha de smoke | aprovação                               |

Não há ambiente de homologação: o smoke em produção é a primeira execução do artefato
contra infraestrutura real, e a aprovação humana é a única barreira antes do tráfego.

## Contribuindo

Nenhum código é escrito sem SPEC aprovada. Gates obrigatórios antes de qualquer PR:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
```
