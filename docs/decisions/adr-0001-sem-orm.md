# ADR-0001 — Drivers nativos, sem ORM/ODM

## Status: aceito

## Contexto
IAM manipula SQL sensível (RBAC, JWKS) e coleções voláteis (tokens). ORMs escondem o custo
real das queries e adicionam superfície de ataque/dependência.

## Decisão
PostgreSQL via `pg` puro; MongoDB via driver oficial `mongodb`. SQL versionado em
`src/database/migrations/*.sql` aplicado por script próprio.

## Consequências
+ Controle total de índices, transações e performance; superfície de dependências mínima.
- Mais código de repositório manual; disciplina de tipagem dos resultados obrigatória.
