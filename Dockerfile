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
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/apps/api/runtime ./apps/api/runtime
COPY --from=build /app/apps/api/migrations ./apps/api/runtime/migrations

USER node
EXPOSE 43000 43200
CMD ["node", "apps/api/runtime/main.mjs"]

FROM nginx:1.29-alpine AS admin
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
