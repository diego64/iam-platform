#!/usr/bin/env bash
# Cópia de PostgreSQL e MongoDB, cifrada em repouso e com manifesto.
#
# Três coisas que o script faz e que não são opcionais:
#
# 1. Verifica o conteúdo. Um arquivo de 0 bytes é indistinguível de um backup bom para quem
#    só olha o código de saída do dump, e descobrir isso durante o restore é o pior momento.
# 2. Cifra o artefato. O dump carrega o hash de senha de todos os usuários e a chave privada
#    de assinatura; quem tem acesso ao armazenamento não deveria conseguir lê-lo.
# 3. Grava o manifesto e os checksums. São o que a restauração confronta depois — sem eles,
#    "restaurou" só quer dizer "o comando saiu 0".
#
# Uso: backup.sh [--all|--postgres|--mongodb|--validate]
#
# Ambiente:
#   POSTGRES_URL, MONGODB_URL     conforme o alvo
#   BACKUP_AGE_RECIPIENT          chave pública age; sem ela o script recusa gravar em claro
#   DIRETORIO_BACKUP              destino (padrão ./backups)
#   TAMANHO_MINIMO_BYTES          piso de suspeita (padrão 1024)
#   BACKUP_UPLOAD_CMD             comando que recebe o diretório e o envia para fora do host
#   BACKUP_STATUS_FILE            JSON com o resultado da última execução
#   BACKUP_PERMITIR_SEM_CIFRA     '1' assume o risco de gravar em claro (só desenvolvimento)
#
# Códigos de saída: ver scripts/lib/backup-common.sh. O 1 cobre também backup vazio ou menor
# que o mínimo — é falha de conteúdo, não de configuração.
# shellcheck source=scripts/lib/backup-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-common.sh"

ALVO="${1:---all}"
DIRETORIO="${DIRETORIO_BACKUP:-backups}"
MINIMO="${TAMANHO_MINIMO_BYTES:-1024}"
DATA="$(date -u +%Y%m%dT%H%M%SZ)"

case "${ALVO}" in
  --all | --postgres | --mongodb | --validate) ;;
  *)
    erro "Alvo inválido: ${ALVO}. Use --all, --postgres, --mongodb ou --validate."
    exit "${SAIDA_PARAMETRO}"
    ;;
esac

# ---------- conferência de artefatos já gerados ----------
# `--validate` existe porque o pipeline separa "gerar" de "conferir": cada banco num passo e
# a conferência no seguinte. Sem este modo, o passo de conferência chamava um alvo que o
# script não reconhecia e saía 2 — o backup agendado quebrava todo dia, no último passo.
if [[ "${ALVO}" == "--validate" ]]; then
  encontrados=0
  while IFS= read -r arquivo; do
    encontrados=$((encontrados + 1))
    tamanho=$(wc -c < "${arquivo}" | tr -d ' ')
    if [[ "${tamanho}" -lt "${MINIMO}" ]]; then
      erro "Backup suspeito: ${arquivo} tem ${tamanho} bytes (mínimo ${MINIMO})"
      exit 1
    fi
    echo "ok  ${arquivo} (${tamanho} bytes)"
  done < <(find "${DIRETORIO}" -type f \( -name 'pg-*' -o -name 'mongo-*' \) 2> /dev/null)

  if [[ "${encontrados}" -eq 0 ]]; then
    erro "Nenhum backup encontrado em ${DIRETORIO} para validar."
    exit 1
  fi
  echo "Backup verificado: ${encontrados} arquivo(s) em ${DIRETORIO}"
  exit 0
fi

