#!/usr/bin/env bash
# Valida que um digest é promovível ANTES de qualquer efeito colateral.
#
# Ordem importa: esta verificação roda antes de backup, migração e tráfego. Descobrir
# que o digest não existe depois de já ter feito backup e migrado é caro e confuso —
# o estado fica alterado por uma promoção que nunca deveria ter começado.
#
# Uso:
#   verify-artifact.sh <imagem_com_digest>
# Ambiente:
#   COSIGN_IDENTITY_REGEXP, COSIGN_OIDC_ISSUER  (opcionais — padrões do GitHub Actions)
#   PULAR_ASSINATURA=1                          (apenas para teste local sem cosign)
#
# Códigos de saída (contrato em specs/023-ci-cd/api.md):
#   0  digest promovível
#   2  falha de validação — nada foi tocado
#   3  falha de infraestrutura — registry inalcançável
set -euo pipefail

IMAGEM="${1:-}"
IDENTIDADE="${COSIGN_IDENTITY_REGEXP:-https://github.com/.*}"
EMISSOR="${COSIGN_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

falhar_validacao() {
  echo "$1" >&2
  exit 2
}

# ---------- 1. formato ----------
if [[ -z "${IMAGEM}" ]]; then
  falhar_validacao "Informe a imagem: verify-artifact.sh <repo>@sha256:<64hex>"
fi
if [[ ! "${IMAGEM}" =~ ^[^[:space:]]+@sha256:[a-f0-9]{64}$ ]]; then
  # Tag é mutável: aceitar uma aqui permitiria promover algo diferente do que foi
  # escaneado e assinado, que é justamente o que o digest existe para impedir.
  falhar_validacao "Esperado <imagem>@sha256:<64 hex>, recebido: ${IMAGEM}"
fi
echo "ok  formato do digest"

# ---------- 2. existe no registry ----------
if ! saida=$(docker manifest inspect "${IMAGEM}" 2>&1); then
  # Distingue "não existe" de "não consegui perguntar": o primeiro é erro de entrada,
  # o segundo é indisponibilidade e não deve ser tratado como digest inválido.
  if printf '%s' "${saida}" | grep -qiE 'no such manifest|manifest unknown|not found'; then
    falhar_validacao "Digest não existe no registry: ${IMAGEM}"
  fi
  echo "Registry inalcançável ao consultar ${IMAGEM}: ${saida}" >&2
  exit 3
fi
echo "ok  digest existe no registry"

# ---------- 3. assinatura ----------
if [[ "${PULAR_ASSINATURA:-}" == "1" ]]; then
  echo "aviso  verificação de assinatura pulada (PULAR_ASSINATURA=1)" >&2
else
  if ! cosign verify \
    --certificate-identity-regexp "${IDENTIDADE}" \
    --certificate-oidc-issuer "${EMISSOR}" \
    "${IMAGEM}" >/dev/null 2>&1; then
    # Imagem sem assinatura válida não passou pelos controles, ou não veio deste
    # pipeline. Promover assim anula o motivo de existir da assinatura.
    falhar_validacao "Assinatura ausente ou inválida para ${IMAGEM}"
  fi
  echo "ok  assinatura verificada"
fi

echo "Digest promovível: ${IMAGEM}"
