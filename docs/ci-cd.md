# Pipeline de entrega

Como o código sai de um pull request e chega ao tráfego, quem aprova o quê, e o que
fazer quando dá errado.

## Princípio

Um artefato só chega a produção depois de ter sido construído, escaneado, assinado e
verificado **na mesma identidade imutável** — o digest `sha256:...`. Tag é nome, e nome
pode mudar de dono; digest é o conteúdo. Toda etapa depois do build referencia o digest,
nunca a tag.

**Não há ambiente de homologação.** A consequência precisa ficar clara para quem opera:
o smoke em produção é a primeira vez que o artefato roda contra infraestrutura real. A
aprovação humana é a única barreira entre um merge e o tráfego.

## Fluxo

```
pull request
  └─ ci.yml: lint, typecheck, build, unit, integração, contrato, OpenAPI
     └─ security.yml (workflow_call): secret scan, dependency review, SAST,
        licenças, container scan, SBOM
     ⇒ qualquer falha bloqueia o merge

merge na main
  └─ cd.yml: build → trivy → cosign
     ⇒ publica digest e PARA. Nenhum deploy acontece aqui.

promoção (manual)
  └─ promote.yml: valida → [aprovação] → backup → deploy → smoke
     └─ smoke falha ⇒ rollback.yml automático para o digest anterior

semanalmente
  └─ rollback-drill.yml: reverte e volta, provando que a reversão funciona
```

## Quem aprova o quê

| Ação                     | Barreira                                    |
| ------------------------ | ------------------------------------------- |
| Merge na `main`          | Revisão de PR + checks verdes               |
| Build, scan e assinatura | Automático, sem aprovação                   |
| **Deploy em produção**   | **Aprovação no Environment `producao`**     |
| Rollback                 | Aprovação no Environment `producao`         |
| Ensaio de rollback       | Aprovação + confirmação explícita `ENSAIAR` |

Os secrets de banco, do Render e da URL pública existem **apenas** no Environment
`producao`. Nenhum job fora dele consegue lê-los — é isso que dá peso à aprovação.

## Como promover

1. Encontre o digest no resumo do run do `cd.yml` (job _Digest elegível para promoção_).
2. Actions → **Promover para Produção** → _Run workflow_.
3. Cole o digest no formato `sha256:...`.
4. O job `validar` roda **antes** da aprovação: se o digest for inválido, você descobre
   sem precisar acordar um reviewer.
5. Aprove quando o GitHub pedir.

## Como reverter

Actions → **Rollback** → _Run workflow_ → digest alvo no formato
`ghcr.io/<dono>/iam-platform@sha256:...`.

O rollback valida o alvo antes de tocar em qualquer coisa. Reverter para um artefato
inválido deixaria produção pior do que já está — e rollback é acionado justamente
quando as coisas já vão mal.

**O banco não é restaurado.** Reverter imagem é reversível; restaurar banco é
destrutivo e exige decidir qual backup e que janela de perda é aceitável. Se o
incidente envolve dados corrompidos, o restore é decisão humana separada.

## Runbook de incidente

### O smoke falhou depois de uma promoção

O rollback automático já disparou. Confira em Actions se o job `reverter` concluiu e
qual digest está servindo. Se ele falhou, siga para o próximo item.

### O rollback automático falhou

Produção pode estar servindo a versão nova e quebrada. Em ordem:

1. Descubra o que está no ar:
   ```bash
   curl -fsS "https://api.render.com/v1/services/$RENDER_SERVICE_ID" \
     -H "Authorization: Bearer $RENDER_API_KEY" | jq -r '.image.imagePath'
   ```
2. Dispare o **Rollback** manualmente com o digest anterior conhecido.
3. Se a API do Render estiver fora, use o dashboard do Render diretamente — o
   pipeline depende da API, você não.

### O deploy ficou preso

O `render-deploy.sh` espera estado terminal e sai 1 em `build_failed`,
`update_failed`, `canceled` ou `pre_deploy_failed`. Se ele saiu **3**, a API estava
inalcançável e **nada mudou** — não reverta: reverter ali trocaria um problema
transitório por uma mudança de estado desnecessária.

### O backup abortou a promoção

`backup.sh` recusa arquivo vazio ou menor que 1 KB. Verifique conectividade com o banco
antes de tentar de novo. **Não pule o backup** a menos que seja incidente declarado — a
flag `pular_backup` existe para isso e fica registrada no run.

## Códigos de saída

| Código | Significado                                | O que fazer                          |
| ------ | ------------------------------------------ | ------------------------------------ |
| 0      | Concluído                                  | —                                    |
| 1      | Falha de gate (teste, scan, smoke, deploy) | Investigar; em produção, reverter    |
| 2      | Entrada inválida — nada foi tocado         | Corrigir o parâmetro e repetir       |
| 3      | Infraestrutura indisponível                | Aguardar e repetir; **não reverter** |

A distinção entre 1 e 3 é a mais importante da tabela: rollback disparado por
indisponibilidade transitória cria um incidente onde não havia.

## Pendências conhecidas

- **`deployment_branch_policy` é `null`**: qualquer branch pode disparar a promoção.
  Restringir a `main` em Settings → Environments → `producao`.
- **`/health/ready` não existe**: o smoke usa liveness, que responde 200 com os bancos
  fora. Um deploy que não fala com o banco passa no smoke. Sem homologação, essa é a
  lacuna mais afiada do pipeline.
- **Teste de mutação removido**: o Stryker saiu junto com suas vulnerabilidades e
  porque media zero mutantes. Volta quando houver serviços para mutar.
- **`promote.yml`, `rollback.yml` e `rollback-drill.yml` nunca rodaram** em produção. A
  lógica dos scripts está coberta por testes com API simulada; a cadeia real, não.
