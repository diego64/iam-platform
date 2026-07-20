#!/usr/bin/env bash
# Smoke externo de um ambiente já publicado.
#
# Uso: healthcheck.sh <base_url> [tentativas] [intervalo_inicial_s]
# Sai 0 apenas com HTTP 200 e corpo contendo "status":"ok".
# Reutilizado pelo smoke test do pipeline (SPEC 023).
#
# Escopo SPEC 021: só /health/live. As checagens de /health/ready, JWKS e login
# entram junto com as SPECs que criam esses endpoints (017, 007, 001).
set -euo pipefail

BASE="${1:?informe a URL base, ex: https://iam.example.com}"
TENTATIVAS="${2:-10}"
INTERVALO="${3:-1}"

ALVO="${BASE%/}/health/live"

for tentativa in $(seq 1 "${TENTATIVAS}"); do
  # -f sozinho não basta: um proxy pode devolver 200 com corpo de erro, então o
  # corpo é validado explicitamente.
  if CORPO=$(curl -fsS --max-time 5 "${ALVO}" 2>/dev/null); then
    if [[ "${CORPO}" == *'"status":"ok"'* ]]; then
      echo "OK  ${ALVO} respondeu 200 na tentativa ${tentativa}/${TENTATIVAS}"
      exit 0
    fi
    echo "AVISO  ${ALVO} respondeu 200 com corpo inesperado: ${CORPO}" >&2
  fi

  if [[ "${tentativa}" -lt "${TENTATIVAS}" ]]; then
    echo "... tentativa ${tentativa}/${TENTATIVAS} falhou, aguardando ${INTERVALO}s" >&2
    sleep "${INTERVALO}"
    # Backoff exponencial com teto de 30s: um deploy frio pode levar dezenas de
    # segundos, e insistir a cada 1s só gera ruído no log do pipeline.
    INTERVALO=$(( INTERVALO * 2 ))
    [[ "${INTERVALO}" -gt 30 ]] && INTERVALO=30
  fi
done

echo "FALHA  ${ALVO} não respondeu 200 com status ok em ${TENTATIVAS} tentativas" >&2
exit 1
