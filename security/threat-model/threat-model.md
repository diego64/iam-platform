# Threat Model — iam-platform (STRIDE)

Modelo por fluxo. Cada linha nomeia o ativo, a ameaça na classificação STRIDE, o controle
que a mitiga e **o teste que prova que o controle está ligado**.

A coluna de teste não é decoração. Um threat model sem ela descreve o sistema no dia em que
foi escrito e não avisa quando deixa de ser verdade — vira prosa que envelhece em silêncio.
`tests/contract/documentos-seguranca.test.ts` verifica que todo caminho citado aqui existe
no repositório, então apagar um teste referenciado reprova o gate.

**Legenda STRIDE:** S = Spoofing · T = Tampering · R = Repudiation · I = Information
disclosure · D = Denial of service · E = Elevation of privilege

---

## 1. Login

| Ativo               | Ameaça                               | Controle                                                                | Teste                                                  |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Senha do usuário    | Força bruta (S)                      | Limite por IP **e** por conta; só tentativa falha consome cota          | `tests/integration/rate-limit/dimensoes.test.ts`       |
| Senha em repouso    | Ataque offline após vazamento (I)    | scrypt com custo 2^15, sal de 32 bytes por usuário                      | `tests/unit/shared/crypto/password.service.test.ts`    |
| Existência da conta | Enumeração por resposta (I)          | Erro único e genérico para conta inexistente e senha errada             | `tests/unit/modules/auth/auth.service.test.ts`         |
| Existência da conta | Enumeração por tempo de resposta (I) | Comparação sempre executada, contra hash fantasma quando não há usuário | `tests/unit/modules/auth/auth.service.test.ts`         |
| Conta bloqueada     | Acesso após bloqueio (E)             | Status verificado antes da emissão; falha genérica                      | `tests/integration/auth/endpoints.test.ts`             |
| Credencial no log   | Retenção indevida (I)                | Censura de senha, token e hash nos caminhos do logger                   | `tests/unit/shared/logger-redact.test.ts`              |
| Resposta com token  | Guardada por intermediário (I)       | `no-store` por default em toda rota não declarada cacheável             | `tests/contract/cabecalhos-seguranca.contract.test.ts` |

## 2. Emissão e validação de token

| Ativo                  | Ameaça                                                | Controle                                                   | Teste                                                 |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| Access token           | Assinatura forjada trocando o algoritmo (S)           | Verificação fixa em EdDSA; `alg` do header não decide nada | `tests/unit/modules/auth/verify-access-token.test.ts` |
| Access token           | Uso após logout (S)                                   | Lista de revogação por `jti`, com expiração automática     | `tests/integration/auth/endpoints.test.ts`            |
| Lista de revogação     | Indisponibilidade tratada como permissão (E)          | Falha fechada: erro na consulta rejeita o token            | `tests/unit/modules/auth/verify-access-token.test.ts` |
| Claims                 | Adulteração de papéis ou escopo (T)                   | Claims assinados; nada é lido do corpo ou de header        | `tests/contract/token-claims.contract.test.ts`        |
| Identificador de chave | Injeção de `kid` apontando para chave do atacante (S) | `kid` resolvido apenas dentro do conjunto publicado        | `tests/unit/modules/jwks/jwks.service.test.ts`        |

## 3. Refresh e sessão

| Ativo         | Ameaça                                  | Controle                                           | Teste                                                            |
| ------------- | --------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Refresh token | Roubo do banco (I)                      | Guardado como SHA-256; nunca em claro              | `tests/integration/auth/repositories.test.ts`                    |
| Refresh token | Reuso de token já rotacionado (S)       | Rotação a cada uso; reuso revoga a família inteira | `tests/unit/modules/refresh-token/refresh-token.service.test.ts` |
| Refresh token | Corrida entre dois usos simultâneos (T) | Rotação atômica com janela de graça                | `tests/integration/refresh-token/rotation-race.test.ts`          |
| Sessão        | Continuidade após logout (S)            | Logout revoga o refresh real, não só o access      | `tests/integration/app/logout-revoga-refresh.test.ts`            |