# ---------- coleta ----------
CIFRAR=1
if [[ -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  if [[ "${BACKUP_PERMITIR_SEM_CIFRA:-}" == "1" ]]; then
    # Só desenvolvimento. A ausência de cifra é uma decisão declarada, nunca um default:
    # cair em claro por falta de variável é exatamente como um backup vaza sem ninguém ver.
    CIFRAR=0
  else
    erro "BACKUP_AGE_RECIPIENT ausente: o artefato carrega hash de senha e chave privada."
    erro "Defina a chave pública age ou, só em desenvolvimento, BACKUP_PERMITIR_SEM_CIFRA=1."
    exit "${SAIDA_PARAMETRO}"
  fi
fi
[[ "${CIFRAR}" -eq 1 ]] && exigir_comando age

abrir_temporario
mkdir -p "${DIRETORIO}"
gerados=()
sufixo=""
[[ "${CIFRAR}" -eq 1 ]] && sufixo=".age"

# Move o artefato do temporário para o destino, cifrando quando há destinatário. O material
# em claro nunca sai do temporário, que o `trap` apaga em qualquer saída.
selar() {
  local origem="$1" destino="$2"
  # O dump pode sair 0 sem escrever nada. Reclamar aqui dá a mensagem que descreve o
  # problema; deixar o `mv` falhar daria o erro do coreutils, que não ajuda ninguém às 3h.
  if [[ ! -f "${origem}" ]]; then
    erro "Backup não foi criado: ${destino}"
    exit 1
  fi
  if [[ "${CIFRAR}" -eq 1 ]]; then
    age -r "${BACKUP_AGE_RECIPIENT}" -o "${destino}" "${origem}"
    rm -f "${origem}"
  else
    mv "${origem}" "${destino}"
  fi
  gerados+=("${destino}")
}

if [[ "${ALVO}" == "--postgres" || "${ALVO}" == "--all" ]]; then
  exigir_variavel POSTGRES_URL
  exigir_comando pg_dump
  pg_dump "${POSTGRES_URL}" -Fc -f "${TEMPORARIO}/pg.dump"
  selar "${TEMPORARIO}/pg.dump" "${DIRETORIO}/pg-${DATA}.dump${sufixo}"
fi

if [[ "${ALVO}" == "--mongodb" || "${ALVO}" == "--all" ]]; then
  exigir_variavel MONGODB_URL
  exigir_comando mongodump
  mongodump --uri "${MONGODB_URL}" --archive="${TEMPORARIO}/mongo.archive" --gzip
  selar "${TEMPORARIO}/mongo.archive" "${DIRETORIO}/mongo-${DATA}.archive${sufixo}"
fi

# ---------- verificação: sempre, não sob flag ----------
if [[ "${#gerados[@]}" -eq 0 ]]; then
  erro "Nenhum backup foi gerado para o alvo ${ALVO}."
  exit 1
fi

registrar_estado() {
  local resultado="$1" mensagem="$2"
  [[ -z "${BACKUP_STATUS_FILE:-}" ]] && return 0
  local detalhe='null'
  [[ -n "${mensagem}" ]] && detalhe="\"${mensagem}\""
  printf '{"resultado":"%s","terminado_em":"%s","alvo":"%s","erro":%s}\n' \
    "${resultado}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${ALVO}" "${detalhe}" \
    > "${BACKUP_STATUS_FILE}"
}

total=0
for arquivo in "${gerados[@]}"; do
  if [[ ! -f "${arquivo}" ]]; then
    registrar_estado falha "artefato ausente"
    erro "Backup não foi criado: ${arquivo}"
    exit 1
  fi

  tamanho=$(wc -c < "${arquivo}" | tr -d ' ')
  if [[ "${tamanho}" -lt "${MINIMO}" ]]; then
    # pg_dump e mongodump podem sair 0 e produzir arquivo trivial quando a conexão cai no
    # meio ou quando o alvo está vazio por engano. O tamanho é a evidência barata.
    registrar_estado falha "artefato suspeito"
    erro "Backup suspeito: ${arquivo} tem ${tamanho} bytes (mínimo ${MINIMO})"
    exit 1
  fi
  total=$((total + tamanho))
  echo "ok  ${arquivo} (${tamanho} bytes)"
done

# ---------- manifesto e checksums ----------
# São o que a restauração confronta: sem eles, restaurar um dump truncado passa por sucesso,
# porque o `pg_restore` não sabe quantas linhas deveriam existir.
nomes=("${gerados[@]##*/}")
{
  printf '{\n'
  printf '  "gerado_em": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "alvo": "%s",\n' "${ALVO}"
  printf '  "cifrado": %s,\n' "$([[ "${CIFRAR}" -eq 1 ]] && echo true || echo false)"
  printf '  "bytes": %s,\n' "${total}"
  printf '  "git_commit": "%s",\n' "${GIT_COMMIT:-desconhecido}"
  printf '  "arquivos": [%s]\n' "$(printf '"%s",' "${nomes[@]}" | sed 's/,$//')"
  printf '}\n'
} > "${DIRETORIO}/manifest-${DATA}.json"

(cd "${DIRETORIO}" && sha256sum "${nomes[@]}" > "SHA256SUMS-${DATA}")

if [[ -n "${BACKUP_UPLOAD_CMD:-}" ]]; then
  # Comando de infraestrutura, não entrada de usuário: trocar de provedor não vira mudança
  # de código, e o repositório não ganha SDK de nuvem.
  ${BACKUP_UPLOAD_CMD} "${DIRETORIO}"
fi
registrar_estado ok ""

echo "Backup verificado: ${#gerados[@]} arquivo(s) em ${DIRETORIO}"
