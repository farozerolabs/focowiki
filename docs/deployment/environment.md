---
title: Environment Configuration
---

# Environment Configuration

This page describes the variables in `.env.example`. Copy the template before deployment and replace placeholders with values for your server.

```bash
cp .env.example .env
```

Keep the real `.env` file out of git. Use long random values for passwords, database credentials, and S3 credentials.

`.env` is the startup configuration for infrastructure, ports, origins, authentication bootstrap, logs, storage, pagination guards, and database pools. Runtime values that administrators can change from the Admin UI are documented in [Admin Settings](./admin-settings.md).

On first startup, Focowiki seeds Admin Settings from startup defaults when no saved settings exist in PostgreSQL. After that initialization, saved Admin Settings become the runtime source for API limits, Worker tuning, publication tuning, upload generation, and model configurations.

## Runtime

| Variable | Required | How to fill |
| --- | --- | --- |
| `APP_ENV` | Yes | Use `production` for public deployments. Use `development` only for local development. |
| `LOG_LEVEL` | Yes | Use `info` for production. Supported values are `error`, `warn`, `info`, and `debug`. |
| `LOG_FILE_DIR` | Yes | Directory inside the API container or process working directory. Docker Compose uses `logs`, which maps to `/app/logs`. |
| `LOG_FILE_MAX_BYTES` | Yes | Maximum bytes per runtime log file before rotation. Default: `10485760`. |
| `LOG_FILE_MAX_FILES` | Yes | Maximum files per log stream, including the active file. Default: `5`. |
| `LOG_FILE_HOST_DIR` | Docker Compose only | Host directory mounted to `/app/logs`. Default `./logs` is relative to the deployment directory that contains `docker-compose.yml` and `.env`. |

Focowiki writes product runtime logs to files and continues writing stdout/stderr logs. Docker Compose templates also limit Docker-managed logs to `50m` and `3` files per container.

The API image creates the mounted `/app/logs` directory and assigns it to the runtime user before starting the server or migration process.

Docker Compose keeps saved provider key protection material in an internal `runtime-secrets` volume. Keep this volume with the deployment data when moving a server. Removing the volume requires re-entering saved model API keys in Admin Settings.

## Deployment Images

| Variable | Required | How to fill |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | Yes | API image reference. The template uses `ghcr.io/farozerolabs/focowiki-api:latest`. Pin a release with a tag such as `:0.5.1`. |
| `FOCOWIKI_ADMIN_IMAGE` | Yes | Admin UI image reference. The template uses `ghcr.io/farozerolabs/focowiki-admin:latest`. Pin the same release tag as the API image. |

## Admin Authentication

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_USERNAME` | Yes | Admin login username. |
| `ADMIN_PASSWORD` | Yes | Admin login password. Use a strong password. |
| `ADMIN_SESSION_TTL_SECONDS` | Yes | Session lifetime in seconds. Default: `28800`. |
| `ADMIN_SESSION_COOKIE_SECURE` | Yes | Use `true` when serving through HTTPS. Use `false` for local HTTP development. |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | Yes | Cookie SameSite policy. Use `Lax` for standard same-site Admin UI access. |

Admin login uses a server-side session. The browser receives an HTTP-only session cookie, and the backend validates it through Redis. Operators do not provide a session signing secret in `.env`.

## Admin API

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_API_PORT` | Yes | Internal or host port for Admin API. Production template default: `43000`. |
| `ADMIN_API_PROXY_TARGET` | Yes | Admin UI server-side proxy target for Admin API. Docker Compose uses `http://api:43000`. Local development usually uses `http://127.0.0.1:43000`. |
| `ADMIN_PUBLIC_ORIGIN` | Yes | Public HTTPS origin for Admin UI, for example `https://admin.example.com`. |
| `ADMIN_API_PUBLIC_ORIGIN` | Yes | Public HTTPS origin for Admin API, for example `https://admin-api.example.com`. |
| `ADMIN_TRUSTED_ORIGINS` | Yes | Comma-separated Admin UI origins allowed to call Admin API. Include the exact browser origin. |
| `ALLOWED_HOSTS` | Yes in production | Comma-separated hostnames accepted by API requests, including reverse-proxy hostnames and local health-check hosts. |
| `TRUSTED_PROXY_MODE` | Yes | Use `true` behind a trusted reverse proxy. Use `false` for local direct access. |

## Admin UI

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_UI_HOST` | Yes | Host interface for Admin UI container. Docker Compose uses `0.0.0.0`. |
| `ADMIN_UI_PORT` | Yes | Host port for Admin UI. Production template default: `43100`. |
| `VITE_ADMIN_API_BASE_URL` | Optional | Browser API base URL override for special deployments. Leave empty for the standard Admin UI proxy flow. |

## PostgreSQL

| Variable | Required | How to fill |
| --- | --- | --- |
| `POSTGRES_DB` | Yes | Database name created by the Compose PostgreSQL service. |
| `POSTGRES_USER` | Yes | Database user created by the Compose PostgreSQL service. |
| `POSTGRES_PASSWORD` | Yes | Strong database password. |
| `POSTGRES_PORT` | Yes | Host port exposed by the Compose PostgreSQL service. This can differ from the container port `5432`. |
| `DATABASE_URL` | Yes | API database connection string. In Docker Compose, use the container host and port: `postgres://USER:PASSWORD@postgres:5432/DB`. |
| `DATABASE_POOL_MAX` | Yes | Maximum PostgreSQL connections used by the API and migration processes. |

