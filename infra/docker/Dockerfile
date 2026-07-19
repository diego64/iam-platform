# syntax=docker/dockerfile:1
# Build
FROM node:26-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# Runtime (distroless-like: alpine mínimo, non-root)
FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S iam && adduser -S iam -G iam
COPY --from=build --chown=iam:iam /app/node_modules ./node_modules
COPY --from=build --chown=iam:iam /app/dist ./dist
COPY --chown=iam:iam package.json ./
USER iam
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
