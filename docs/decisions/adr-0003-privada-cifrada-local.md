# ADR-0003 — Chave privada cifrada com envelope local (sem HSM na v1)

## Status: aceito

## Contexto
Sem orçamento para KMS/HSM na v1. A privada precisa persistir para sobreviver a restarts
e permitir rotação (SPEC 008).

## Decisão
PKCS#8 cifrado com AES-256-GCM; chave derivada de `MASTER_KEY` (secret manager do Render)
via scrypt. Tabela `jwks` guarda apenas o ciphertext.

## Consequências
+ Dump do banco não expõe material de chave; caminho de migração para KMS é trocar o envelope.
- `MASTER_KEY` vira single point of failure — rotação dela exige re-cifrar as chaves (documentar runbook na SPEC 020).
