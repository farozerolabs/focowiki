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

The production Compose template stores PostgreSQL data in `./data/postgres`, Redis data in `./data/redis`, bundled OpenSearch data in `./data/opensearch`, bundled OpenSearch TLS state in `./opensearch-security`, bundled Meilisearch data in `./data/meilisearch`, Meilisearch backups in `./data/meilisearch-snapshots` and `./data/meilisearch-dumps`, and runtime credentials in `./runtime-secrets`. Preserve the directories used by your selected provider when moving or backing up a deployment.

## Deployment Images

| Variable | Required | How to fill |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | Optional | API image. Defaults to `ghcr.io/farozerolabs/focowiki-api:latest`. Pin a release tag for production. |
| `FOCOWIKI_ADMIN_IMAGE` | Optional | Admin UI image. Defaults to `ghcr.io/farozerolabs/focowiki-admin:latest`. Use the same release tag as the API image. |

The `worker`, `migrate`, and API services use `FOCOWIKI_API_IMAGE`; no separate worker image is required.

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

Each Focowiki deployment uses one search service. Choose a deployment mode first, then copy the matching configuration below. `SEARCH_PROVIDER` selects the protocol used by Focowiki. `COMPOSE_PROFILES` controls whether Docker Compose also starts a bundled search container.

| Deployment mode | `SEARCH_PROVIDER` | `COMPOSE_PROFILES` |
| --- | --- | --- |
| Bundled OpenSearch 3.8.0, the default | `opensearch` | `opensearch` |
| Bundled Meilisearch | `meilisearch` | `meilisearch` |
| External or managed OpenSearch | `opensearch` | Empty |
| External or managed Meilisearch | `meilisearch` | Empty |

Every mode requires `SEARCH_INDEX_PREFIX`. It can contain lowercase letters, numbers, underscores, and hyphens and has a maximum length of 80 characters. Give every Focowiki deployment a distinct prefix when deployments share an external search service. Avoid changing it after deployment. After changing the provider or prefix, manually maintain the search index for existing knowledge bases in Admin.

| Field group | Purpose |
| --- | --- |
| `OPENSEARCH_URL`, `OPENSEARCH_AUTH_MODE`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`, `OPENSEARCH_PASSWORD_FILE`, `OPENSEARCH_CA_FILE` | OpenSearch endpoint, authentication, and CA. Use either a direct Basic password or a password file. |
| `OPENSEARCH_AWS_REGION`, `OPENSEARCH_AWS_SERVICE` | Used only for AWS SigV4 authentication with an external OpenSearch service. |
| `OPENSEARCH_ADMIN_PASSWORD`, `OPENSEARCH_JAVA_OPTS` | Used only by bundled OpenSearch. |
| `MEILI_HOST`, `MEILI_MASTER_KEY`, `MEILI_API_KEY`, `MEILI_METRICS_API_KEY`, `MEILI_API_KEY_FILE`, `MEILI_METRICS_API_KEY_FILE` | Meilisearch endpoint and authentication. The bundled service uses a master key and generates two runtime key files; an external service supplies direct keys or key files. |
| `MEILI_MAX_INDEXING_MEMORY`, `MEILI_MAX_INDEXING_THREADS`, `MEILI_SNAPSHOT_DIR`, `MEILI_SCHEDULE_SNAPSHOT`, `MEILI_DUMP_DIR` | Used only by bundled Meilisearch. |

For host-based local development with `docker-compose.dev.yml` or `docker-compose.local.yml`, `MEILI_PORT` selects the loopback port exposed by the bundled Meilisearch container. It defaults to `57700` and must match the port in the local `MEILI_HOST` URL. Production Compose networking uses `http://meilisearch:7700` and does not expose this port.

### Bundled OpenSearch

This is the default in `.env.example`. Keep the URL, username, password-file path, and CA-file path below. Replace the administrator password. You may keep `SEARCH_INDEX_PREFIX` or replace it with a name dedicated to this deployment.

