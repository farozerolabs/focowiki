# Focowiki File Knowledge Base

Focowiki is a minimal OKF-style Markdown knowledge-base generator. Admin users upload cleaned `.md` files, the backend parses optional Markdown frontmatter, generates a public OKF-style Markdown tree, publishes it to S3-compatible storage, and exposes scoped Markdown/JSON files for developers and agents.

## Workspace

This repository uses pnpm and TypeScript.

```bash
pnpm install
cp .env.dev.example .env
cp docker-compose.dev.yml.example docker-compose.dev.yml
docker compose -f docker-compose.dev.yml up -d postgres redis
pnpm --filter @focowiki/api db:migrate
pnpm dev
pnpm verify
pnpm build
```

Workspace packages:

- `apps/api`: Hono API server, admin endpoints, public file endpoints, runtime config, and S3 storage.
- `apps/admin`: Vite React admin console with shadcn/ui components and `en-US` / `zh-CN` i18n resources.
- `packages/okf`: metadata resolution, OKF-style bundle generation, indexes, and optional model assistance helpers.

## Local Development

The root dev script starts the Admin API, public OpenAPI, and admin app in parallel:

- Admin API: `http://127.0.0.1:43000`
- Admin UI: `http://127.0.0.1:43100`
- Public OpenAPI file reads: `http://127.0.0.1:43200`

```bash
cp .env.dev.example .env
cp docker-compose.dev.yml.example docker-compose.dev.yml
docker compose -f docker-compose.dev.yml up -d postgres redis
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

Edit `.env` to configure admin auth, public API auth, S3-compatible storage, upload limits, and optional model assistance. The API process loads the root `.env` file automatically. Set `ENV_FILE=/absolute/path/to/.env` to load a different file.

Open `http://127.0.0.1:43100/` and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Admin UI language is switched from the page and is not configured through environment variables.

Real upload parsing publishes source and generated files through S3-compatible APIs. A dummy `S3_ENDPOINT` is enough to verify login and form validation, but upload parsing fails until a compatible object store is available.

For a pre-release destructive local reset, stop the app, remove the Compose volumes, start PostgreSQL and Redis again, then rerun migrations. Pre-release schema changes do not keep compatibility readers or local backfills for stale rows, so re-upload Markdown samples after the reset:

```bash
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d postgres redis
pnpm --filter @focowiki/api db:migrate
```

## Docker Compose Deployment

The repository commits Compose templates, not real local Compose files. Copy the templates before running Docker Compose:

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

Docker Compose reads the root `.env` file by default. Keep deployment values in that file and do not pass temporary env files for normal runs.

The deployment stack builds two application images:

- `api`: Node runtime for bundled Admin API and public OpenAPI entrypoints.
- `admin`: static Admin UI runtime served from the production build.

The stack also runs PostgreSQL and Redis with persistent named volumes. S3-compatible storage is external and must be configured through `S3_ENDPOINT`, bucket, region, credentials, prefix, and path-style mode before upload parsing is used. The one-shot `migrate` service runs database migrations explicitly before the API service is considered ready.

Real local `docker-compose.yml` and `docker-compose.dev.yml` are ignored by git. Keep deployment secrets in local `.env` or your runtime secret manager. Do not commit copied Compose files, credentials, local paths, S3 keys, model keys, session secrets, or raw Markdown data.

Useful commands:

```bash
pnpm compose:config
pnpm compose:dev:config
pnpm compose:build
pnpm compose:migrate
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down
pnpm compose:clean
pnpm compose:dev:clean
```

`pnpm compose:clean` removes deployment containers, named volumes, orphans, and local Compose-built images before a fresh deployment rebuild. `pnpm compose:dev:clean` removes development infrastructure containers, named volumes, and orphans. Both commands are destructive for local PostgreSQL and Redis data.

For public deployment behind a reverse proxy, replace every placeholder in `.env.example`, use HTTPS public origins, set `ALLOWED_HOSTS`, set `ADMIN_TRUSTED_ORIGINS`, enable `TRUSTED_PROXY_MODE` only for trusted proxies, and keep PostgreSQL, Redis, and external S3-compatible storage private. Expose only the Admin UI, Admin API, and public OpenAPI routes that your deployment requires.

For a pre-release destructive deployment reset, stop the deployment stack, remove its volumes, rerun migrations, and re-upload Markdown files:

```bash
pnpm compose:clean
pnpm compose:build
pnpm compose:migrate
pnpm compose:up
```

## Environment Variables

Required admin configuration:

- `APP_ENV`: `development` or `production`. Production enables stricter secret, HTTPS origin, host, and cookie validation.
- `ADMIN_USERNAME`: admin login username.
- `ADMIN_PASSWORD`: admin login password.
- `ADMIN_SESSION_SECRET`: signing secret for HTTP-only admin session cookies. Generate a unique high-entropy value for each deployment.
- `ADMIN_SESSION_TTL_SECONDS`, `ADMIN_SESSION_SECRET_MIN_LENGTH`, `ADMIN_SESSION_COOKIE_SECURE`, `ADMIN_SESSION_COOKIE_SAME_SITE`: session lifetime and cookie safety controls. Production requires secure cookies.
- `ADMIN_API_PORT`: internal Admin API listen port. Defaults to `43000` when omitted.
- `ADMIN_UI_HOST`: local pnpm/Vite admin UI listen host. It is not used by the Docker Admin runtime.
- `ADMIN_UI_PORT`: local or Docker Admin UI port. Defaults to `43100` when omitted.
- `ADMIN_API_PROXY_TARGET`: Admin UI proxy target. In Docker deployment it should point to the internal API service, for example `http://api:43000`.
- `ADMIN_PUBLIC_ORIGIN`, `ADMIN_API_PUBLIC_ORIGIN`, `PUBLIC_OPENAPI_PUBLIC_ORIGIN`: externally visible origins used for reverse-proxy deployments and production validation.
- `ADMIN_TRUSTED_ORIGINS`: comma-separated origins allowed to submit Admin API state-changing browser requests.
- `ALLOWED_HOSTS`: comma-separated public hosts accepted in production mode.
- `TRUSTED_PROXY_MODE`: set `true` only when trusted reverse-proxy forwarded headers should be used.
- `VITE_ADMIN_API_BASE_URL`: optional browser-visible Admin API base URL. Leave empty when the Admin UI proxies `/admin/api`.

Required infrastructure configuration:

- `DATABASE_URL`: PostgreSQL connection URL for production admin records.
- `REDIS_URL`: Redis connection URL for sessions, coordination, locks, pagination cursor/cache state, and security rate-limit counters.
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `REDIS_PORT`: bundled Compose service defaults and local host-published development ports. Production deployments should keep PostgreSQL and Redis private behind Compose or private infrastructure.

Required public OpenAPI configuration:

- `PUBLIC_OPENAPI_PORT`: public OpenAPI file-read listen port. Defaults to `43200` when omitted.
- `PUBLIC_BASE_URL`: base URL for the public OpenAPI file-read endpoints and generated public file URLs.
- Public OpenAPI bearer keys are generated and managed in the Admin UI under `OpenAPI keys`. They are stored as database-backed hash-only records and are not configured in `.env`.

Required storage and upload configuration:

- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PREFIX`: external object storage configuration.
- `S3_PREFIX`: internal object-key namespace, such as `dev`; it is never exposed in public URLs.
- `S3_FORCE_PATH_STYLE`: set `true` for many S3-compatible local or self-hosted stores.
- `MAX_UPLOAD_BYTES`: maximum bytes accepted in one upload request.
- `MAX_UPLOAD_FILES`: maximum number of files accepted in one upload request.
- `GENERATION_BATCH_SIZE`: bounded OKF generation batch size.
- `UPLOAD_TASK_CONCURRENCY`: active upload parsing and generation tasks per API process. Default `1`.
- `UPLOAD_FILE_PROCESSING_CONCURRENCY`: per-task Markdown source processing and OKF publication concurrency. Default `1`.
- `OKF_LOG_MAX_ENTRIES`: newest public update entries retained in generated `log.md`. Default `100`.
- `OKF_LOG_MAX_BYTES`: maximum generated `log.md` Markdown size. Default `65536`.

Optional:

- `ADMIN_LIST_PAGE_SIZE`, `ADMIN_LIST_MAX_PAGE_SIZE`, `ADMIN_PAGINATION_CURSOR_TTL_SECONDS`: bounded admin pagination defaults and Redis cursor TTL.
- `CORS_ORIGINS`: comma-separated allowed origins for public file responses.
- `ADMIN_LOGIN_RATE_LIMIT_MAX`, `ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed admin login throttle.
- `ADMIN_API_RATE_LIMIT_MAX`, `ADMIN_API_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed Admin API request throttle.
- `UPLOAD_RATE_LIMIT_MAX`, `UPLOAD_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed upload request throttle.
- `PUBLIC_OPENAPI_RATE_LIMIT_MAX`, `PUBLIC_OPENAPI_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed public OpenAPI read throttle.
- `SECURITY_AUDIT_RETENTION_DAYS`: planned retention window for persisted security audit evidence.
- `MODEL_BASE_URL`: OpenAI-compatible Responses API base URL. Defaults to `https://api.openai.com/v1` when model assistance is enabled and this value is omitted.
- `MODEL_API_KEY`: model bearer credential.
- `MODEL_NAME`: model name for optional assistance.
- `MODEL_CONTEXT_WINDOW_TOKENS`: required when model assistance is enabled; examples include `200000` or `2000000`.
- `MODEL_REQUEST_MAX_TIMEOUT_MS`: hard maximum model request receive timeout. Default `120000`.
- `MODEL_REQUEST_IDLE_TIMEOUT_MS`: idle no-progress model receive timeout. Default `30000`.
- `MODEL_SUGGESTION_CONCURRENCY`: concurrent model suggestion requests. Default `2`.