`POSTGRES_PORT` exposes PostgreSQL to the host. `DATABASE_URL` is used inside containers and should point to `postgres:5432` in the production Compose network.

## Redis

| Variable | Required | How to fill |
| --- | --- | --- |
| `REDIS_PORT` | Yes | Host port exposed by the Compose Redis service. |
| `REDIS_URL` | Yes | API Redis connection string. In Docker Compose, use `redis://redis:6379/0`. |

`REDIS_PORT` exposes Redis to the host. `REDIS_URL` is used by the API, Worker, migration process, sessions, cursors, coordination, and rate limits.

## Developer OpenAPI

| Variable | Required | How to fill |
| --- | --- | --- |
| `PUBLIC_OPENAPI_PORT` | Yes | Internal or host port for Developer OpenAPI. Production template default: `43200`. |
| `PUBLIC_BASE_URL` | Yes | Public base URL returned in generated links, for example `https://openapi.example.com`. |
| `PUBLIC_OPENAPI_PUBLIC_ORIGIN` | Yes | Public HTTPS origin for Developer OpenAPI. |
| `CORS_ORIGINS` | Yes | Comma-separated browser origins allowed by CORS. Include Admin UI origin and any trusted developer frontend origin. |

OpenAPI keys are created in the Admin UI. They are stored in the database and should not be placed in `.env`.

## S3-Compatible Storage

| Variable | Required | How to fill |
| --- | --- | --- |
| `S3_ENDPOINT` | Yes | S3-compatible endpoint URL, for example an AWS S3, Backblaze B2, MinIO, or other compatible endpoint. |
| `S3_REGION` | Yes | Storage region value required by the provider. Use a valid hostname-safe region when the SDK requires one. |
| `S3_BUCKET` | Yes | Bucket name for source files and generated knowledge-base files. |
| `S3_ACCESS_KEY_ID` | Yes | Storage access key ID. |
| `S3_SECRET_ACCESS_KEY` | Yes | Storage secret access key. |
| `S3_PREFIX` | Yes | Internal object-key namespace such as `production`. This value is not exposed in public URLs. |
| `S3_FORCE_PATH_STYLE` | Yes | Use `true` for many S3-compatible providers. Use `false` only when your provider requires virtual-host style addressing. |

Use a dedicated bucket or prefix for each environment.

## Pagination and Content Read Limits

These values stay in `.env` because they set API memory boundaries, Redis cursor behavior, response size, and PostgreSQL connection pools.

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_LIST_DEFAULT_PAGE_SIZE` | Yes | Default page size for Admin source-file, task, release, and generated-file lists. |
| `ADMIN_LIST_MAX_PAGE_SIZE` | Yes | Maximum page size accepted by Admin list APIs. |
| `TREE_CHILD_DEFAULT_PAGE_SIZE` | Yes | Default direct-child page size for generated file tree APIs. |
| `TREE_CHILD_MAX_PAGE_SIZE` | Yes | Maximum direct-child page size accepted by generated file tree APIs. |
| `PAGINATION_CURSOR_TTL_SECONDS` | Yes | Redis cursor token lifetime for paginated Admin and Developer OpenAPI reads. |
| `GENERATED_CONTENT_MAX_BYTES` | Yes | Maximum generated file content bytes read into an API response. Larger files return a 413 response. |

## Worker Startup Settings

| Variable | Required | How to fill |
| --- | --- | --- |
| `WORKER_DATABASE_POOL_MAX` | Yes | Maximum PostgreSQL connections used by the Worker process. Keep this separate from the API pool size. |

`WORKER_DATABASE_POOL_MAX` is a startup setting because the PostgreSQL pool is created when the Worker process starts. Change it in `.env` and restart the Worker service when the pool size needs to change.

For an 8-core, 32 GB server, start with `DATABASE_POOL_MAX=12` and `WORKER_DATABASE_POOL_MAX=8`. Keep PostgreSQL connections within `api replicas * DATABASE_POOL_MAX + worker replicas * WORKER_DATABASE_POOL_MAX + migration headroom + operational headroom`.

## Security Audit

| Variable | Required | How to fill |
| --- | --- | --- |
| `SECURITY_AUDIT_RETENTION_DAYS` | Yes | Number of days to keep security audit records. |

API rate limits are managed in [Admin Settings](./admin-settings.md). Tune runtime rate limits together with your reverse proxy and Cloudflare or other edge-layer limits.

## Production Checklist

Before running `docker compose up -d`, confirm:

1. Every placeholder value has been replaced.
2. `POSTGRES_PASSWORD` and `S3_SECRET_ACCESS_KEY` are private.
3. Public origins match your reverse proxy domains.
4. `ALLOWED_HOSTS` includes Admin UI, Admin API, Developer OpenAPI, `127.0.0.1`, and `localhost` when local health checks run inside containers.
5. `DATABASE_URL` and `REDIS_URL` use Compose service names in Docker deployments.
6. `LOG_FILE_HOST_DIR` points to a writable directory under the deployment directory.
7. S3 credentials can read and write the configured bucket and prefix.
8. Open Admin UI after startup and review [Admin Settings](./admin-settings.md).
