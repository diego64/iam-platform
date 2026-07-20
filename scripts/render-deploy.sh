#!/usr/bin/env bash
# Aponta o serviço do Render para um digest específico e acompanha o deploy até o fim.
#
# O deploy hook não serve para isto: ele redeploya o que já estiver configurado no
# serviço, sem aceitar qual imagem subir. Sem esse vínculo, o artefato escaneado e
# assinado não é necessariamente o que passa a servir tráfego, e o rollback não tem
# alvo determinístico.
#
# Uso:
#   render-deploy.sh <imagem_com_digest>
# Ambiente:
#   RENDER_API_KEY, RENDER_SERVICE_ID  (obrigatórios)
#   RENDER_API_URL                     (opcional — apontado para a API simulada nos testes)
#   TIMEOUT_DEPLOY_S                   (opcional, padrão 900)
#   INTERVALO_POLL_S                   (opcional, padrão 10)
#
# Códigos de saída (contrato em specs/023-ci-cd/api.md):
#   0  deploy live
#   1  falha de gate — o deploy terminou em estado não-live
#   2  falha de validação de entrada — nada foi tocado
#   3  falha de infraestrutura — API inalcançável; nada mudou, não dispare rollback
set -euo pipefail

IMAGEM="${1:-}"
API="${RENDER_API_URL:-https://api.render.com/v1}"
TIMEOUT_S="${TIMEOUT_DEPLOY_S:-900}"
INTERVALO_S="${INTERVALO_POLL_S:-10}"

# ---------- validação de entrada: antes de qualquer efeito ----------
if [[ -z "${IMAGEM}" ]]; then
  echo "Informe a imagem com digest: render-deploy.sh <repo>@sha256:<64hex>" >&2
  exit 2
fi
if [[ ! "${IMAGEM}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  # Tag é mutável: promover por tag desfaz a rastreabilidade que o digest garante.
  echo "Imagem precisa terminar em @sha256:<64 hex>, recebido: ${IMAGEM}" >&2
  exit 2
fi
for obrigatoria in RENDER_API_KEY RENDER_SERVICE_ID; do
  if [[ -z "${!obrigatoria:-}" ]]; then
    echo "${obrigatoria} não definida." >&2
    exit 2
  fi
done

autenticado=(-H "Authorization: Bearer ${RENDER_API_KEY}" -H 'content-type: application/json')

# ---------- 1. aponta o serviço para o digest ----------
echo "Apontando serviço ${RENDER_SERVICE_ID} para ${IMAGEM}"
if ! curl -fsS -X PATCH "${API}/services/${RENDER_SERVICE_ID}" \
  "${autenticado[@]}" \
  -d "{\"image\":{\"imagePath\":\"${IMAGEM}\"}}" >/dev/null; then
  echo "Falha ao atualizar a imagem do serviço (API indisponível?)." >&2
  exit 3
fi

# ---------- 2. dispara o deploy ----------
resposta=$(curl -fsS -X POST "${API}/services/${RENDER_SERVICE_ID}/deploys" \
  "${autenticado[@]}" -d '{}') || {
  echo "Falha ao disparar o deploy." >&2
  exit 3
}

DEPLOY_ID=$(printf '%s' "${resposta}" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [[ -z "${DEPLOY_ID}" ]]; then
  echo "A API não devolveu id de deploy: ${resposta}" >&2
  exit 3
fi
echo "Deploy disparado: ${DEPLOY_ID}"

# ---------- 3. aguarda estado terminal ----------
# Seguir para o smoke com o deploy em andamento testaria a versão ANTERIOR e a
# aprovaria — falso verde no exato momento em que a verificação mais importa.
inicio=$(date +%s)
while :; do
  detalhe=$(curl -fsS "${API}/services/${RENDER_SERVICE_ID}/deploys/${DEPLOY_ID}" \
    "${autenticado[@]}") || {
    echo "Falha ao consultar o estado do deploy." >&2
    exit 3
  }
  estado=$(printf '%s' "${detalhe}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

  case "${estado}" in
    live)
      decorrido=$(( $(date +%s) - inicio ))
      echo "Deploy ${DEPLOY_ID} live em ${decorrido}s"
      # Consumido pelo step summary e pelo job de rollback.
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        {
          echo "deploy_id=${DEPLOY_ID}"
          echo "duracao_s=${decorrido}"
        } >> "${GITHUB_OUTPUT}"
      fi
      exit 0
      ;;
    build_failed | update_failed | canceled | pre_deploy_failed | deactivated)
      echo "Deploy ${DEPLOY_ID} terminou em ${estado}" >&2
      exit 1
      ;;
    '')
      echo "A API não devolveu status: ${detalhe}" >&2
      exit 3
      ;;
  esac

  if (( $(date +%s) - inicio >= TIMEOUT_S )); then
    echo "Deploy ${DEPLOY_ID} não atingiu estado terminal em ${TIMEOUT_S}s (último: ${estado})" >&2
    exit 1
  fi
  sleep "${INTERVALO_S}"
done