If either `MODEL_API_KEY` or `MODEL_NAME` is missing, model assistance is disabled and generation remains deterministic.

## Generated Bundle and Storage

Upload parsing writes raw source files and generated bundle files under knowledge base scoped internal object keys:

```text
S3_PREFIX/
  knowledge-bases/{knowledgeBaseId}/
    uploads/{taskId}/sources/{sourceFileId}/{originalFileName}
    releases/{releaseId}/bundle/
      index.md
      log.md
      schema.md
      pages/*.md
      _index/manifest.json
      _index/search.json
      _index/links.json
```

`index.md` is a reserved navigation file and does not include frontmatter. `log.md` is a reserved rolling update history file and does not include frontmatter. It is regenerated from PostgreSQL release/task facts on publication, keeps the newest bounded public entries, and summarizes older persisted history by month. `schema.md` and `pages/*.md` are public concept files with YAML frontmatter, non-empty `type`, and non-empty `title`. Raw uploaded source objects remain internal under the upload path and are not part of the public bundle tree.

The database stores knowledge base records, task lifecycle rows, source file records, release records, generated file records, checksums, metadata summaries, and S3 object keys. Raw uploaded Markdown and generated Markdown/JSON bodies stay in S3-compatible storage.

## Public File API

The public API serves knowledge base scoped raw files without a business JSON envelope:

```text
GET /kb/{knowledgeBaseId}/index.md
GET /kb/{knowledgeBaseId}/log.md
GET /kb/{knowledgeBaseId}/schema.md
GET /kb/{knowledgeBaseId}/pages/{file}.md
GET /kb/{knowledgeBaseId}/_index/manifest.json
GET /kb/{knowledgeBaseId}/_index/search.json
GET /kb/{knowledgeBaseId}/_index/links.json
GET /kb/{knowledgeBaseId}/tasks/latest
```

`PUBLIC_BASE_URL` must point to the public OpenAPI service. Use HTTPS public origins in production; local development may use `http://127.0.0.1:43200`. Admin UI and Admin API URLs are separate. Public URLs are built as `PUBLIC_BASE_URL + /kb/{knowledgeBaseId}/...` and do not expose S3 bucket names, `S3_PREFIX`, release IDs, task IDs used in storage keys, or raw object keys.

Public OpenAPI reads always require `Authorization: Bearer <Admin-generated OpenAPI key>`. Open the Admin UI, switch to `OpenAPI keys`, and copy the generated key once after deployment. Successful file reads return raw Markdown or JSON. Failed public reads return small JSON errors with stable codes.

Unsupported public methods return stable JSON errors and do not mutate knowledge bases, source files, tasks, releases, storage objects, or indexes. Public reads are rate-limited through Redis before storage or expensive repository work.

## Security Baseline

The Admin API is the authorization boundary. The Admin UI route guard only controls rendering; every protected Admin API request validates the signed Redis-backed session server-side. Cookie-authenticated state-changing Admin API requests also require a trusted `Origin` or `Referer`.

Production mode rejects placeholder secrets, weak admin session secrets, insecure public origins, insecure session-cookie settings, wildcard private CORS, and missing allowed hosts before serving traffic. Login failures, login throttling, invalid sessions, origin rejection, logout, and selected upload/public rate-limit events write redacted audit evidence without passwords, cookies, API keys, S3 object keys, local paths, or raw Markdown bodies.

When deploying behind a domain reverse proxy, set the public origins, `ALLOWED_HOSTS`, and `TRUSTED_PROXY_MODE` explicitly. The product should be reached through HTTPS in production; internal loopback, database, Redis, and S3 endpoints must not be exposed in rendered UI or public file URLs.

## Real Legal Markdown Release-Gate Validation

The validation scripts can exercise a local-only real cleaned legal Markdown dataset without committing the dataset, local paths, or raw document bodies. The legal dataset is validation input only; product behavior remains domain-agnostic. Configure the dataset only in the local shell or a local `.env` file:

