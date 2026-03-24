FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN npm install -g yarn@1.22.22
COPY package.json yarn.lock turbo.json ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN yarn install --frozen-lockfile --network-timeout 100000
COPY packages packages
RUN yarn build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g yarn@1.22.22 \
  && corepack enable \
  && corepack prepare pnpm@9.15.9 --activate
ENV NODE_ENV=production
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/yarn.lock /app/
COPY --from=builder /app/packages/api/package.json /app/packages/api/
COPY --from=builder /app/packages/api/dist /app/packages/api/dist
COPY --from=builder /app/packages/api/public /app/packages/api/public
WORKDIR /app/packages/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
