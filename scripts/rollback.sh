#!/usr/bin/env bash
# Reverte produção para um digest anterior.
#
# Orquestra o que já existe: valida o artefato alvo, aponta o serviço para ele e
# confirma com smoke. O restore de banco NÃO acontece aqui — ver nota ao final.
#
# Uso:
#   rollback.sh <imagem_com_digest>
# Ambiente:
#   RENDER_API_KEY, RENDER_SERVICE_ID, BASE_URL   (obrigatórios)
#   PULAR_ASSINATURA=1                            (apenas teste local)
#
# Códigos de saída (contrato em specs/023-ci-cd/api.md):
#   0  revertido e verificado
#   1  falha de gate — deploy não ficou live, ou smoke reprovou
#   2  falha de validação — digest inválido; nada foi tocado
#   3  falha de infraestrutura
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGEM="${1:-}"

if [[ -z "${IMAGEM}" ]]; then
  echo "Informe a imagem alvo: rollback.sh <repo>@sha256:<64hex>" >&2
  exit 2
fi
: "${BASE_URL:?BASE_URL não definida}"

# ---------- 1. o alvo é promovível? ----------
# Reverter para um digest que não existe ou não está assinado deixaria produção pior
# do que já está — e um rollback é acionado justamente quando as coisas já vão mal.
echo "== Validando o digest alvo"
bash "${AQUI}/verify-artifact.sh" "${IMAGEM}"

# ---------- 2. aponta o serviço e aguarda ----------
echo "== Revertendo o serviço"
bash "${AQUI}/render-deploy.sh" "${IMAGEM}"

# ---------- 3. confirma ----------
# Rollback sem verificação troca uma falha conhecida por outra desconhecida.
echo "== Confirmando com smoke"
bash "${AQUI}/healthcheck.sh" "${BASE_URL}" 15 2

echo "Rollback concluído: ${IMAGEM}"

# Restore de banco não acontece aqui, de propósito. Reverter imagem é seguro e
# reversível; restaurar banco é destrutivo e exige decidir qual backup e qual janela de
# perda é aceitável. Isso pertence à SPEC de backup/recuperação e precisa de confirmação
# humana explícita — automatizar por engano custaria dados.
