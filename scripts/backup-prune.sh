#!/usr/bin/env bash
# Expurgo dos artefatos antigos, no esquema avô-pai-filho.
#
# Duas travas contra o erro clássico de script de expurgo, que é apagar exatamente o que
# se precisava:
#   - o conjunto mais recente nunca é removido, esteja ou não dentro da política;
#   - o conjunto marcado como validado por um ensaio (`.drill-ok`) também não.
#
# Roda em simulação por padrão. Apagar exige `--apply` — o modo destrutivo é opt-in, e não
# o contrário.
#
# Uso: backup-prune.sh [--apply]
# Ambiente: DIRETORIO_BACKUP, BACKUP_KEEP_DAILY (7), BACKUP_KEEP_WEEKLY (4),
#           BACKUP_KEEP_MONTHLY (6)
# shellcheck source=scripts/lib/backup-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-common.sh"

DIRETORIO="${DIRETORIO_BACKUP:-backups}"
DIARIOS="${BACKUP_KEEP_DAILY:-7}"
SEMANAIS="${BACKUP_KEEP_WEEKLY:-4}"
MENSAIS="${BACKUP_KEEP_MONTHLY:-6}"
APLICAR=0

[[ "${1:-}" == "--apply" ]] && APLICAR=1
[[ -n "${1:-}" && "${1}" != "--apply" ]] && {
  erro "Parâmetro desconhecido: ${1}"
  exit "${SAIDA_PARAMETRO}"
}
[[ ! -d "${DIRETORIO}" ]] && {
  erro "Diretório inexistente: ${DIRETORIO}"
  exit "${SAIDA_PARAMETRO}"
}

# Um "conjunto" é tudo que compartilha o carimbo de tempo: dump, arquivo, manifesto e somas.
mapfile -t carimbos < <(
  find "${DIRETORIO}" -maxdepth 1 -name 'pg-*' -printf '%f\n' 2> /dev/null |
    sed -E 's/^pg-([0-9TZ]+)\..*$/\1/' | sort -r
)

if [[ "${#carimbos[@]}" -eq 0 ]]; then
  echo "Nada a expurgar em ${DIRETORIO}."
  exit 0
fi

manter=()
adicionar_se_novo() {
  local candidato="$1"
  for existente in "${manter[@]:-}"; do
    [[ "${existente}" == "${candidato}" ]] && return 0
  done
  manter+=("${candidato}")
}

# O mais recente, sempre. É a trava que impede o expurgo de deixar o diretório sem nada
# utilizável quando a política é apertada ou os carimbos são todos do mesmo dia.
adicionar_se_novo "${carimbos[0]}"

# Validado por ensaio: é o único conjunto que alguém já provou que restaura.
for carimbo in "${carimbos[@]}"; do
  [[ -f "${DIRETORIO}/.drill-ok-${carimbo}" ]] && adicionar_se_novo "${carimbo}"
done

# Avô-pai-filho: o mais recente de cada dia, semana e mês, até os tetos configurados.
guardar_por_periodo() {
  local formato="$1" limite="$2"
  local vistos=()
  for carimbo in "${carimbos[@]}"; do
    local data="${carimbo:0:8}"
    local chave
    chave="$(date -u -d "${data}" +"${formato}" 2> /dev/null || echo "${data}")"
    local repetido=0
    for visto in "${vistos[@]:-}"; do
      [[ "${visto}" == "${chave}" ]] && repetido=1
    done
    [[ "${repetido}" -eq 1 ]] && continue
    vistos+=("${chave}")
    [[ "${#vistos[@]}" -gt "${limite}" ]] && break
    adicionar_se_novo "${carimbo}"
  done
}

guardar_por_periodo '%Y%m%d' "${DIARIOS}"
guardar_por_periodo '%G%V' "${SEMANAIS}"
guardar_por_periodo '%Y%m' "${MENSAIS}"

removidos=0
for carimbo in "${carimbos[@]}"; do
  preservar=0
  for guardado in "${manter[@]}"; do
    [[ "${guardado}" == "${carimbo}" ]] && preservar=1
  done
  [[ "${preservar}" -eq 1 ]] && continue

  removidos=$((removidos + 1))
  if [[ "${APLICAR}" -eq 1 ]]; then
    find "${DIRETORIO}" -maxdepth 1 -name "*${carimbo}*" -delete
    echo "removido  ${carimbo}"
  else
    echo "[simulação] removeria  ${carimbo}"
  fi
done

echo "Conjuntos mantidos: ${#manter[@]} · removidos: ${removidos}$([[ "${APLICAR}" -eq 0 ]] && echo ' (simulação)')"
