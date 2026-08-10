# Segurança

## Reportar uma vulnerabilidade

Reporte de forma privada via GitHub Security Advisories deste repositório. Não abra issue
pública. O mesmo canal está publicado na superfície HTTP, em `/.well-known/security.txt`,
para quem chega pela API antes de chegar ao código.

## Documentos

| Documento                               | O que é                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `security/threat-model/threat-model.md` | Modelo STRIDE por fluxo. Cada linha aponta o teste que prova o controle      |
| `security/owasp-api-top10.md`           | OWASP API Security Top 10 (2023) → controle → teste, com as lacunas marcadas |
| `security/pentest-checklist.md`         | Roteiro executável, com resultado esperado e espaço para evidência           |

Os caminhos de teste citados nos dois primeiros são verificados por
`tests/contract/documentos-seguranca.test.ts`: apagar ou renomear um teste referenciado
reprova o gate, em vez de deixar a referência pendurada afirmando uma prova que não existe.

## Baseline

OWASP API Security Top 10 (2023). Decisões estruturais em `docs/decisions/`.

## Validade do `security.txt`

O campo `Expires` é calculado no momento da resposta, nunca escrito à mão: o formato exige
o campo e recusa data no passado, então um arquivo estático deixaria de valer sozinho — em
silêncio, e justamente para o scanner que iria lê-lo.

## Manutenção

Revisar o threat model e a matriz do OWASP a cada release menor. Fora do calendário, o
gatilho é qualquer um destes: rota nova, dependência nova no caminho da requisição, mudança
em controle de autenticação ou autorização, ou achado de pentest.
