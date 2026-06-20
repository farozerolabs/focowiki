---
title: Docker Compose Deployment
---

# Docker Compose Deployment

This guide starts Focowiki from the production Docker Compose template and GitHub Container Registry images.

## Requirements

Production deployment requires:

| Service | Purpose |
| --- | --- |
| PostgreSQL | Product records, source-file processing records, graph nodes, graph edges, releases, generated file records, OpenAPI key records, and audit evidence. |
| Redis | Sessions, rate limits, cursors, coordination, locks, and short-lived source-file refresh state. |
| S3-compatible storage | Uploaded source files and generated public bundles, including `_graph/` files. |
| Reverse proxy | HTTPS public origins for Admin UI, Admin API, and Developer OpenAPI. |

The Compose template starts PostgreSQL and Redis. Configure an external S3-compatible service in `.env`.

## Prepare Files

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
```

Fill `.env` before starting the stack. Important groups include:

See [Environment Configuration](./environment.md) for every variable, required values, optional values, and production examples.

Keep real `.env` files and copied Compose files out of git.

## Runtime Logging

`APP_ENV=production` uses production-safe runtime behavior. API error responses keep internal diagnostics out of the response body, and Admin UI production builds remove product-authored `console.log`, `console.debug`, `console.info`, and `debugger` statements.

See [Environment Configuration](./environment.md#runtime) for file logging, log rotation, and Docker log limits.

## Pull Images

```bash
docker compose -f docker-compose.yml pull
```

The template uses these images by default:

| Image | Default tag |
| --- | --- |
| `ghcr.io/farozerolabs/focowiki-api` | `latest` |
| `ghcr.io/farozerolabs/focowiki-admin` | `latest` |

To pin a release, set the image variables in `.env`.

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
```

## Run Migration Check

```bash
docker compose -f docker-compose.yml run --rm migrate
```

The migration container uses the API image and exits after database migration completes. This command is a useful explicit check before startup. The production Compose template also wires the `api` service to the `migrate` service, so `docker compose -f docker-compose.yml up -d` runs migration before the API starts.

## Start Services

```bash
docker compose -f docker-compose.yml up -d
```

Default service URLs depend on your `.env` ports:

| Service | Local URL pattern |
| --- | --- |
| Admin UI | `http://127.0.0.1:${ADMIN_UI_PORT}` |
| Admin API | `http://127.0.0.1:${ADMIN_API_PORT}` |
| Developer OpenAPI | `http://127.0.0.1:${PUBLIC_OPENAPI_PORT}` |

For public deployment, place Admin UI, Admin API, and Developer OpenAPI behind HTTPS origins configured in `.env`.

## Common Commands

```bash
pnpm compose:config
pnpm compose:pull
pnpm compose:migrate
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down
pnpm compose:clean
```

Use `docker compose logs -f` for container stdout/stderr logs. See [Environment Configuration](./environment.md#runtime) for product runtime log files.

`pnpm compose:clean` removes deployment containers, named volumes, orphans, and local image copies used by the production Compose stack. It also removes local PostgreSQL and Redis data owned by that stack.

## After Startup

1. Open Admin UI.
2. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
3. Create a knowledge base.
4. Create or copy an OpenAPI key from the Admin UI.
5. Use the key with Developer OpenAPI.

Continue with [Developer OpenAPI](../openapi/index.md).

## Graph Processing Notes

Focowiki stores file graph nodes, graph edges, and graph job records in PostgreSQL. Redis coordinates locks and pagination state during processing. Generated graph files are published to S3-compatible storage with the active bundle.

Keep graph processing bounded by the runtime limits in `.env`. Avoid custom scripts that load the full source corpus or full graph into process memory.

For unreleased development deployments, data can be rebuilt destructively. Stop the stack, run `pnpm compose:clean` if you need to clear local PostgreSQL and Redis volumes, start the stack again, run migrations, and upload Markdown files to regenerate graph-backed bundles.
