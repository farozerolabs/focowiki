# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies
ENV CI=true
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV npm_config_build_from_source=true
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/okf/package.json packages/okf/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY apps apps
COPY packages packages
COPY --from=dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=dependencies /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=dependencies /app/packages/okf/node_modules ./packages/okf/node_modules
RUN pnpm build
RUN pnpm --filter @focowiki/api build:runtime

FROM node:24-bookworm-slim AS node-runtime

FROM python:3.12-slim-bookworm AS api
ARG FOCOWIKI_RELEASE_VERSION=0.0.0-dev
ENV NODE_ENV=production
ENV FOCOWIKI_RELEASE_VERSION=${FOCOWIKI_RELEASE_VERSION}
ENV PYTHONPATH=/app/apps/api/python
ENV PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init gosu libgomp1 libstdc++6 openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --shell /bin/sh --create-home node
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY apps/api/python/requirements.lock /tmp/focowiki-python-requirements.lock
RUN python -m pip install --no-cache-dir -r /tmp/focowiki-python-requirements.lock \
    && rm -f /tmp/focowiki-python-requirements.lock
COPY --from=build /app/apps/api/runtime ./apps/api/runtime
COPY --from=build /app/apps/api/migrations ./apps/api/runtime/migrations
COPY apps/api/python ./apps/api/python
COPY deploy/docker/api-entrypoint.sh /usr/local/bin/focowiki-api-entrypoint
RUN chmod +x /usr/local/bin/focowiki-api-entrypoint
RUN test -f apps/api/runtime/main.mjs \
    && test -f apps/api/runtime/migration-preflight.mjs \
    && test -f apps/api/runtime/search-init.mjs \
    && test -f apps/api/runtime/worker.mjs \
    && test -f apps/api/runtime/migrate.mjs \
    && test -f apps/api/runtime/node_modules/nodejieba/package.json \
    && test -f apps/api/runtime/node_modules/nodejieba/LICENSE \
    && test -f apps/api/python/requirements.lock \
    && node -e "const jieba=require('./apps/api/runtime/node_modules/nodejieba'); const tokens=jieba.cutForSearch('缓存一致性需要版本校验和租约恢复'); if (!tokens.includes('缓存') || !tokens.includes('一致性')) process.exit(1)" \
    && python -m graphrag_adapter_check

EXPOSE 43000 43200
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/focowiki-api-entrypoint"]
CMD ["node", "apps/api/runtime/main.mjs"]

FROM nginx:1.29-alpine AS admin
RUN apk upgrade --no-cache
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