## 4. OAuth e clientes de API

| Ativo             | Ameaça                            | Controle                                                              | Teste                                                       |
| ----------------- | --------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `client_secret`   | Ataque offline após vazamento (I) | Guardado com scrypt, como senha de usuário                            | `tests/unit/modules/api-clients/credential-factory.test.ts` |
| `client_secret`   | Interceptação na rotação (I)      | Sobreposição temporal com dois segredos válidos                       | `tests/integration/api-clients/lifecycle.test.ts`           |
| Escopo concedido  | Ampliação além do contratado (E)  | Escopo é nome de permissão do catálogo; o mesmo guard autoriza        | `tests/unit/modules/oauth/scope-grant.test.ts`              |
| Endpoint de token | Varredura de credencial (S)       | Limite por IP e por `client_id`, com resposta no formato do protocolo | `tests/integration/rate-limit/dimensoes.test.ts`            |
| Resposta de token | Guardada por intermediário (I)    | `no-store` e `no-cache` obrigatórios                                  | `tests/unit/modules/oauth/oauth-error-handler.test.ts`      |

## 5. Segundo fator

| Ativo                  | Ameaça                      | Controle                                          | Teste                                                  |
| ---------------------- | --------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Segredo TOTP           | Leitura em repouso (I)      | Cifrado com envelope sob a chave-mestra           | `tests/unit/shared/crypto/key-envelope.test.ts`        |
| Código de seis dígitos | Força bruta no desafio (S)  | Teto de tentativas por desafio e limite por conta | `tests/unit/modules/mfa/mfa-challenge.service.test.ts` |
| Código de recuperação  | Reuso (S)                   | Consumo único, guardado como hash                 | `tests/unit/modules/mfa/recovery-codes.test.ts`        |
| Janela do TOTP         | Aceite de código antigo (S) | Janela estreita e deriva limitada                 | `tests/unit/modules/mfa/totp.test.ts`                  |

## 6. Autorização

| Ativo               | Ameaça                                        | Controle                                             | Teste                                                |
| ------------------- | --------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Guard de permissão  | Ausência tratada como permissão (E)           | Falha fechada: sem permissão resolvida, recusa       | `tests/unit/modules/rbac/require-permission.test.ts` |
| Atribuição de papel | Autoconcessão de privilégio (E)               | Atribuição restrita, verificada no serviço           | `tests/unit/modules/rbac/assignment.service.test.ts` |
| Recurso de terceiro | Acesso a objeto alheio pelo identificador (E) | Política por atributo com verificação de propriedade | `tests/integration/abac/ownership.test.ts`           |
| Decisão de política | Decisão obsoleta servida do cache (E)         | Invalidação do cache na alteração da política        | `tests/integration/abac/cache-invalidation.test.ts`  |

## 7. Chaves de assinatura

| Ativo         | Ameaça                                      | Controle                                                           | Teste                                                  |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Chave privada | Leitura em repouso (I)                      | Envelope AES-256-GCM sob a chave-mestra (ADR-0003)                 | `tests/unit/shared/crypto/private-key.test.ts`         |
| Chave privada | Vazamento pelo repositório (I)              | Varredura de segredo no histórico, no fluxo de PR                  | `tests/contract/workflows-seguranca.test.ts`           |
| Chave privada | Saída em log (I)                            | Material de chave na lista de censura do logger                    | `tests/unit/shared/logger-redact.test.ts`              |
| Rotação       | Promoção antes de a chave ser conhecida (D) | Duas fases separadas no tempo, com janela mínima de pré-publicação | `tests/unit/modules/jwks/key-rotation.service.test.ts` |
| Boot          | Subir sem chave utilizável (S)              | Falha fechada no boot                                              | `tests/integration/jwks/boot-fail-closed.test.ts`      |

## 8. Trilha de auditoria

