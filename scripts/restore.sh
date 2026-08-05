#!/usr/bin/env bash
# Restauração de PostgreSQL e MongoDB a partir dos artefatos de backup.
#
# A ordem aqui é a regra mais importante do script: **toda verificação acontece antes da
# primeira escrita**. Checksum, decifragem, nome do banco alvo e as travas de produção rodam
# inteiras; só depois o `pg_restore` toca em alguma coisa. Restauração que aborta no meio
# deixa o alvo pior do que estava.
#
# Uso: restore.sh --dir <artefatos> --confirm [--force] [--somente pg|mongo]
#   --confirm   obrigatório; sem ele o script descreve o plano e sai com 5
#   --force     permite restaurar sobre um alvo que já contém dados
#   --somente   restaura só um dos bancos
#
# Ambiente:
#   POSTGRES_URL, MONGODB_URL           alvos da restauração
#   BACKUP_AGE_IDENTITY_FILE            identidade age que decifra (quando o artefato é .age)
#   RESTORE_TARGET_POSTGRES_DB          nome que o banco alvo precisa ter
#   RESTORE_TARGET_MONGODB_DB           idem para o Mongo
#   RESTORE_ALLOW_PRODUCTION            quebra-vidro; ver abaixo
#
# Códigos de saída: ver scripts/lib/backup-common.sh.
# shellcheck source=scripts/lib/backup-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-common.sh"

readonly QUEBRA_VIDRO='eu-sei-o-que-estou-fazendo'

DIRETORIO=""
CONFIRMADO=0
FORCADO=0
SOMENTE="ambos"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      DIRETORIO="${2:-}"
      shift 2
      ;;
    --confirm)
      CONFIRMADO=1
      shift
      ;;
    --force)
      FORCADO=1
      shift
      ;;
    --somente)
      SOMENTE="${2:-}"
      shift 2
      ;;
    *)
      erro "Parâmetro desconhecido: $1"
      exit "${SAIDA_PARAMETRO}"
      ;;
  esac
done

[[ -z "${DIRETORIO}" ]] && {
  erro "Informe --dir <artefatos>"
  exit "${SAIDA_PARAMETRO}"
}
[[ ! -d "${DIRETORIO}" ]] && {
  erro "Diretório inexistente: ${DIRETORIO}"
  exit "${SAIDA_PARAMETRO}"
}
case "${SOMENTE}" in
  ambos | pg | mongo) ;;
  *)
    erro "--somente aceita pg ou mongo"
    exit "${SAIDA_PARAMETRO}"
    ;;
esac

restaura_pg() { [[ "${SOMENTE}" == "ambos" || "${SOMENTE}" == "pg" ]]; }
restaura_mongo() { [[ "${SOMENTE}" == "ambos" || "${SOMENTE}" == "mongo" ]]; }

# Nome do banco na URL, sem querystring — é o que as travas comparam.
banco_da_url() {
  local url="$1" caminho="${1##*/}"
  [[ "${url}" == *"?"* ]] && caminho="${caminho%%\?*}"
  echo "${caminho}"
}

# ---------- 1. checksums ----------
somas="$(find "${DIRETORIO}" -maxdepth 1 -name 'SHA256SUMS-*' | head -1)"
if [[ -n "${somas}" ]]; then
  if ! (cd "${DIRETORIO}" && sha256sum -c "$(basename "${somas}")" > /dev/null 2>&1); then
    erro "Checksum não confere: os artefatos foram alterados ou truncados."
    exit "${SAIDA_INTEGRIDADE}"
  fi
  echo "ok  checksums conferem"
else
  erro "Nenhum SHA256SUMS no diretório: impossível afirmar que o artefato está íntegro."
  exit "${SAIDA_INTEGRIDADE}"
fi

# ---------- 2. decifragem ----------
abrir_temporario
decifrar() {
  local origem="$1" destino="$2"
  if [[ "${origem}" == *.age ]]; then
    exigir_comando age
    exigir_variavel BACKUP_AGE_IDENTITY_FILE
    if ! age -d -i "${BACKUP_AGE_IDENTITY_FILE}" -o "${destino}" "${origem}" 2> /dev/null; then
      erro "Falha ao decifrar ${origem}: identidade errada ou artefato adulterado."
      exit "${SAIDA_INTEGRIDADE}"
    fi
  else
    cp "${origem}" "${destino}"
  fi
}

