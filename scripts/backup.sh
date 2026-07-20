#!/usr/bin/env bash
# Backup de PostgreSQL (pg_dump) e MongoDB (mongodump), com verificação de conteúdo.
#
# A verificação deixou de ser opcional. Antes ficava atrás de --validate, e o pipeline
# chamava o script sem a flag: um backup de 0 bytes é indistinguível de um backup bom
# para quem só checa se o comando saiu 0. Descobrir isso durante o restore, no meio de
# um incidente, é o pior momento possível.
#
# Uso: backup.sh [--all|--postgres|--mongodb]
# Ambiente:
#   POSTGRES_URL, MONGODB_URL   conforme o alvo
#   DIRETORIO_BACKUP            (opcional, padrão ./backups)
#   TAMANHO_MINIMO_BYTES        (opcional, padrão 1024)
#
# Códigos de saída:
#   0  backup gerado e verificado
#   1  backup ausente, vazio ou menor que o mínimo
#   2  configuração inválida
set -euo pipefail

ALVO="${1:---all}"
DIRETORIO="${DIRETORIO_BACKUP:-backups}"
MINIMO="${TAMANHO_MINIMO_BYTES:-1024}"
DATA=$(date +%Y%m%d-%H%M%S)

case "${ALVO}" in
  --all | --postgres | --mongodb) ;;
  *)
    echo "Alvo inválido: ${ALVO}. Use --all, --postgres ou --mongodb." >&2
    exit 2
    ;;
esac

mkdir -p "${DIRETORIO}"
gerados=()

if [[ "${ALVO}" == "--postgres" || "${ALVO}" == "--all" ]]; then
  destino="${DIRETORIO}/pg-${DATA}.dump"
  pg_dump "${POSTGRES_URL:?POSTGRES_URL não definida}" -Fc -f "${destino}"
  gerados+=("${destino}")
fi

if [[ "${ALVO}" == "--mongodb" || "${ALVO}" == "--all" ]]; then
  destino="${DIRETORIO}/mongo-${DATA}.archive"
  mongodump --uri "${MONGODB_URL:?MONGODB_URL não definida}" --archive="${destino}" --gzip
  gerados+=("${destino}")
fi

# ---------- verificação: sempre, não sob flag ----------
if [[ "${#gerados[@]}" -eq 0 ]]; then
  echo "Nenhum backup foi gerado para o alvo ${ALVO}." >&2
  exit 1
fi

for arquivo in "${gerados[@]}"; do
  if [[ ! -f "${arquivo}" ]]; then
    echo "Backup não foi criado: ${arquivo}" >&2
    exit 1
  fi

  tamanho=$(wc -c < "${arquivo}" | tr -d ' ')
  if [[ "${tamanho}" -lt "${MINIMO}" ]]; then
    # pg_dump e mongodump podem sair 0 e produzir arquivo trivial quando a conexão cai
    # no meio ou quando o alvo está vazio por engano. O tamanho é a evidência barata.
    echo "Backup suspeito: ${arquivo} tem ${tamanho} bytes (mínimo ${MINIMO})" >&2
    exit 1
  fi
  echo "ok  ${arquivo} (${tamanho} bytes)"
done

echo "Backup verificado: ${#gerados[@]} arquivo(s) em ${DIRETORIO}"
