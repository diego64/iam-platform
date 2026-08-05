# Runbook — recuperação

Procedimento para restaurar o IdP a partir dos artefatos de backup. Escrito para ser
executado às 3h da manhã por alguém que não escreveu os scripts.

## Antes de tudo

```bash
export POSTGRES_URL=...            # alvo da restauração, NÃO produção sem ler a seção 5
export MONGODB_URL=...
export BACKUP_AGE_IDENTITY_FILE=... # identidade que decifra
export RESTORE_TARGET_POSTGRES_DB=... # nome que o banco alvo precisa ter
export RESTORE_TARGET_MONGODB_DB=...
```

O `restore.sh` confere checksum, decifragem, nome do alvo e as travas **antes** de escrever
qualquer coisa. Sem `--confirm` ele imprime o plano e sai — use isso para conferir o alvo.

## 1. Perda total do PostgreSQL

```bash
pnpm backup:restore --dir <artefatos> --somente pg --confirm
pnpm migrate
pnpm backup:verify
```

O `verify` precisa terminar com `"resultado":"ok"`. Reprovou em `contagens`, o dump está
truncado: use o conjunto anterior.

## 2. Perda total do MongoDB

```bash
pnpm backup:restore --dir <artefatos> --somente mongo --confirm
pnpm backup:verify
```

Sessões e refresh tokens voltam ao estado da cópia; quem logou depois dela precisa logar de
novo. A trilha de auditoria volta junto — confira `auditoria` no relatório.

## 3. Perda dos dois

Restaure **PostgreSQL primeiro**, depois o Mongo, e só então rode a verificação:

```bash
pnpm backup:restore --dir <artefatos> --confirm
pnpm migrate
pnpm backup:verify
```

A cópia do Mongo é sempre posterior à do PostgreSQL, então ela pode conter sessão de usuário
que não está no dump do banco relacional. É a direção inofensiva — o token não autentica —, e
o `verify` conta esses órfãos. Volume alto significa janela de coleta longa demais.

## 4. Restauração parcial (uma tabela ou coleção)

Não há atalho no script: restaure o conjunto num banco descartável (`RESTORE_TARGET_*`
apontando para ele) e copie de lá o que precisa. Restaurar por cima do banco vivo com
`--force` derruba o que estava certo junto com o que estava errado.

## 5. Restaurar sobre produção

O script recusa por padrão. Para prosseguir, depois de confirmar o alvo no plano:

```bash
RESTORE_ALLOW_PRODUCTION=eu-sei-o-que-estou-fazendo \
  pnpm backup:restore --dir <artefatos> --confirm --force
```

A trava não protege quem decidiu fazer isso — protege quem esqueceu qual URL estava
exportada no terminal.

## 6. Perda da MASTER_KEY

**Os dados voltam; as chaves de assinatura não.** A chave privada está no dump, mas cifrada
com a `MASTER_KEY`, que nunca entra no backup — guardá-la junto anularia a cifra em repouso.

Sem a `MASTER_KEY` original:

1. Restaure normalmente (seções 1 a 3). A verificação vai reprovar em `chave`, e isso é
   esperado.
2. Defina uma `MASTER_KEY` nova e gere um par novo pelo procedimento de rotação.
3. Publique o JWKS novo e aceite que **todo access token emitido antes vira inválido**.

O custo é uma reautenticação geral, dentro da janela do TTL do access token. O custo oposto —
vazar o backup com a chave que o decifra — seria a plataforma inteira.

## 7. Quem tem a identidade de restauração

| Detentor      | Contato | Onde guarda |
| ------------- | ------- | ----------- |
| _a preencher_ |         |             |
| _a preencher_ |         |             |

São dois, fora da mesma nuvem dos artefatos. Enquanto esta tabela estiver vazia, o tempo de
recuperação declarado não se sustenta: ninguém consegue decifrar nada.
