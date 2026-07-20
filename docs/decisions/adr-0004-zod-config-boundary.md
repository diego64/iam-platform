# ADR-0004 — Zod na borda de configuração (exceção à regra "Zod só na borda HTTP")

## Status: aceito

## Contexto

O `CLAUDE.md` restringe Zod à borda HTTP (schemas de rota), para que o domínio não
dependa de biblioteca de validação. A configuração de ambiente, porém, também é uma
borda: `process.env` é entrada não confiável, montada por humano, por `docker run`,
por painel do Render ou por secret manager, e nenhum desses caminhos tem tipagem.

A alternativa — checagem manual, variável a variável — falha de dois jeitos:
para no primeiro erro, obrigando a descobrir os problemas um por deploy; e não
coage tipo, deixando `PORT` como string até estourar em runtime.

## Decisão

Validar `process.env` com Zod em `src/config/env.ts`, que é o **único** arquivo
autorizado a lê-lo (regra de lint `no-restricted-properties`). O restante do código
recebe o objeto `Env` já validado e congelado, por injeção.

A validação usa `safeParse` e agrega todos os problemas em um `ErroDeConfiguracao`.
A descrição de cada problema é derivada **apenas do schema** — tipo esperado, conjunto
do enum, limites — e nunca de `issue.message`, porque o Zod embute o valor recebido em
várias mensagens nativas ("Invalid enum value. Expected 'a'|'b', received 'SEGREDO'").
Repassá-las transformaria o log fatal de boot em canal de vazamento de secret, com a
retenção longa típica de log de plataforma.

## Consequências

- Um erro de configuração derruba o processo antes de abrir socket, com a lista
  completa do que corrigir. O container nunca fica healthy, então o Render não troca
  o tráfego para uma versão mal configurada.
- O tipo `Env` é derivado do schema: acrescentar variável é uma mudança só, e o
  compilador acha os consumidores.
- Cada SPEC acrescenta seu bloco ao schema por composição, sem reescrever o módulo.

* A regra "Zod só na borda HTTP" passa a ter uma exceção nomeada, que precisa ser
  lembrada em revisão. Mitigado por: a exceção é um arquivo só, e a regra de lint
  impede que ela se espalhe.
* O domínio segue sem conhecer Zod: `Env` é um tipo simples, não um schema.
