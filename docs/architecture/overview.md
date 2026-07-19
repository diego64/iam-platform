# Visão Geral da Arquitetura

```
[Client] --(login senha)--> [IAM] --> Access Token (JWT EdDSA) + Refresh Token (opaco)
[Client] --(Bearer JWT)---> [Microsserviço B] --valida offline--> chave pública via /.well-known/jwks.json

PostgreSQL: users, RBAC (roles/permissions/pivots), jwks
MongoDB:    refresh_tokens (TTL), token_denylist (TTL)
OTel SDK -> Collector -> Prometheus/Loki/Tempo -> Grafana
```