artefato_pg="$(find "${DIRETORIO}" -maxdepth 1 -name 'pg-*' | sort | tail -1)"
artefato_mongo="$(find "${DIRETORIO}" -maxdepth 1 -name 'mongo-*' | sort | tail -1)"

if restaura_pg; then
  [[ -z "${artefato_pg}" ]] && {
    erro "Nenhum artefato de PostgreSQL em ${DIRETORIO}"
    exit "${SAIDA_PARAMETRO}"
  }
  decifrar "${artefato_pg}" "${TEMPORARIO}/pg.dump"
fi
if restaura_mongo; then
  [[ -z "${artefato_mongo}" ]] && {
    erro "Nenhum artefato de MongoDB em ${DIRETORIO}"
    exit "${SAIDA_PARAMETRO}"
  }
  decifrar "${artefato_mongo}" "${TEMPORARIO}/mongo.archive"
fi
echo "ok  artefatos decifrados"

# ---------- 3. o alvo é o que se espera? ----------
if restaura_pg; then
  exigir_variavel POSTGRES_URL
  exigir_variavel RESTORE_TARGET_POSTGRES_DB
  alvo_pg="$(banco_da_url "${POSTGRES_URL}")"
  if [[ "${alvo_pg}" != "${RESTORE_TARGET_POSTGRES_DB}" ]]; then
    erro "Alvo divergente: a URL aponta para '${alvo_pg}', esperado '${RESTORE_TARGET_POSTGRES_DB}'"
    exit "${SAIDA_TRAVA}"
  fi
fi
if restaura_mongo; then
  exigir_variavel MONGODB_URL
  exigir_variavel RESTORE_TARGET_MONGODB_DB
fi

# ---------- 4. produção ----------
# Restaurar sobre produção é operação legítima num desastre e catastrófica por engano. A
# variável de quebra-vidro não protege contra quem decidiu fazer — protege contra quem
# esqueceu qual URL estava exportada no terminal.
if [[ "${alvo_pg:-}" == *prod* || "${RESTORE_TARGET_MONGODB_DB:-}" == *prod* ]]; then
  if [[ "${RESTORE_ALLOW_PRODUCTION:-}" != "${QUEBRA_VIDRO}" ]]; then
    erro "Alvo parece produção. Defina RESTORE_ALLOW_PRODUCTION=${QUEBRA_VIDRO} para prosseguir."
    exit "${SAIDA_TRAVA}"
  fi
  erro "AVISO: restaurando sobre um alvo de produção."
fi

# ---------- 5. o alvo já tem dados? ----------
if restaura_pg && [[ "${FORCADO}" -eq 0 ]]; then
  exigir_comando psql
  existentes="$(psql "${POSTGRES_URL}" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2> /dev/null || echo 0)"
  if [[ "${existentes}" -gt 0 ]]; then
    erro "O alvo já contém ${existentes} tabela(s). Use --force para sobrescrever."
    exit "${SAIDA_TRAVA}"
  fi
fi

# ---------- plano ----------
if [[ "${CONFIRMADO}" -eq 0 ]]; then
  restaura_pg && echo "[plano] pg_restore --clean --if-exists → ${RESTORE_TARGET_POSTGRES_DB}"
  restaura_mongo && echo "[plano] mongorestore --drop → ${RESTORE_TARGET_MONGODB_DB}"
  erro "recusado: use --confirm para executar"
  exit "${SAIDA_TRAVA}"
fi

# ---------- escrita ----------
if restaura_pg; then
  exigir_comando pg_restore
  pg_restore --clean --if-exists --no-owner -d "${POSTGRES_URL}" "${TEMPORARIO}/pg.dump"
  echo "ok  PostgreSQL restaurado"
fi
if restaura_mongo; then
  exigir_comando mongorestore
  mongorestore --uri "${MONGODB_URL}" --drop --gzip --archive="${TEMPORARIO}/mongo.archive"
  echo "ok  MongoDB restaurado"
fi

echo "Restauração concluída. Próximo passo: pnpm migrate && pnpm backup:verify"
