#!/usr/bin/env bash
# Publica um resumo padronizado no $GITHUB_STEP_SUMMARY.
#
# Existe para que o post-mortem não dependa de reler log bruto de vários jobs com
# formatos diferentes. Durante um incidente, a pergunta é sempre a mesma — qual digest
# está servindo, quando entrou, o que o scan disse — e a resposta precisa estar no
# mesmo lugar, no mesmo formato, em todos os workflows.
#
# Uso:
#   step-summary.sh <titulo> [chave=valor ...]
#
# Exemplo:
#   step-summary.sh "Promoção" digest="sha256:abc" ambiente=producao resultado=live
#
# Sem $GITHUB_STEP_SUMMARY definido (execução local ou teste), escreve em stdout.
set -euo pipefail

TITULO="${1:-Resumo}"
shift || true

destino="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

{
  echo "## ${TITULO}"
  echo
  echo "| Campo | Valor |"
  echo "|---|---|"

  for par in "$@"; do
    chave="${par%%=*}"
    valor="${par#*=}"

    # Par sem `=` seria publicado como linha quebrada, escondendo o dado justamente
    # de quem está lendo sob pressão. Melhor falhar do que publicar tabela torta.
    if [[ "${chave}" == "${par}" ]]; then
      echo "Par inválido (esperado chave=valor): ${par}" >&2
      exit 2
    fi

    # Valor vazio vira travessão: célula em branco é ambígua entre "não houve" e
    # "não foi coletado". O travessão é marcador, não conteúdo — fica fora do código.
    if [[ -z "${valor}" ]]; then
      echo "| ${chave} | — |"
      continue
    fi

    # Digest e id ficam em código, para não quebrar linha nem virar link.
    case "${chave}" in
      digest | imagem | anterior | alvo | deploy_id)
        echo "| ${chave} | \`${valor}\` |"
        ;;
      *)
        echo "| ${chave} | ${valor} |"
        ;;
    esac
  done
} >> "${destino}"