| Ativo                  | Ameaça                                           | Controle                                         | Teste                                                         |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------- |
| Trilha                 | Remoção de evento (R)                            | Encadeamento por hash, verificável               | `tests/unit/modules/audit/audit-integrity.service.test.ts`    |
| Trilha                 | Truncamento do topo (R)                          | Âncoras periódicas fora da coleção               | `tests/integration/audit/audit-checkpoint.repository.test.ts` |
| Trilha                 | Escrita concorrente quebrando o encadeamento (T) | Escrita serializada por posição                  | `tests/integration/audit/audit-concurrency.test.ts`           |
| Disponibilidade        | Falha de auditoria derrubando a operação (D)     | Falha aberta com registro — ver risco residual 2 | `tests/integration/audit/audit-fail-open.test.ts`             |
| Dado pessoal na trilha | Correlação por e-mail em claro (I)               | Digest com segredo, nunca o endereço             | `tests/unit/modules/audit/contexto.test.ts`                   |

## 9. Superfície HTTP e operação

| Ativo               | Ameaça                                                                  | Controle                                                                                                                | Teste                                                  |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Toda resposta       | Interpretação como documento, enquadramento, execução de script (T)     | Política de conteúdo que nega tudo, `DENY` no enquadramento, recusa de adivinhação de tipo                              | `tests/contract/cabecalhos-seguranca.contract.test.ts` |
| Toda resposta       | Rebaixamento para HTTP (S)                                              | Transporte estrito por dois anos, com subdomínios                                                                       | `tests/integration/app/cabecalhos.test.ts`             |
| Processo            | Conexão ociosa segurando trabalhador (D)                                | Teto de tempo de requisição e de conexão ociosa                                                                         | `tests/integration/app/limites.test.ts`                |
| Processo            | Exaustão de memória por corpo grande (D)                                | Corpo recusado antes do parse                                                                                           | `tests/integration/app/limites.test.ts`                |
| Roteador            | Caminho de kilobytes (D)                                                | Comprimento máximo de parâmetro                                                                                         | `tests/integration/app/limites.test.ts`                |
| Entrada refletida   | Eco do caminho recebido na resposta de erro (I)                         | Erro sem rota traduzido para formato próprio, sem eco                                                                   | `tests/integration/app/limites.test.ts`                |
| Endereço de origem  | `X-Forwarded-For` forjado escapando do limite por IP (S)                | Confiança limitada a um salto de proxy                                                                                  | `tests/unit/app/proxy-confiavel.test.ts`               |
| Superfície da API   | Mapa completo entregue sem credencial (I)                               | Documentação interativa não sobe em produção                                                                            | `tests/integration/app/swagger-exposicao.test.ts`      |
| Superfície da API   | Rota servida e não documentada, ou o inverso (T)                        | Contrato bidirecional contra o documento                                                                                | `tests/contract/rotas-montadas.contract.test.ts`       |
| Métrica             | Explosão de séries por identificador em rótulo (D)                      | Rótulo pelo template da rota, nunca pela URL                                                                            | `tests/contract/rotulos.test.ts`                       |
| Trace               | Identificador de pessoa em atributo de span, e query de rota futura (I) | Atributos de URL com query apagados antes da exportação; `url.path` preservado para diagnosticar requisição não roteada | `tests/unit/telemetry/limpeza-de-span.test.ts`         |
| Origem do navegador | Chamada de página hostil (S)                                            | Origem fechada por default; liberação por origem exata                                                                  | `tests/integration/app/montagem.test.ts`               |

## 10. Cadeia de suprimento e implantação

| Ativo          | Ameaça                                        | Controle                                          | Teste                                          |
| -------------- | --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Dependências   | Pacote vulnerável entrando por PR (T)         | Revisão de dependência e auditoria agendada       | `tests/contract/workflows-seguranca.test.ts`   |
| Imagem         | Vulnerabilidade alta ou crítica publicada (T) | Varredura de container bloqueante                 | `tests/contract/workflows-seguranca.test.ts`   |
| Artefato       | Promoção de imagem diferente da testada (T)   | Promoção pelo digest, não pela etiqueta           | `tests/contract/promocao-por-digest.test.ts`   |
| Artefato       | Origem não comprovável (R)                    | Assinatura e inventário de componentes na release | `tests/contract/ordem-scan-assinatura.test.ts` |
| Segredos de CI | Exposição a job que não precisa deles (I)     | Segregação por job                                | `tests/contract/segregacao-secrets.test.ts`    |
| Backup         | Restauração nunca exercitada (D)              | Ensaio de retorno automatizado                    | `tests/integration/ci/rollback.test.ts`        |

