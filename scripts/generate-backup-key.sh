#!/usr/bin/env bash
# Gera o par de chaves que protege os artefatos de backup.
#
# A chave pública (destinatário) cifra; a privada (identidade) decifra. Quem faz o backup só
# precisa da pública — é o que permite o host de coleta produzir artefatos que ele próprio
# não consegue ler.
#
# O script recusa sobrescrever um arquivo existente. Gerar por cima de uma identidade em uso
# torna ilegível, de uma vez, todo backup já cifrado com ela — e o erro só aparece no dia da
# restauração.
#
# Uso: generate-backup-key.sh [caminho-da-identidade]
#      (padrão: ./backup-identity.txt, que o .gitignore bloqueia)
set -Eeuo pipefail

DESTINO="${1:-backup-identity.txt}"

if ! command -v age-keygen > /dev/null 2>&1; then
  echo "age-keygen não encontrado. Instale o age:" >&2
  echo "  Debian/Ubuntu: sudo apt-get install -y age" >&2
  echo "  macOS:         brew install age" >&2
  exit 3
fi

if [[ -e "${DESTINO}" ]]; then
  echo "Recusado: ${DESTINO} já existe." >&2
  echo "Sobrescrever tornaria ilegível todo backup já cifrado com essa identidade." >&2
  exit 5
fi

# Nasce restrito. Criar com a permissão padrão e corrigir depois deixa uma janela em que
# qualquer processo da máquina lê a chave privada.
umask 077
age-keygen -o "${DESTINO}" 2> /dev/null
chmod 600 "${DESTINO}"

PUBLICA="$(grep -oE 'age1[0-9a-z]+' "${DESTINO}" | head -1)"

cat <<TEXTO

Par gerado.

  Identidade (privada):  ${DESTINO}   (permissão 600)
  Destinatário (pública): ${PUBLICA}

O que fazer com cada metade
---------------------------
1. Destinatário → segredo BACKUP_AGE_RECIPIENT no repositório:

     gh secret set BACKUP_AGE_RECIPIENT --body '${PUBLICA}'

2. Identidade → segredo BACKUP_AGE_IDENTITY, usado só pelo ensaio de restauração:

     gh secret set BACKUP_AGE_IDENTITY < ${DESTINO}

3. Identidade → gerenciador de segredos, com DOIS detentores, fora da mesma nuvem em que
   os artefatos ficam guardados. Sem isso, o tempo de recuperação declarado não existe:
   ninguém consegue decifrar nada.

4. Registre os detentores na tabela do runbook: docs/runbooks/recovery.md

Confira o par antes de apagar qualquer coisa:

     echo teste | age -r ${PUBLICA} | age -d -i ${DESTINO}

TEXTO

echo "Não versione ${DESTINO}. O .gitignore bloqueia o padrão *identity*, mas confira." >&2
