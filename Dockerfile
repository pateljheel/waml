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
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/docker ./docker
RUN node -e "const fs=require('node:fs'); const updates={ 'packages/db/package.json': { main:'dist/db/src/index.js', types:'dist/db/src/index.d.ts' }, 'packages/shared/package.json': { main:'dist/index.js', types:'dist/index.d.ts' } }; for (const [name, fields] of Object.entries(updates)) { const pkg=JSON.parse(fs.readFileSync(name,'utf8')); Object.assign(pkg, fields); fs.writeFileSync(name, JSON.stringify(pkg, null, 2) + '\n'); } const sharedIndex='packages/shared/dist/index.js'; fs.writeFileSync(sharedIndex, fs.readFileSync(sharedIndex,'utf8').replace('from \"./time\";','from \"./time.js\";'));" \
  && mkdir -p /app/node_modules/@waml \
  && ln -sfn ../../packages/db /app/node_modules/@waml/db \
  && ln -sfn ../../packages/shared /app/node_modules/@waml/shared \
  && chmod +x /app/docker/web-entrypoint.sh /app/docker/worker-entrypoint.sh /app/docker/web-healthcheck.sh /app/docker/worker-healthcheck.sh

FROM runtime AS web
EXPOSE 3000
ENTRYPOINT ["/app/docker/web-entrypoint.sh"]

FROM runtime AS worker
ENTRYPOINT ["/app/docker/worker-entrypoint.sh"]
