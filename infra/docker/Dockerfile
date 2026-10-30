# syntax=docker/dockerfile:1

# ---- build: tem o toolchain, instala tudo e compila ----
# Base pinada por digest: a tag 22-alpine é mutável e tornaria o build não reproduzível.
FROM node:26-alpine@sha256:233761595746769ebfdb6090f44fc7cdf818ae0ce62d2b37e0367723b9823e36 AS build
WORKDIR /app

# corepack resolve a versão fixada em packageManager — sem isso o pnpm do container
# diverge do local e a instalação pode falhar com ERR_PNPM_IGNORED_BUILDS.
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# O script de build já copia os .sql das migrations para dist/database/migrations: tsc só
# emite JS, e o runner precisa achá-los em runtime, tanto na imagem quanto no deploy nativo.
RUN pnpm build

# Remove as devDependencies do node_modules que será copiado para o runtime.
# --ignore-scripts é obrigatório: prune reexecuta o "prepare", que chama husky —
# e o husky acabou de ser removido por ser devDependency.
RUN pnpm prune --prod --ignore-scripts

# Manifesto mínimo para o runtime. Copiar o package.json completo faz scanners de
# imagem (Trivy) reportarem CVEs de devDependencies que o prune já removeu do disco,
# porque eles leem o manifesto e não o node_modules — ruído falso-positivo permanente
# no gate de segurança. Em runtime só "type" importa, para o Node resolver ESM.
RUN node -e "const p=require('./package.json'); \
    require('fs').writeFileSync('/tmp/package.json', \
    JSON.stringify({ name: p.name, version: p.version, type: p.type, private: true }, null, 2))"

# ---- runtime: mínimo, sem toolchain, não-root ----
FROM node:26-alpine@sha256:233761595746769ebfdb6090f44fc7cdf818ae0ce62d2b37e0367723b9823e36 AS runtime

# Commit da imagem, publicado como rótulo de iam_build_info. Sem ele, a métrica que existe
# para dizer "qual versão estava rodando" diria "desconhecido" — inútil justamente durante
# o incidente em que a pergunta é feita.
ARG GIT_COMMIT=desconhecido
ENV GIT_COMMIT=${GIT_COMMIT}

ENV NODE_ENV=production
WORKDIR /app

# Remove npm e corepack do runtime. O container só executa `node dist/server.js` —
# gerenciador de pacote em imagem de produção é superfície de ataque gratuita, e o
# npm que vem na base carrega CVEs próprios (picomatch, sigstore) que apareciam no
# scan mesmo sem nenhuma relação com as dependências do projeto.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN addgroup -S iam && adduser -S iam -G iam

COPY --from=build --chown=iam:iam /app/node_modules ./node_modules
COPY --from=build --chown=iam:iam /app/dist ./dist
COPY --from=build --chown=iam:iam /tmp/package.json ./package.json

USER iam
EXPOSE 3000

# fetch nativo do Node 22 em vez de curl: evita instalar pacote só para o healthcheck.
# start-period cobre o boot (validação de env + conexões) sem contar como falha.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations no start: o preDeployCommand do Render exige plano pago, indisponível no free.
# Idempotente (schema_migrations + IF NOT EXISTS) e single-instance no free, então rodar aqui
# é seguro. ponytail: se escalar para N réplicas, mover de volta para preDeployCommand — N
# containers migrando em paralelo podem colidir no INSERT de schema_migrations.
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/server.js"]
