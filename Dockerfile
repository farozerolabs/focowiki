# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS dependencies
ENV CI=true
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/okf/package.json packages/okf/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY apps apps
COPY packages packages
RUN pnpm build
RUN pnpm --filter @focowiki/api build:runtime

FROM node:24-alpine AS api
ARG FOCOWIKI_RELEASE_VERSION=0.0.0-dev
ENV NODE_ENV=production
ENV FOCOWIKI_RELEASE_VERSION=${FOCOWIKI_RELEASE_VERSION}
WORKDIR /app

RUN apk add --no-cache su-exec
COPY --from=build /app/apps/api/runtime ./apps/api/runtime
COPY --from=build /app/apps/api/migrations ./apps/api/runtime/migrations
COPY deploy/docker/api-entrypoint.sh /usr/local/bin/focowiki-api-entrypoint
RUN chmod +x /usr/local/bin/focowiki-api-entrypoint
RUN test -f apps/api/runtime/main.mjs && test -f apps/api/runtime/worker.mjs && test -f apps/api/runtime/migrate.mjs

EXPOSE 43000 43200
ENTRYPOINT ["/usr/local/bin/focowiki-api-entrypoint"]
CMD ["node", "apps/api/runtime/main.mjs"]

FROM nginx:1.29-alpine AS admin
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