---

## Riscos residuais aceitos

Exceções conscientes ao baseline. Estão aqui porque um controle ausente sem registro é
indistinguível de um esquecimento — e porque quem operar um incidente precisa saber que a
janela existe antes de descobri-la no meio dele.

### 1. Contador de rate limit falha aberto

**O que:** indisponibilidade do contador compartilhado deixa a requisição passar sem
limite, com registro em nível de aviso e métrica própria.

**Por que:** fechar significaria recusar todo login enquanto o contador estivesse fora —
transformar a indisponibilidade de um componente auxiliar em indisponibilidade da
plataforma inteira. É o inverso da decisão tomada para a lista de revogação, onde fechar
custa uma sessão e abrir custa um token revogado aceito.

**Risco:** janela de força bruta sem teto durante o incidente.

**Compensatório:** a detecção de força bruta continua funcionando — ela lê a trilha de
auditoria, não o contador. O alerta dispara mesmo com o limite fora.

**Teste:** `tests/integration/rate-limit/mongo-store.test.ts`

### 2. Escrita da trilha de auditoria falha aberta

**O que:** falha ao gravar o evento não impede a operação de concluir.

**Por que:** o inverso tornaria o banco de auditoria um ponto único de falha para login,
troca de senha e toda operação administrativa.

**Risco:** operação executada sem registro correspondente.

**Compensatório:** a falha de escrita é registrada em nível de erro e tem métrica própria,
e o encadeamento por hash detecta a lacuna na verificação de integridade.

**Teste:** `tests/integration/audit/audit-fail-open.test.ts`

### 3. Pré-carga de transporte estrito desligada

**O que:** o cabeçalho anuncia dois anos e inclui subdomínios, mas não pede inclusão na
lista pré-carregada pelos navegadores.

**Por que:** entrar na lista compromete todo subdomínio presente e futuro, e sair dela leva
semanas. É decisão de quem é dono do domínio, não da aplicação.

**Risco:** a primeira requisição de um cliente que nunca visitou o domínio pode sair em
texto claro.

**Compensatório:** o terminador TLS à frente redireciona; a janela é a primeira requisição
de um cliente novo.

**Teste:** `tests/unit/shared/http/security-headers.test.ts`

### 4. Validação de token deixa de ser inteiramente offline

**O que:** a consulta à lista de revogação acontece dentro do provedor a cada validação.

**Por que:** revogação imediata exige estado compartilhado. A alternativa — esperar o token
expirar — deixaria uma janela de quinze minutos após o logout.

**Risco:** acoplamento da validação à disponibilidade do armazenamento da lista.

**Compensatório:** consulta indexada de custo constante, e os consumidores externos podem
aceitar a janela de quinze minutos validando apenas a assinatura.

**Teste:** `tests/unit/modules/auth/verify-access-token.test.ts`

---

## Fora do modelo

Ameaças reais que este documento não cobre porque a mitigação está fora do processo:

- Comprometimento do provedor de banco gerenciado ou do gerenciador de segredos
- Ataque volumétrico na camada de rede (responsabilidade da borda, não da aplicação)
- Acesso físico ou comprometimento da máquina de quem opera
- Engenharia social contra quem tem privilégio administrativo
- Criptografia em repouso do PostgreSQL e do MongoDB (garantia do provedor)

## Manutenção

Revisar a cada release menor. O gatilho de revisão fora do calendário é qualquer um destes:
rota nova, dependência nova no caminho da requisição, mudança em controle de autenticação
ou autorização, ou achado de pentest.
