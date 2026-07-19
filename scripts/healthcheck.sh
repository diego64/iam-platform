#!/usr/bin/env bash
# Health check e smoke test de um ambiente.
# Uso: healthcheck.sh <base_url> [--smoke]
set -euo pipefail
BASE="${1:?informe a URL base}"

curl -fsS --max-time 5 "${BASE}/health/live" > /dev/null
curl -fsS --max-time 5 "${BASE}/health/ready" > /dev/null
echo "Health OK"

if [[ "${2:-}" == "--smoke" ]]; then
  # Smoke: JWKS público e resposta 400 controlada do login (payload inválido)
  curl -fsS --max-time 5 "${BASE}/.well-known/jwks.json" | grep -q '"keys"'
  CODIGO=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/auth/login" -H 'content-type: application/json' -d '{}')
  [[ "$CODIGO" == "400" ]] || { echo "Login smoke falhou: esperado 400, veio ${CODIGO}"; exit 1; }
  echo "Smoke OK"
fi
