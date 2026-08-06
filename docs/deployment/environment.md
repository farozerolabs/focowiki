---
title: Environment Configuration
---

# Environment Configuration

This page documents the production variables in `.env.example`. Copy the template, replace every placeholder, and keep the resulting `.env` file out of git.

```bash
cp .env.example .env
```

Use long random values for passwords and service credentials. Settings that can be changed after startup are documented in [Admin Settings](./admin-settings.md).

## Runtime

| Variable | Required | How to fill |
| --- | --- | --- |
| `APP_ENV` | Production | Use `production` for a public deployment. |
| `LOG_LEVEL` | Optional | `error`, `warn`, `info`, or `debug`. The production default is `info`. |
| `LOG_FILE_DIR` | Optional | Runtime log directory. The Compose template uses `logs`, mounted at `/app/logs`. |
| `LOG_FILE_MAX_BYTES` | Optional | Maximum size of one log file. The template uses `10485760` bytes. |
| `LOG_FILE_MAX_FILES` | Optional | Maximum number of files kept for each log output. The template uses `5`. |
| `LOG_FILE_MAX_TOTAL_BYTES` | Optional | Maximum combined size of runtime log files. The template uses `67108864` bytes. |
| `LOG_FILE_RETENTION_DAYS` | Optional | Maximum log retention period. The template uses `7` days. |

Focowiki writes runtime logs to `./logs` and also writes container logs to stdout and stderr. Every Compose service limits Docker-managed logs to `10m` per file and keeps `3` files.

The production Compose template stores PostgreSQL data in `./data/postgres`, Redis data in `./data/redis`, search data in `./data/meilisearch`, search backups in `./data/meilisearch-snapshots` and `./data/meilisearch-dumps`, and private deployment files in `./runtime-secrets`. Preserve these directories when moving or backing up a deployment.

## Deployment Images

| Variable | Required | How to fill |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | Optional | API image. Defaults to `ghcr.io/farozerolabs/focowiki-api:latest`. Pin a release tag for production. |
| `FOCOWIKI_ADMIN_IMAGE` | Optional | Admin UI image. Defaults to `ghcr.io/farozerolabs/focowiki-admin:latest`. Use the same release tag as the API image. |

## Admin Authentication

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_USERNAME` | Yes | Initial Admin UI username. |
| `ADMIN_PASSWORD` | Yes | Initial Admin UI password. Use a strong password. |
| `ADMIN_SESSION_TTL_SECONDS` | Optional | Login lifetime in seconds. Default: `28800`. |
| `ADMIN_SESSION_COOKIE_SECURE` | Optional | Defaults to `true` in production and must remain `true` with HTTPS. |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | Optional | `Lax`, `Strict`, or `None`. Default: `Lax`. `None` requires a secure cookie. |

## Admin API and Admin UI

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_API_PORT` | Compose | Host and container port for Admin API. The template uses `43000`. |
| `ADMIN_UI_PORT` | Compose | Host port for Admin UI. The template uses `43100`. |
| `ADMIN_API_PROXY_TARGET` | Compose | Address used by the Admin UI proxy. Use `http://api:43000` with the production template. |
| `ADMIN_PUBLIC_ORIGIN` | Production | Public HTTPS origin of Admin UI, such as `https://admin.example.com`. |
| `ADMIN_API_PUBLIC_ORIGIN` | Production | Public HTTPS origin of Admin API, such as `https://admin-api.example.com`. |
| `ADMIN_TRUSTED_ORIGINS` | Optional | Comma-separated browser origins allowed to call Admin API. When omitted, the configured Admin UI origin and local development origins are used. |
| `ALLOWED_HOSTS` | Production | Comma-separated hostnames accepted by API requests. Include every hostname forwarded by the reverse proxy and the local health-check hosts. |
| `TRUSTED_PROXY_MODE` | Optional | Use `true` when requests arrive through your trusted reverse proxy. Default: `false`. |

The production template binds Admin UI, Admin API, and Developer OpenAPI to `127.0.0.1`. Publish them through an HTTPS reverse proxy.

## PostgreSQL

| Variable | Required | How to fill |
| --- | --- | --- |
| `POSTGRES_DB` | Compose | Database created by the PostgreSQL service. |
| `POSTGRES_USER` | Compose | Database user created by the PostgreSQL service. |
| `POSTGRES_PASSWORD` | Compose | Strong database password. URL-encode special characters when placing the password in `DATABASE_URL`. |
| `DATABASE_URL` | Yes | API database URL. The production Compose network uses `postgres://USER:PASSWORD@postgres:5432/DB`. |
| `DATABASE_POOL_MAX` | Optional | Maximum PostgreSQL connections used by one API process. Default: `10`. |

PostgreSQL and Redis are not published to host ports by the production template. Use `docker compose exec postgres ...` for database administration, or add an explicit loopback-only port mapping in your private Compose copy when host access is required.

## Redis

| Variable | Required | How to fill |
| --- | --- | --- |
| `REDIS_URL` | Yes | Redis connection URL. The production Compose network uses `redis://redis:6379/0`. |

Redis must be available to the API and all workers. Keep it private to the deployment network.

## Search Service

The production template can start a private Meilisearch service. Use a different `MEILI_INDEX_PREFIX` for each Focowiki deployment that shares a search service.

