# Threat Model — iam-platform (STRIDE)

Baseline inicial:

| Ativo | Ameaça (STRIDE) | Controle |
|---|---|---|
| Credenciais | Brute force (E) | scrypt pesado + rate limit + alerta Prometheus |
| Chave privada | Divulgação (I) | envelope AES-256-GCM (ADR-0003), secret scan no CI |
| Access Token | Replay pós-revogação (S) | denylist por jti, fail closed |
| Refresh Token | Roubo do banco (I) | armazenado como SHA-256, rotação a cada uso |
| Pipeline | Supply chain (T) | Trivy gate MEDIUM+, SBOM, Cosign, Dependabot |
