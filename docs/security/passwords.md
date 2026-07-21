# Senhas

Como o serviço guarda senhas, valida força e conduz troca e recuperação. Ponto único do
sistema que transforma senha em claro em hash — nenhum outro módulo faz isso.

## Hash

`scrypt` nativo do Node, sem biblioteca de terceiro. Formato armazenado:

```
scrypt$N$r$p$saltBase64$hashBase64
```

Os parâmetros viajam no próprio hash, então a verificação rederiva com o custo de origem —
um hash antigo continua válido mesmo depois de o custo subir.

| Parâmetro                | Variável                 | Default       |
| ------------------------ | ------------------------ | ------------- |
| Custo (N, potência de 2) | `SCRYPT_COST`            | `32768` (2¹⁵) |
| Blocos (r)               | `SCRYPT_BLOCK_SIZE`      | `8`           |
| Paralelismo (p)          | `SCRYPT_PARALLELIZATION` | `1`           |

- Salt de 32 bytes por senha; hash de 64 bytes; comparação em tempo constante.
- O teto de memória é derivado dos parâmetros: com N=2¹⁵ e r=8 o `scrypt` usa exatamente
  32 MiB, o teto default do Node, onde ele aborta de forma intermitente — o serviço fixa um
  teto maior para nunca esbarrar nisso.
- `SCRYPT_COST` só aceita potência de 2: um valor intermediário seria aceito em silêncio com
  custo real menor que o pretendido.

### Subir o custo é transparente

Aumente `SCRYPT_COST` e reimplante. Cada usuário é re-hasheado no próximo login
bem-sucedido, quando o serviço tem a senha em claro em mãos e detecta que o hash guardado
usa parâmetros antigos. Não há migração em massa nem janela em que senhas fiquem com custo
misto de forma insegura.

## Política de força

Validada na borda HTTP (rejeita cedo, com mensagem amigável) **e** no domínio (o caminho
interno de criação de usuário não passa por rota e não pode escapar da regra).

- 12 a 128 caracteres.
- Ao menos 3 das 4 classes: minúscula, maiúscula, dígito, símbolo.
- Fora da blocklist de senhas comuns (senhas simples já caem no comprimento/classes; a
  blocklist pega as que passam a complexidade mas ainda são comuns, como `Password123!`).
- Não pode conter o local-part do e-mail do usuário.

`GET /auth/password/policy` expõe esses parâmetros para o cliente montar validação; a fonte
da verdade continua no servidor.

## Troca de senha

`POST /auth/password/change` (autenticado). Exige a senha atual. A nova senha não pode ser
igual à atual nem a uma das últimas 5 já usadas — o histórico guarda hashes antigos (nunca
a senha) para essa checagem. Em sucesso, todas as sessões do usuário são revogadas e os
tokens de reset pendentes, invalidados.

> A troca faz várias derivações scrypt (verificar a atual, comparar contra o histórico,
> gerar a nova), então é mais lenta que um hash isolado. Um teto de latência para o endpoint
> precisa contar essas derivações.

## Recuperação de senha

`POST /auth/password/forgot` responde **202 sempre**, exista o e-mail ou não — o caminho de
e-mail inexistente paga o custo de um hash equivalente para não denunciar contas por tempo
de resposta. Para e-mail existente e ativo, gera um token de reset opaco (32 bytes
aleatórios) e o entrega pelo canal de notificação.

`POST /auth/password/reset` valida o token e aplica a nova senha. O token:

- É opaco; só o SHA-256 dele é gravado — vazamento do banco não entrega tokens usáveis.
- Vale por 30 minutos (índice TTL apaga o expirado sozinho).
- É de uso único, garantido por uma atualização atômica: de dois resets simultâneos com o
  mesmo token, só o primeiro vence.
- Erro na consulta ao banco rejeita o reset (fecha na falha, não abre).
- Uma senha reprovada pela política não queima o token — o usuário pode tentar de novo.

Até existir um canal de e-mail real, um canal de log-fallback registra o pedido **sem** o
token (o token é a credencial; logá-lo derrotaria o SHA-256 no banco).

## Verificação

```bash
pnpm test                 # unit: hash, política, serviço com fakes
pnpm test:integration     # token de reset no Mongo, histórico no PG, rotas ponta a ponta
pnpm openapi:validate
```

O custo de produção é exercido em pelo menos um teste (para o teto de memória do `scrypt`
ser realmente testado); o resto da suíte usa um custo reduzido para não ficar lenta.
