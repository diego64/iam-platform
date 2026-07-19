#!/usr/bin/env bash
# Backup de PostgreSQL (pg_dump) e MongoDB (mongodump) com validação básica.
# Uso: backup.sh [--postgres] [--mongodb] [--validate]
set -euo pipefail
mkdir -p backups
DATA=$(date +%Y%m%d-%H%M%S)

if [[ "${1:---all}" == "--postgres" || "${1:---all}" == "--all" ]]; then
  pg_dump "${POSTGRES_URL:?POSTGRES_URL não definida}" -Fc -f "backups/pg-${DATA}.dump"
fi
if [[ "${1:---all}" == "--mongodb" || "${1:---all}" == "--all" ]]; then
  mongodump --uri "${MONGODB_URL:?MONGODB_URL não definida}" --archive="backups/mongo-${DATA}.archive" --gzip
fi
if [[ "${1:-}" == "--validate" ]]; then
  # Valida integridade mínima dos artefatos gerados
  for f in backups/*; do
    [[ -s "$f" ]] || { echo "Backup vazio: $f"; exit 1; }
  done
  echo "Backups válidos"
fi
