---
title: Environment Configuration
---

# Environment Configuration

This page describes every variable in `.env.example`. Copy the template before deployment and replace placeholders with values for your server.

```bash
cp .env.example .env
```

Keep the real `.env` file out of git. Use long random values for passwords, session secrets, S3 credentials, and model API keys.

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

## Deployment Images

| Variable | Required | How to fill |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | Yes | API image reference. The template uses `ghcr.io/farozerolabs/focowiki-api:latest`. Pin a release with a tag such as `:0.2.0`. |
| `FOCOWIKI_ADMIN_IMAGE` | Yes | Admin UI image reference. The template uses `ghcr.io/farozerolabs/focowiki-admin:latest`. Pin the same release tag as the API image. |

## Admin Authentication

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_USERNAME` | Yes | Admin login username. |
| `ADMIN_PASSWORD` | Yes | Admin login password. Use a strong password. |
| `ADMIN_SESSION_SECRET` | Yes | Random session signing secret. Use at least `ADMIN_SESSION_SECRET_MIN_LENGTH` characters. |
| `ADMIN_SESSION_TTL_SECONDS` | Yes | Session lifetime in seconds. Default: `28800`. |
| `ADMIN_SESSION_SECRET_MIN_LENGTH` | Yes | Minimum accepted session secret length. Default: `32`. |
| `ADMIN_SESSION_COOKIE_SECURE` | Yes | Use `true` when serving through HTTPS. Use `false` for local HTTP development. |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | Yes | Cookie SameSite policy. Use `Lax` for standard same-site Admin UI access. |

## Admin API

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_API_PORT` | Yes | Internal or host port for Admin API. Production template default: `43000`. |
| `ADMIN_PUBLIC_ORIGIN` | Yes | Public HTTPS origin for Admin UI, for example `https://foco.example.com`. |
| `ADMIN_API_PUBLIC_ORIGIN` | Yes | Public HTTPS origin for Admin API, for example `https://api.example.com`. |
| `ADMIN_TRUSTED_ORIGINS` | Yes | Comma-separated Admin UI origins allowed to call Admin API. Include the exact browser origin. |
| `ALLOWED_HOSTS` | Yes in production | Comma-separated hostnames accepted by API requests, including reverse-proxy hostnames and local health-check hosts. |
| `TRUSTED_PROXY_MODE` | Yes | Use `true` behind a trusted reverse proxy. Use `false` for local direct access. |

## Admin UI

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_UI_HOST` | Yes | Host interface for Admin UI container. Docker Compose uses `0.0.0.0`. |
| `ADMIN_UI_PORT` | Yes | Host port for Admin UI. Production template default: `43100`. |
| `ADMIN_API_PROXY_TARGET` | Yes | Admin UI server-side proxy target for Admin API. Docker Compose uses `http://api:43000`. Local development usually uses `http://127.0.0.1:43000`. |
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

`REDIS_PORT` exposes Redis to the host. `REDIS_URL` is used by the API and migration process.

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
| `S3_BUCKET` | Yes | Bucket name for source files and generated bundles. |
| `S3_ACCESS_KEY_ID` | Yes | Storage access key ID. |
| `S3_SECRET_ACCESS_KEY` | Yes | Storage secret access key. |
| `S3_PREFIX` | Yes | Internal object-key namespace such as `production`. This value is not exposed in public URLs. |
| `S3_FORCE_PATH_STYLE` | Yes | Use `true` for many S3-compatible providers. Use `false` only when your provider requires virtual-host style addressing. |

Use a dedicated bucket or prefix for each environment.

## Upload and Processing Limits