```dotenv
SEARCH_PROVIDER=opensearch
SEARCH_INDEX_PREFIX=focowiki
COMPOSE_PROFILES=opensearch

OPENSEARCH_URL=https://opensearch:9200
OPENSEARCH_AUTH_MODE=basic
OPENSEARCH_USERNAME=focowiki-runtime
OPENSEARCH_PASSWORD=
OPENSEARCH_PASSWORD_FILE=/app/runtime-secrets/opensearch-password
OPENSEARCH_CA_FILE=/app/runtime-secrets/opensearch-ca.pem
OPENSEARCH_AWS_REGION=
OPENSEARCH_AWS_SERVICE=es
OPENSEARCH_ADMIN_PASSWORD=<replace-with-a-strong-administrator-password>
OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
```

On first start, the Docker template automatically generates TLS assets and a random runtime password for `focowiki-runtime`, storing them under `opensearch-security` and `runtime-secrets`. Do not prepare certificates manually, put the administrator password in `OPENSEARCH_PASSWORD`, or change the password-file and CA-file paths above. `OPENSEARCH_JAVA_OPTS` bounds the OpenSearch heap at 512 MiB by default; change it only after measuring the deployment workload and available memory.

### Bundled Meilisearch

Uncomment the complete `meilisearch` service block in the selected Compose template. Then switch both the provider and Compose profile. Generate a master key containing at least 16 bytes of random material. The template generates the runtime and diagnostics keys, so leave their direct values empty and keep the template file paths.

```dotenv
SEARCH_PROVIDER=meilisearch
SEARCH_INDEX_PREFIX=focowiki
COMPOSE_PROFILES=meilisearch

MEILI_HOST=http://meilisearch:7700
MEILI_MASTER_KEY=<replace-with-a-random-master-key>
MEILI_API_KEY=
MEILI_METRICS_API_KEY=
MEILI_API_KEY_FILE=/app/runtime-secrets/meilisearch-api-key
MEILI_METRICS_API_KEY_FILE=/app/runtime-secrets/meilisearch-metrics-key
MEILI_MAX_INDEXING_MEMORY=2GiB
MEILI_MAX_INDEXING_THREADS=2
MEILI_SNAPSHOT_DIR=/meili_snapshots
MEILI_SCHEDULE_SNAPSHOT=86400
MEILI_DUMP_DIR=/meili_dumps
```

Inactive `OPENSEARCH_*` fields may be empty. The memory, thread, snapshot, and dump fields configure only the bundled Meilisearch container and are not used with an external Meilisearch service.

### External OpenSearch

Leave `COMPOSE_PROFILES` empty so Compose does not start the bundled OpenSearch container. `OPENSEARCH_URL` must be an HTTPS endpoint reachable from every Focowiki container. Do not use a container's own `127.0.0.1` or `localhost`.

For Basic authentication:

```dotenv
SEARCH_PROVIDER=opensearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

OPENSEARCH_URL=https://search.example.com
OPENSEARCH_AUTH_MODE=basic
OPENSEARCH_USERNAME=<external-runtime-username>
OPENSEARCH_PASSWORD=<external-runtime-password>
OPENSEARCH_PASSWORD_FILE=
OPENSEARCH_CA_FILE=
OPENSEARCH_AWS_REGION=
OPENSEARCH_AWS_SERVICE=es
OPENSEARCH_ADMIN_PASSWORD=
OPENSEARCH_JAVA_OPTS=
```

To keep the Basic password out of `.env`, store it in the host `runtime-secrets` directory, leave `OPENSEARCH_PASSWORD` empty, and set `OPENSEARCH_PASSWORD_FILE` to the matching container path, such as `/app/runtime-secrets/opensearch-password`. For a private CA, also place the CA file in `runtime-secrets` and set `OPENSEARCH_CA_FILE` to its container path. Leave the CA field empty when the endpoint uses a publicly trusted certificate.

