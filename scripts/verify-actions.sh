#!/usr/bin/env bash
# Resolve toda referência `uses:` dos workflows contra a API do GitHub e falha se
# alguma ref não existir.
#
# Existe porque `actions/dependency-review-action@v6` foi referenciada por generalizar
# a convenção de usar sempre a major mais recente — só que essa action nunca chegou à v6.
# Dois workflows quebraram, e o erro só apareceu no runner. Aqui aparece antes.
#
# Uso: verify-actions.sh [diretorio]   (padrão: .github/workflows)
set -euo pipefail

DIRETORIO="${1:-.github/workflows}"

# Ações locais (./) e de container (docker://) não têm ref no GitHub para resolver.
IGNORAR_PREFIXOS='^(\./|docker://)'

falhas=0
verificadas=0

# Extrai "owner/repo@ref" de cada `uses:`, ignorando subpaths (github/codeql-action/init).
referencias=$(grep -rhoE '^\s*-?\s*uses:\s*\S+' "${DIRETORIO}" \
  | sed -E 's/^\s*-?\s*uses:\s*//' \
  | grep -vE "${IGNORAR_PREFIXOS}" \
  | sort -u)

if [[ -z "${referencias}" ]]; then
  echo "Nenhuma referência de action encontrada em ${DIRETORIO}" >&2
  exit 1
fi

while IFS= read -r referencia; do
  [[ -z "${referencia}" ]] && continue

  caminho="${referencia%@*}"
  ref="${referencia##*@}"
  # github/codeql-action/init → github/codeql-action
  repositorio=$(echo "${caminho}" | cut -d/ -f1,2)

  verificadas=$((verificadas + 1))

  # SHA completo é imutável e resolve por commit, não por tag.
  if [[ "${ref}" =~ ^[0-9a-f]{40}$ ]]; then
    if gh api "repos/${repositorio}/commits/${ref}" >/dev/null 2>&1; then
      echo "ok       ${referencia}"
      continue
    fi
  elif gh api "repos/${repositorio}/git/ref/tags/${ref}" >/dev/null 2>&1 \
    || gh api "repos/${repositorio}/git/ref/heads/${ref}" >/dev/null 2>&1; then
    echo "ok       ${referencia}"
    continue
  fi

  # Sugere o que existe, para a correção não virar tentativa e erro.
  ultima=$(gh api "repos/${repositorio}/releases/latest" --jq '.tag_name' 2>/dev/null || echo '?')
  echo "AUSENTE  ${referencia}  (mais recente disponível: ${ultima})" >&2
  falhas=$((falhas + 1))
done <<< "${referencias}"

echo
echo "${verificadas} referência(s) verificada(s), ${falhas} inexistente(s)."

if [[ "${falhas}" -gt 0 ]]; then
  echo "Corrija as referências acima: uma action inexistente só falha dentro do runner." >&2
  exit 1
fi