```bash
FOCOWIKI_VALIDATION_MARKDOWN_DIR=<local-cleaned-markdown-directory>
FOCOWIKI_VALIDATION_SAMPLE_COUNT=24
FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT=23
FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS=180000
```

Run the bounded sample selector first. It records only basenames, counts, hashes, and coverage metadata:

```bash
pnpm validate:real-legal:samples
```

With PostgreSQL, Redis, S3-compatible storage, Admin API, Admin UI, and public OpenAPI running, validate the API, backend, storage, Redis, OKF files, public reads, security headers, audit evidence, source-backed page deletion, republish, and knowledge base deletion:

```bash
pnpm validate:real-legal:api
```

Run the browser flow against the admin UI:

```bash
pnpm validate:real-legal:browser
```

For a large-scale release-gate run, use the separate profile. It keeps the same scripts and services but requires one batch upload action with at least 50 selected Markdown files:

```bash
FOCOWIKI_VALIDATION_MIN_BATCH_FILES=50
FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS=900000
FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS=5000
FOCOWIKI_VALIDATION_MAX_TASK_DURATION_MS=900000
FOCOWIKI_VALIDATION_MAX_MEMORY_DELTA_MB=512

pnpm validate:real-legal:large:samples
pnpm validate:real-legal:large:api
pnpm validate:real-legal:large:browser
```

The large-scale profile validates black-box Admin API, Admin UI, and public OpenAPI behavior; white-box PostgreSQL, Redis, S3-compatible storage, generated OKF files, JSON indexes, pagination, audit evidence, and deletion state; security behavior for auth, origin checks, upload rejection, path safety, public keys, headers, and redaction; and performance evidence for endpoint timing, task duration, pagination pages, and process memory growth. It records only safe basenames, counts, redacted URLs, metrics, and failure summaries.

The legacy `validate:cleaned-legal:*` aliases remain available and run the same validation scripts. Validation reports are written under the active OpenSpec change directory, which is ignored by git. Reports must stay redacted: no local absolute paths, private dataset names, credentials, raw S3 object keys, provider secrets, model prompts, session cookies, or raw source document bodies.

## Admin Pagination

Every admin list and file tree read is cursor-paginated through PostgreSQL queries with bounded limits. This includes knowledge base cards, generated file tree directory pages, source files, releases, bundle files, upload tasks, and task phase details.

Redis stores opaque admin pagination cursors, short-lived page cache state, invalidation markers, admin sessions, task locks, and short-lived task refresh markers. PostgreSQL remains the source of truth for product records and task lifecycle rows. The API must not load full knowledge base trees, full source lists, full release lists, or full task histories into process memory for normal admin reads.

## OpenAI Structured Outputs

Optional model assistance uses the OpenAI Responses API Structured Outputs format. The request uses `text.format` with:

- `type: "json_schema"`
- `name: "focowiki_model_suggestions"`
- `strict: true`
- a project-owned JSON Schema

The schema allows only:

- `title`
- `type`
- `description`
- `tags`
- `related_links`
- `keywords`

Every object schema sets `additionalProperties: false`. The implementation validates model output locally before using it. Model suggestions may fill missing generic presentation metadata, add related Markdown links, and add search keywords. They do not create or override fact metadata such as `resource`, `timestamp`, official identifiers, source URLs, legal status, hashes, owner fields, or user-provided fields.

If the first model response refuses, returns incomplete output, fails schema validation, stalls, times out, or the provider call fails, the generator makes one bounded repair attempt with sanitized error context. If the repair attempt also fails, generation continues without model suggestions and returns safe warnings.

## Dependency Policy

Use pnpm for all dependency changes. When adding dependencies, request current latest versions, for example:

```bash
pnpm add hono@latest
pnpm add -D vitest@latest
pnpm dlx shadcn@latest
```

Resolved versions are recorded in `pnpm-lock.yaml`. Keep imports and generated code compatible with the locked versions.

## Current Limitations

- Uploaded source files must be `.md`.
- `.txt`, `.json`, `.yaml`, `.yml`, `.zip`, sidecar metadata files, archives, and upload-to-Markdown conversion are not accepted in this version.
- Metadata comes from Markdown frontmatter, deterministic Markdown signals, filename fallback, and optional model suggestions for missing generic fields.
- PostgreSQL and Redis are required for production admin state, sessions, coordination, and paginated admin reads.
- There is no CMS workspace, collaboration workflow, vector search, embedding pipeline, or server-side query engine.
- Search is a generated static `_index/search.json` file.
- The MVP does not generate a formal OpenAPI specification file.
- Admin review is read-only; generated files are not editable in the UI.

## References

- [Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
