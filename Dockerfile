# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS dependencies
ENV CI=true
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV npm_config_build_from_source=true
RUN apk add --no-cache --virtual .native-build-dependencies g++ make python3
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

FROM node:24-bookworm-slim AS source-worker-dependencies
ENV CI=true
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV npm_config_build_from_source=false
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/okf/package.json packages/okf/package.json
RUN pnpm install --frozen-lockfile

FROM source-worker-dependencies AS source-worker-build
COPY apps apps
COPY packages packages
COPY --from=source-worker-dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=source-worker-dependencies /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=source-worker-dependencies /app/packages/okf/node_modules ./packages/okf/node_modules
RUN pnpm build
RUN pnpm --filter @focowiki/api build:runtime

FROM node:24-alpine AS api
ARG FOCOWIKI_RELEASE_VERSION=0.0.0-dev
ENV NODE_ENV=production
ENV FOCOWIKI_RELEASE_VERSION=${FOCOWIKI_RELEASE_VERSION}
WORKDIR /app

RUN apk add --no-cache libstdc++ openssl su-exec \
    && rm -rf \
      /opt/yarn-v1.22.22 \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
    && rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg
COPY --from=build /app/apps/api/runtime ./apps/api/runtime
COPY --from=build /app/apps/api/migrations ./apps/api/runtime/migrations
COPY deploy/docker/api-entrypoint.sh /usr/local/bin/focowiki-api-entrypoint
RUN chmod +x /usr/local/bin/focowiki-api-entrypoint
RUN test -f apps/api/runtime/main.mjs \
    && test -f apps/api/runtime/migration-preflight.mjs \
    && test -f apps/api/runtime/search-init.mjs \
    && test -f apps/api/runtime/source-worker.mjs \
    && test -f apps/api/runtime/publication-worker.mjs \
    && test -f apps/api/runtime/maintenance-worker.mjs \
    && test -f apps/api/runtime/migrate.mjs \
    && test -f apps/api/runtime/node_modules/nodejieba/package.json \
    && test -f apps/api/runtime/node_modules/nodejieba/LICENSE \
    && test ! -e /usr/local/bin/npm \
    && test ! -e /usr/local/bin/yarn \
    && test ! -x /usr/bin/g++ \
    && test ! -x /usr/bin/make \
    && node -e "const jieba=require('./apps/api/runtime/node_modules/nodejieba'); const tokens=jieba.cutForSearch('缓存一致性需要版本校验和租约恢复'); if (!tokens.includes('缓存') || !tokens.includes('一致性')) process.exit(1)"

EXPOSE 43000 43200
ENTRYPOINT ["/usr/local/bin/focowiki-api-entrypoint"]
CMD ["node", "apps/api/runtime/main.mjs"]

FROM python:3.12-slim-bookworm AS source-worker
ARG FOCOWIKI_RELEASE_VERSION=0.0.0-dev
ENV NODE_ENV=production
ENV FOCOWIKI_RELEASE_VERSION=${FOCOWIKI_RELEASE_VERSION}
ENV PYTHONPATH=/app/apps/api/python
ENV PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      dumb-init \
      gosu \
      libgomp1 \
      libstdc++6 \
      openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --shell /bin/sh --create-home node
COPY --from=source-worker-dependencies /usr/local/bin/node /usr/local/bin/node
COPY apps/api/python/requirements.lock /tmp/focowiki-python-requirements.lock
RUN python -m pip install --no-cache-dir -r /tmp/focowiki-python-requirements.lock \
    && rm -f /tmp/focowiki-python-requirements.lock
COPY --from=source-worker-build /app/apps/api/runtime ./apps/api/runtime
COPY --from=source-worker-build /app/apps/api/migrations ./apps/api/runtime/migrations
COPY apps/api/python ./apps/api/python
COPY deploy/docker/source-worker-entrypoint.sh /usr/local/bin/focowiki-source-worker-entrypoint
RUN chmod +x /usr/local/bin/focowiki-source-worker-entrypoint \
    && test -f apps/api/runtime/source-worker.mjs \
    && test -f apps/api/runtime/node_modules/nodejieba/package.json \
    && test -f apps/api/runtime/node_modules/nodejieba/LICENSE \
    && test -f apps/api/python/requirements.lock \
    && test ! -x /usr/bin/g++ \
    && test ! -x /usr/bin/make \
    && node -e "const jieba=require('./apps/api/runtime/node_modules/nodejieba'); const tokens=jieba.cutForSearch('缓存一致性需要版本校验和租约恢复'); if (!tokens.includes('缓存') || !tokens.includes('一致性')) process.exit(1)" \
    && python -m graphrag_adapter_check

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/focowiki-source-worker-entrypoint"]
CMD ["node", "--max-old-space-size=512", "apps/api/runtime/source-worker.mjs"]

FROM nginx:1.29-alpine AS admin
RUN apk upgrade --no-cache
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
