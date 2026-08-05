#!/usr/bin/env bash
# Peças comuns dos scripts de cópia e restauração: validação de entrada, checagem de
# ferramenta, limpeza de rastro e a tabela de códigos de saída.
#
# Existe porque as três armadilhas destes scripts são as mesmas: rodar sem uma variável e
# descobrir no meio, usar um cliente mais velho que o servidor e receber um dump que não
# restaura, e deixar material em claro no disco quando algo falha na metade.
#
# Códigos de saída (comuns a todos os scripts):
#   0  sucesso
#   1  erro inesperado
#   2  parâmetro ou variável obrigatória ausente/inválida
#   3  ferramenta ausente ou versão incompatível com o servidor
#   4  verificação de integridade falhou (checksum ou decifragem)
#   5  trava de segurança acionada
#   6  verificação pós-restauração reprovou
set -Eeuo pipefail

readonly SAIDA_PARAMETRO=2
readonly SAIDA_FERRAMENTA=3
readonly SAIDA_INTEGRIDADE=4
readonly SAIDA_TRAVA=5

# Diretório temporário do processo. Tudo em claro nasce aqui e some no `trap`.
TEMPORARIO=""

erro() {
  echo "$*" >&2
}

# Remove o material em claro em QUALQUER saída — sucesso, erro ou sinal. Sem isso, uma falha
# no meio da execução deixaria um dump legível no disco justamente no dia em que algo deu
# errado e ninguém está olhando.
limpar() {
  [[ -n "${TEMPORARIO}" && -d "${TEMPORARIO}" ]] && rm -rf "${TEMPORARIO}"
  return 0
}

abrir_temporario() {
  TEMPORARIO="$(mktemp -d)"
  trap limpar EXIT INT TERM
}

exigir_variavel() {
  local nome="$1"
  if [[ -z "${!nome:-}" ]]; then
    erro "Variável obrigatória ausente: ${nome}"
    exit "${SAIDA_PARAMETRO}"
  fi
}

exigir_comando() {
  local comando="$1"
  if ! command -v "${comando}" > /dev/null 2>&1; then
    erro "Ferramenta ausente: ${comando}"
    exit "${SAIDA_FERRAMENTA}"
  fi
}

# Primeiro número da versão declarada pela ferramenta — `pg_dump (PostgreSQL) 17.2` → 17.
versao_maior() {
  "$1" --version 2> /dev/null | grep -oE '[0-9]+' | head -1
}

# Cliente mais velho que o servidor produz dump que o servidor novo não restaura, e o erro
# só aparece no restore. A checagem é barata e acontece antes de qualquer conexão pesada.
exigir_cliente_compativel() {
  local comando="$1" versao_do_servidor="$2"
  local cliente
  cliente="$(versao_maior "${comando}")"
  if [[ -n "${cliente}" && -n "${versao_do_servidor}" && "${cliente}" -lt "${versao_do_servidor}" ]]; then
    erro "Cliente ${comando} é ${cliente}, servidor é ${versao_do_servidor}: dump incompatível"
    exit "${SAIDA_FERRAMENTA}"
  fi
}
