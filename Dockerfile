FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm build \
  && pnpm --filter @quillra/api deploy --prod --legacy /prod/api

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV COREPACK_HOME=/opt/corepack \
  HOME=/home/node \
  XDG_CACHE_HOME=/home/node/.cache \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN mkdir -p "$COREPACK_HOME" "$XDG_CACHE_HOME" /home/node/.local/share/pnpm \
  && apt-get update && apt-get install -y --no-install-recommends git ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare yarn@1.22.22 --activate \
  && corepack prepare pnpm@10.34.0 \
  && corepack prepare pnpm@9.15.9 --activate \
  && chown -R node:node "$COREPACK_HOME" /home/node
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /prod/api/package.json /app/packages/api/
COPY --from=builder --chown=node:node /prod/api/node_modules /app/packages/api/node_modules
COPY --from=builder --chown=node:node /app/packages/api/dist /app/packages/api/dist
COPY --from=builder --chown=node:node /app/packages/api/public /app/packages/api/public
COPY --chown=node:node LICENSE /app/LICENSE
COPY docker-entrypoint.sh /usr/local/bin/quillra-entrypoint
RUN chmod 0755 /usr/local/bin/quillra-entrypoint \
  && mkdir -p /app/packages/api/data \
  && chown -R node:node /app/packages/api
WORKDIR /app/packages/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/setup/status').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
ENTRYPOINT ["quillra-entrypoint"]
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