| Variable | Required | How to fill |
| --- | --- | --- |
| `COMPOSE_PROFILES` | Optional | Use `bundled-search` to start the included Meilisearch service. Leave empty when using an external service. |
| `MEILI_HOST` | Compose | Meilisearch URL reachable from the API and workers. Included service: `http://meilisearch:7700`. |
| `MEILI_MASTER_KEY` | Included service | Strong Meilisearch master key with at least 16 bytes of random material. |
| `MEILI_API_KEY` | External service | Application key supplied by the external provider. Uncomment the template entry when needed. |
| `MEILI_METRICS_API_KEY` | External service | Diagnostic key supplied by the external provider. Uncomment the template entry when needed. |
| `MEILI_INDEX_PREFIX` | Yes | Lowercase index prefix dedicated to this deployment, for example `focowiki_prod`. |
| `MEILI_MAX_INDEXING_MEMORY` | Included service | Meilisearch indexing memory limit. The template uses `2GiB`. |
| `MEILI_MAX_INDEXING_THREADS` | Included service | Meilisearch indexing threads. The template uses `2`. |
| `MEILI_SNAPSHOT_DIR` | Included service | Snapshot directory inside the container. Use `/meili_snapshots` with the template. |
| `MEILI_SCHEDULE_SNAPSHOT` | Included service | Snapshot interval in seconds. The template uses `86400`. |
| `MEILI_DUMP_DIR` | Included service | Dump directory inside the container. Use `/meili_dumps` with the template. |

With the included service, keep `.env` and `runtime-secrets` private and include both in deployment backups. For an external service, create the two required keys before startup and confirm the service is reachable from every Focowiki container.

## Developer OpenAPI

| Variable | Required | How to fill |
| --- | --- | --- |
| `PUBLIC_OPENAPI_PORT` | Compose | Host and container port for Developer OpenAPI. The template uses `43200`. |
| `PUBLIC_BASE_URL` | Yes | Public HTTPS base URL used in API links, such as `https://openapi.example.com`. |
| `PUBLIC_OPENAPI_PUBLIC_ORIGIN` | Optional | Public HTTPS origin for Developer OpenAPI. Defaults to `PUBLIC_BASE_URL`. |

Create Developer OpenAPI keys in Admin UI. Do not place them in `.env`.

## S3-Compatible Storage

The production Compose template does not start an object-storage service. Configure an AWS S3, Cloudflare R2, MinIO, or other S3-compatible bucket reachable from every Focowiki container.

| Variable | Required | How to fill |
| --- | --- | --- |
| `S3_ENDPOINT` | Yes | Provider endpoint URL. |
| `S3_REGION` | Yes | Region required by the provider. |
| `S3_BUCKET` | Yes | Bucket used by this deployment. |
| `S3_ACCESS_KEY_ID` | Yes | Server-side storage access key ID. |
| `S3_SECRET_ACCESS_KEY` | Yes | Server-side storage secret key. |
| `S3_PREFIX` | Yes | Non-empty object-key prefix dedicated to this deployment, such as `production`. |
| `S3_FORCE_PATH_STYLE` | Optional | Default: `false`. Use `true` when required by the provider; AWS S3 normally uses `false`. |

The credentials need permission to list the bucket and to read, write, inspect, and delete objects under the configured prefix. Backup and restore also require the provider's object-version listing support. Use a separate bucket or prefix for each environment.

## Pagination and Content Limits

All values in this section are optional. The values in `.env.example` are the recommended starting values.

| Variable | Purpose |
| --- | --- |
| `ADMIN_LIST_DEFAULT_PAGE_SIZE` | Default page size for Admin lists. |
| `ADMIN_LIST_MAX_PAGE_SIZE` | Maximum page size accepted by Admin lists. |
| `TREE_CHILD_DEFAULT_PAGE_SIZE` | Default page size for direct children in the generated file tree. |
| `TREE_CHILD_MAX_PAGE_SIZE` | Maximum page size for direct children in the generated file tree. |
| `PAGINATION_CURSOR_TTL_SECONDS` | Lifetime of paginated-read cursors. |
| `GENERATED_CONTENT_MAX_BYTES` | Maximum generated file size returned by one API response. Larger content returns HTTP 413. |

## Worker Database Pools

| Variable | Required | How to fill |
| --- | --- | --- |
| `SOURCE_WORKER_DATABASE_POOL_MAX` | Optional | PostgreSQL connections used by one source worker. Default: `6`; the template uses `8`. |
| `PUBLICATION_WORKER_DATABASE_POOL_MAX` | Optional | PostgreSQL connections used by one publication worker. Default: `4`. |
| `MAINTENANCE_WORKER_DATABASE_POOL_MAX` | Optional | PostgreSQL connections used by one maintenance worker. Default: `2`. |

When running multiple replicas, add the pool limits for every API and worker process and leave capacity for migrations and operator access.

## Security Audit

| Variable | Required | How to fill |
| --- | --- | --- |
| `SECURITY_AUDIT_RETENTION_DAYS` | Optional | Days to retain security audit records. Default: `30`. |

## Production Checklist

Before starting the stack, confirm:

1. Every placeholder in `.env` has been replaced.
2. Image tags are pinned to the same Focowiki release.
3. Public origins use HTTPS and match the reverse-proxy domains.
4. `ALLOWED_HOSTS` includes every hostname forwarded to the API.
5. PostgreSQL, Redis, Meilisearch, and S3 are reachable from the containers.
6. The S3 credentials can perform the required operations under the selected prefix.
7. `data`, `logs`, `runtime-secrets`, and `backups` are writable and included in your backup plan.
8. Admin Settings are reviewed after the first login.