For Amazon OpenSearch Service or OpenSearch Serverless with SigV4:

```dotenv
SEARCH_PROVIDER=opensearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

OPENSEARCH_URL=https://<external-opensearch-endpoint>
OPENSEARCH_AUTH_MODE=aws_sigv4
OPENSEARCH_USERNAME=
OPENSEARCH_PASSWORD=
OPENSEARCH_PASSWORD_FILE=
OPENSEARCH_CA_FILE=
OPENSEARCH_AWS_REGION=<aws-region>
OPENSEARCH_AWS_SERVICE=es
OPENSEARCH_ADMIN_PASSWORD=
OPENSEARCH_JAVA_OPTS=
```

Use `es` for Amazon OpenSearch Service and `aoss` for OpenSearch Serverless. Credentials can come from standard AWS environment variables, workload identity, shared configuration, ECS, or EC2 credentials. Do not add Focowiki-specific static AWS key fields.

### External Meilisearch

Leave `COMPOSE_PROFILES` empty. Supply the external endpoint, runtime application key, and diagnostics key. Leave `MEILI_MASTER_KEY` and bundled-container resource fields empty.

```dotenv
SEARCH_PROVIDER=meilisearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

MEILI_HOST=https://search.example.com
MEILI_MASTER_KEY=
MEILI_API_KEY=<external-runtime-key>
MEILI_METRICS_API_KEY=<external-diagnostics-key>
MEILI_API_KEY_FILE=
MEILI_METRICS_API_KEY_FILE=
MEILI_MAX_INDEXING_MEMORY=
MEILI_MAX_INDEXING_THREADS=
MEILI_SNAPSHOT_DIR=
MEILI_SCHEDULE_SNAPSHOT=
MEILI_DUMP_DIR=
```

You may instead store both keys in the host `runtime-secrets` directory and set `MEILI_API_KEY_FILE` and `MEILI_METRICS_API_KEY_FILE` to their container paths. Production requires both the runtime and diagnostics keys.

Focowiki ignores fields for the inactive provider. Keep `.env`, `runtime-secrets`, and the `opensearch-security` directory generated for bundled OpenSearch private and include them in deployment backups.

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

## Worker Startup Limits

| Variable | Required | How to fill |
| --- | --- | --- |
| `WORKER_DATABASE_POOL_MAX` | Optional | PostgreSQL connections used by one worker. The template uses `8`. |
| `WORKER_CPUS` | Optional | Hard CPU ceiling for the worker container. The template uses `2.0`. |
| `WORKER_MEMORY_LIMIT` | Optional | Hard memory ceiling for the worker container. The template uses `2g`. |
| `WORKER_PIDS_LIMIT` | Optional | Maximum processes and threads in the worker container. The template uses `128`. |

When running multiple replicas, add the pool limits for every API and worker process and leave capacity for migrations and operator access.

The API image used by `worker` contains the optional semantic-enrichment runtime. Keep these startup ceilings in `.env`; tune document concurrency, semantic chunking, evidence, query-vector concurrency, and cache limits from Admin Settings after measuring CPU, memory, provider latency, and workload size.

## Security Audit

| Variable | Required | How to fill |
| --- | --- | --- |
| `SECURITY_AUDIT_RETENTION_DAYS` | Optional | Days to retain security audit records. Default: `30`. |

## Production Checklist

Before starting the stack, confirm:

1. Every placeholder in `.env` has been replaced.
2. API and Admin UI image tags are pinned to the same Focowiki release.
3. Public origins use HTTPS and match the reverse-proxy domains.
4. `ALLOWED_HOSTS` includes every hostname forwarded to the API.
5. PostgreSQL, Redis, the selected search provider, and S3 are reachable from the containers.
6. The S3 credentials can perform the required operations under the selected prefix.
7. `data`, `logs`, `opensearch-security`, `runtime-secrets`, and `backups` are writable and included in your backup plan.
8. Admin Settings are reviewed after the first login.
