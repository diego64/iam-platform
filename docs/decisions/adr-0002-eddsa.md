# ADR-0002 — EdDSA (Ed25519) como algoritmo de assinatura primário

## Status: aceito

## Contexto
Requisito original citava RS256 ou EdDSA. Consumidores são microsserviços internos
controlados por nós — não há necessidade de compatibilidade com libs legadas.

## Decisão
Ed25519 (`alg: EdDSA`). Chaves de 32 bytes, assinatura/verificação mais rápidas que RSA-2048,
sem parâmetros configuráveis erráveis (padding, tamanho de módulo).

## Consequências
+ Tokens menores, validação mais barata (afeta diretamente o SLO de 15ms), rotação mais leve.
- Consumidor hipotético sem suporte a EdDSA exigiria emitir chave RS256 paralela — o modelo
  de dados (`jwks.algorithm`) já comporta isso sem migração.
