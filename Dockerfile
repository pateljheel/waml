FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY apps ./apps
COPY packages ./packages
COPY docker ./docker
RUN pnpm build \
  && node -e "const fs=require('node:fs'); const sharedIndex='packages/shared/dist/index.js'; const sharedSource=fs.readFileSync(sharedIndex,'utf8').replace('from \"./time\";','from \"./time.js\";').replace('from \"./path-patterns\";','from \"./path-patterns.js\";'); fs.writeFileSync(sharedIndex, sharedSource);"

FROM base AS worker-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV WAML_REPO_ROOT=/app
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/docker/web-entrypoint.sh /app/docker/web-entrypoint.sh
COPY --from=builder /app/docker/web-healthcheck.sh /app/docker/web-healthcheck.sh
RUN chmod +x /app/docker/web-entrypoint.sh /app/docker/web-healthcheck.sh
EXPOSE 3000
ENTRYPOINT ["/app/docker/web-entrypoint.sh"]

FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV WAML_REPO_ROOT=/app
RUN corepack enable
COPY --from=worker-deps /app/node_modules ./node_modules
COPY --from=worker-deps /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=worker-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=worker-deps /app/packages/db/package.json ./packages/db/package.json
COPY --from=worker-deps /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=worker-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/docker/worker-entrypoint.sh /app/docker/worker-entrypoint.sh
COPY --from=builder /app/docker/worker-healthcheck.sh /app/docker/worker-healthcheck.sh
RUN node -e "const fs=require('node:fs'); const updates={ 'packages/db/package.json': { main:'dist/db/src/index.js', types:'dist/db/src/index.d.ts' }, 'packages/shared/package.json': { main:'dist/index.js', types:'dist/index.d.ts' } }; for (const [name, fields] of Object.entries(updates)) { const pkg=JSON.parse(fs.readFileSync(name,'utf8')); Object.assign(pkg, fields); fs.writeFileSync(name, JSON.stringify(pkg, null, 2) + '\n'); }" \
  && mkdir -p /app/node_modules/@waml /app/var/data /app/var/cache /app/var/health \
  && ln -sfn ../../packages/db /app/node_modules/@waml/db \
  && ln -sfn ../../packages/shared /app/node_modules/@waml/shared \
  && chmod +x /app/docker/worker-entrypoint.sh /app/docker/worker-healthcheck.sh
ENTRYPOINT ["/app/docker/worker-entrypoint.sh"]