| Variable | Required | How to fill |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | Yes | Maximum size for each uploaded Markdown file in bytes. |
| `MAX_UPLOAD_FILES` | Yes | Maximum number of files accepted by one upload request. |
| `GENERATION_BATCH_SIZE` | Yes | Batch size used by generation and indexing work. Keep bounded to avoid large in-memory work. |
| `UPLOAD_FILE_PROCESSING_CONCURRENCY` | Yes | Number of files processed concurrently. Use `1` for predictable memory and model usage. |
| `UPLOAD_STORAGE_CONCURRENCY` | No | Number of uploaded source files written to S3-compatible storage concurrently. Keep this separate from model processing concurrency. |
| `OKF_LOG_MAX_ENTRIES` | Yes | Maximum update-log entries kept in generated OKF files. |
| `OKF_LOG_MAX_BYTES` | Yes | Maximum generated update-log size in bytes. |
| `ADMIN_LIST_DEFAULT_PAGE_SIZE` | Yes | Default page size for Admin source-file, task, release, and generated-file lists. |
| `ADMIN_LIST_MAX_PAGE_SIZE` | Yes | Maximum page size accepted by Admin list APIs. |
| `TREE_CHILD_DEFAULT_PAGE_SIZE` | Yes | Default direct-child page size for generated file tree APIs. |
| `TREE_CHILD_MAX_PAGE_SIZE` | Yes | Maximum direct-child page size accepted by generated file tree APIs. |
| `PAGINATION_CURSOR_TTL_SECONDS` | Yes | Redis cursor token lifetime for paginated Admin and Developer OpenAPI reads. |
| `GENERATED_CONTENT_MAX_BYTES` | Yes | Maximum generated file content bytes read into an API response. Larger files return a 413 response. |
| `WORKER_DATABASE_POOL_MAX` | Yes | Maximum PostgreSQL connections used by the worker process. Keep this separate from API pool size. |
| `WORKER_SOURCE_FILE_CONCURRENCY` | Yes | Number of source-file jobs processed concurrently by the worker service. |
| `WORKER_CLAIM_BATCH_SIZE` | Yes | Maximum number of queued jobs claimed by one worker polling pass. |
| `WORKER_POLL_INTERVAL_MS` | Yes | Worker polling interval when no queued jobs are available. |
| `WORKER_LOCK_TTL_SECONDS` | Yes | Time before a running worker job can be reclaimed after a worker crash. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | Yes | Interval for updating running job and worker heartbeat records. |
| `WORKER_JOB_MAX_ATTEMPTS` | Yes | Maximum attempts for infrastructure-level worker failures. File-level processing failures stay visible on the file record. |
| `WORKER_JOB_RETRY_DELAY_MS` | Yes | Delay before retrying an infrastructure-level worker failure. |
| `WORKER_QUEUE_BACKPRESSURE_LIMIT` | Yes | Maximum active source-file worker jobs accepted before upload APIs return `QUEUE_BACKPRESSURE`. |
| `WORKER_QUEUE_BACKPRESSURE_KB_LIMIT` | Yes | Maximum active source-file worker jobs for one knowledge base before upload APIs return `QUEUE_BACKPRESSURE`. |
| `WORKER_QUEUE_BACKPRESSURE_MAX_AGE_SECONDS` | Yes | Maximum oldest queued job age before upload APIs ask clients to slow down. |
| `WORKER_QUEUE_BACKPRESSURE_RETRY_AFTER_SECONDS` | Yes | Retry guidance returned with `QUEUE_BACKPRESSURE`. |
| `WORKER_SHUTDOWN_GRACE_MS` | Yes | Grace period used by deployments when stopping worker processes. |
| `WORKER_COMPLETED_JOB_RETENTION_DAYS` | Yes | Days to keep completed worker job history before cleanup. |
| `WORKER_FAILED_JOB_RETENTION_DAYS` | Yes | Days to keep failed worker job history before cleanup. |
| `WORKER_DEAD_LETTER_JOB_RETENTION_DAYS` | Yes | Days to keep dead-letter worker job history before cleanup. |
| `WORKER_RETENTION_CLEANUP_BATCH_SIZE` | Yes | Maximum worker job rows removed in one cleanup pass. |
| `PUBLICATION_MODE` | Yes | Publication mode. Use `batch` for normal deployments, `per_file` for immediate publication, or `manual` for explicit publication workflows. |
| `PUBLICATION_BATCH_SIZE` | Yes | Number of dirty completed files that triggers a batch publication. |
| `PUBLICATION_INTERVAL_SECONDS` | Yes | Maximum age of pending dirty files before the next processing pass can trigger publication. |
| `INDEX_SHARD_SIZE` | Yes | Maximum number of entries per generated `_index` shard. |
| `LINK_INDEX_SHARD_SIZE` | Yes | Maximum number of entries per generated link-index shard. |
| `MANIFEST_SHARD_SIZE` | Yes | Maximum number of entries per generated manifest shard. |
| `GRAPH_EDGE_SHARD_SIZE` | Yes | Maximum number of graph edges per generated graph shard. |
| `GRAPH_CANDIDATE_LIMIT` | Yes | Maximum number of candidate graph nodes inspected for one source file. |
| `GRAPH_MAINTENANCE_BATCH_SIZE` | Yes | Maximum graph maintenance batch size for bounded graph refresh work. |
| `ROOT_SUMMARY_LIMIT` | Yes | Maximum source-backed page summaries included directly in root Markdown files such as `index.md` and `log.md`. Full indexes remain available through `_index` shards. |

