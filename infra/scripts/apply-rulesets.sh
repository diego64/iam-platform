#!/usr/bin/env bash
# Aplica os rulesets no repositório via gh CLI.
# Uso: apply-rulesets.sh <owner/repo>
set -euo pipefail
REPO="${1:?informe owner/repo}"
for f in "$(dirname "$0")"/github-rulesets/*.json; do
  gh api "repos/${REPO}/rulesets" --method POST --input "$f"
  echo "Aplicado: $f"
done
