# Observabilidade

O que o serviço publica, como sair de um log para o trace correspondente, e como desligar
tudo. A stack de coleta sobe com `pnpm infra:monitoring` — Collector OTel, Prometheus,
Loki, Tempo e Grafana, com datasources já provisionados.

> `/metrics` expõe topologia, nomes de rota e volume de tráfego. **Não deve ser público.**
> Em produção o endpoint recusa requisição vinda do proxy externo, e abrir exige
> `METRICS_PUBLIC=true` — uma decisão registrada na configuração, não um default herdado.

## Métricas expostas

`GET /metrics`, formato de exposição do Prometheus, sem autenticação em rede interna.

| Métrica                                | Tipo       | Rótulos                             | Responde                                 |
| -------------------------------------- | ---------- | ----------------------------------- | ---------------------------------------- |
| `iam_build_info`                       | gauge (=1) | `version`, `commit`, `node_version` | Qual versão exatamente estava rodando    |
| `iam_http_request_duration_seconds`    | histogram  | `method`, `route`, `status_code`    | Latência por rota — base de qualquer SLO |
| `iam_http_requests_total`              | counter    | `method`, `route`, `status_code`    | Taxa de tráfego e proporção de erro      |
| `iam_readiness_transitions_total`      | counter    | `dependencia`, `para`               | Com que frequência cada dependência cai  |
| `iam_readiness_check_duration_seconds` | histogram  | `dependencia`                       | Dependência degradando antes de cair     |

`iam_build_info` é publicado antes de qualquer outra série. A ausência dela no Prometheus
é sinal claro de serviço não instrumentado — em vez do silêncio ambíguo de um alvo que
responde 200 sem série nenhuma.

### O que nunca vira rótulo

Lista fechada, verificada por `tests/contract/rotulos.test.ts`: nada de id de usuário,
e-mail, token, hash, IP, string de conexão ou caminho bruto de URL.

`route` é sempre o **template** registrado no Fastify. `/users/42` aparece como
`/users/:id`; requisição que não casou com rota nenhuma usa o literal `desconhecida`.
Usar o caminho recebido criaria uma série por usuário — e daria a quem chama o poder de
criar séries no Prometheus até derrubá-lo. Rótulo é retido por meses: dado sensível que
entra ali não sai por expiração de sessão nem por revogação de token.

### Rotas fora da conta

`/health/live`, `/health/ready` e `/metrics` não geram métrica de requisição nem trace. A
sonda bate a cada poucos segundos e o Prometheus raspa a cada 15 s: incluí-las faria o p95
descrever o health check, não o serviço.

## De um log para o trace

Todo log emitido dentro de uma requisição carrega `trace_id` e `span_id`:

```json
{
  "level": 30,
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "msg": "login.sucesso"
}
```

No Grafana, a partir da linha do Loki, o `trace_id` abre o trace no Tempo. Sem esse
campo a investigação vira correlação manual por horário — exatamente o trabalho que a
observabilidade deveria eliminar.

Fora de requisição (bootstrap, tarefa agendada) os campos **não aparecem**, em vez de
virem nulos e fazerem o Loki indexar um valor que não aponta para trace nenhum.

## Traces

Instrumentação automática de Fastify, `pg` e `mongodb`: uma requisição que consulta os
dois bancos produz spans encadeados sob um único trace. Exportação via OTLP para o
Collector, em lote e fora do caminho da requisição.

`db.connection_string` e `db.user` — que a instrumentação acrescenta sozinha, com host,
porta e nome do banco — são removidos antes da exportação.

Amostragem por `parentbased_traceidratio`. `OTEL_TRACES_SAMPLER_ARG=0.1` em produção
(amostrar tudo é caro e não responde nada a mais), `1` em desenvolvimento, onde o volume
é irrelevante e ver todo trace é o ponto.

## Configuração

| Variável                      | Default        | Papel                                        |
| ----------------------------- | -------------- | -------------------------------------------- |
| `METRICS_ENABLED`             | `true`         | Registra `/metrics` e sobe o exportador      |
| `METRICS_PUBLIC`              | `false`        | Libera `/metrics` fora de rede interna       |
| `OTEL_SERVICE_NAME`           | `iam-platform` | `service.name` no recurso                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —              | Ausente desliga o pipeline de traces         |
| `OTEL_TRACES_SAMPLER_ARG`     | `0.1`          | Proporção de traces amostrada                |
| `GIT_COMMIT`                  | `desconhecido` | Rótulo de `iam_build_info`, injetado pelo CD |

`METRICS_ENABLED` aceita `false`, `0`, `no`, `off` e vazio como desligado. A coerção é
explícita porque `Boolean('false')` é `true`: com a coerção padrão do Zod, a variável de
desligar ligaria as métricas — e o sintoma de "desligado" é ausência de dado, que ninguém
nota.

### Desligar a telemetria

```bash
METRICS_ENABLED=false            # /metrics deixa de existir (404) e nenhum exportador sobe
unset OTEL_EXPORTER_OTLP_ENDPOINT  # pipeline de traces não sobe
```

Nenhuma alteração de código é necessária. O ambiente de teste roda sem telemetria por
padrão: instrumentar teste unitário adiciona ruído e lentidão sem retorno.

## Garantias operacionais

- **Collector fora não derruba nem atrasa nada.** A exportação é assíncrona e em lote; com
  o coletor inalcançável o buffer descarta e a aplicação segue. Telemetria é diagnóstico,
  não função — derrubar o serviço porque o Collector caiu inverteria a prioridade.
- **Falha de exportação é logada agregada**, uma linha por minuto (`telemetria.exportacao_falhou`),
  nunca por span: um Collector fora geraria milhares de linhas idênticas e enterraria o
  resto do log durante o incidente.
- **`SIGTERM` descarrega o buffer** depois de drenar as requisições e antes de fechar os
  bancos. Sem isso, os spans do minuto em que algo deu errado morreriam com o processo.

## Verificação

```bash
curl -s http://localhost:3000/metrics | head -20
curl -s http://localhost:3000/metrics | grep -c '^iam_'   # cardinalidade

pnpm infra:monitoring                     # stack de coleta
pnpm test:integration                     # inclui traces e métricas de prontidão

# Sobrecarga da instrumentação (RNF-01) — exige as duas instâncias no ar
METRICS_ENABLED=false PORT=3002 pnpm start
METRICS_ENABLED=true  PORT=3000 pnpm start
k6 run tests/performance/k6/telemetria.js
```

Os testes de integração de trace e o e2e exigem a stack no ar. Sem ela são **pulados com
motivo explícito**, nunca reportados como sucesso: um teste de observabilidade que passa
sem coletor é o tipo de verde que esconde ausência de dado.