For an 8-core, 32 GB server, start with `DATABASE_POOL_MAX=12`, `WORKER_DATABASE_POOL_MAX=8`, `WORKER_SOURCE_FILE_CONCURRENCY=2`, `WORKER_CLAIM_BATCH_SIZE=10`, `UPLOAD_FILE_PROCESSING_CONCURRENCY=1`, and `UPLOAD_STORAGE_CONCURRENCY=4`. Raise values only after observing CPU, memory, S3 throughput, database latency, and model latency. Keep PostgreSQL connections within `api replicas * DATABASE_POOL_MAX + worker replicas * WORKER_DATABASE_POOL_MAX + migration headroom + operational headroom`.

### Large imports and publication visibility

File processing and generated output publication are separate runtime steps. A file can finish parsing, model assistance, graph generation, and page preparation before it appears in the active file tree. In `batch` mode, Focowiki marks completed files as pending publication and publishes a new active OKF-style knowledge base when the dirty file count reaches `PUBLICATION_BATCH_SIZE` or the configured interval is reached during processing.

The file-processing list shows the per-file lifecycle and the generated-output visibility state. The file tree and Developer OpenAPI content reads always use the active published release. Large indexes are written as shard descriptors and JSONL shard files when they exceed the configured shard sizes, so Agents can discover shard paths from `_index/search.json`, `_index/links.json`, and `_index/manifest.json`. Root Markdown files use `ROOT_SUMMARY_LIMIT` to stay readable during large imports while complete machine-readable data remains in shards.

## Security Limits

| Variable | Required | How to fill |
| --- | --- | --- |
| `ADMIN_LOGIN_RATE_LIMIT_MAX` | Yes | Maximum login attempts per window. Default: `8`. |
| `ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS` | Yes | Login rate-limit window in seconds. Default: `900`. |
| `ADMIN_API_RATE_LIMIT_MAX` | Yes | Maximum Admin API requests per window. |
| `ADMIN_API_RATE_LIMIT_WINDOW_SECONDS` | Yes | Admin API rate-limit window in seconds. |
| `UPLOAD_RATE_LIMIT_MAX` | Yes | Maximum upload requests per window. |
| `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` | Yes | Upload rate-limit window in seconds. |
| `PUBLIC_OPENAPI_RATE_LIMIT_MAX` | Yes | Maximum Developer OpenAPI requests per window. |
| `PUBLIC_OPENAPI_RATE_LIMIT_WINDOW_SECONDS` | Yes | Developer OpenAPI rate-limit window in seconds. |
| `SECURITY_AUDIT_RETENTION_DAYS` | Yes | Number of days to keep security audit records. |

Tune these values with your reverse proxy and Cloudflare or other edge-layer limits.

## Model Assistance

| Variable | Required | How to fill |
| --- | --- | --- |
| `MODEL_BASE_URL` | Optional | OpenAI-compatible API base URL. Default template value: `https://api.openai.com/v1`. |
| `MODEL_API_KEY` | Optional | Model provider API key. Leave empty to disable model-assisted enrichment. |
| `MODEL_NAME` | Optional | Model name used for metadata and relationship suggestions. Leave empty to disable model-assisted enrichment. |
| `MODEL_CONTEXT_WINDOW_TOKENS` | Optional | Approximate context window used to choose how much Markdown content to send to the model. |
| `MODEL_REQUEST_MAX_TIMEOUT_MS` | Optional | Maximum total model request time. |
| `MODEL_REQUEST_IDLE_TIMEOUT_MS` | Optional | Maximum idle time while waiting for model output. |
| `MODEL_TRANSIENT_RETRY_DELAY_MS` | Optional | Delay before the second model attempt after transient provider errors such as rate limits or credential cooling. |
| `MODEL_REQUEST_MIN_INTERVAL_MS` | Optional | Minimum delay between model request starts. Increase this value when the provider rate-limits long import runs. |
| `MODEL_SUGGESTION_CONCURRENCY` | Optional | Number of concurrent model suggestion calls. Keep low for stability and provider rate limits. |

Model assistance uses OpenAI-compatible Structured Outputs. When `MODEL_API_KEY` or `MODEL_NAME` is empty, upload and OKF generation continue without model suggestions.

## Production Checklist

Before running `docker compose up -d`, confirm:

1. Every placeholder value has been replaced.
2. `ADMIN_SESSION_SECRET`, `POSTGRES_PASSWORD`, `S3_SECRET_ACCESS_KEY`, and `MODEL_API_KEY` are private.
3. Public origins match your reverse proxy domains.
4. `ALLOWED_HOSTS` includes Admin UI, Admin API, Developer OpenAPI, `127.0.0.1`, and `localhost` when local health checks run inside containers.
5. `DATABASE_URL` and `REDIS_URL` use Compose service names in Docker deployments.
6. `LOG_FILE_HOST_DIR` points to a writable directory under the deployment directory.
7. S3 credentials can read and write the configured bucket and prefix.
