# Focowiki

[中文](./README.zh-CN.md) | English

Focowiki is a lightweight Markdown knowledge-base system for developers and product managers. It accepts cleaned `.md` files, extracts Markdown frontmatter and document signals, generates an OKF-style public bundle, stores source and generated files in S3-compatible storage, and exposes knowledge-base operations through an Admin UI, Admin API, and Developer OpenAPI.

Focowiki is designed for teams that already have Markdown knowledge assets and want a small self-hosted service that produces file-based knowledge bundles for people, applications, and agents.

## What Focowiki Does

- Upload one or more `.md` files from the Admin UI.
- Parse YAML frontmatter, Markdown headings, Markdown links, and body content.
- Preserve safe domain metadata from frontmatter as pass-through metadata.
- Generate an OKF-style bundle with `index.md`, `log.md`, `schema.md`, `pages/*.md`, and JSON indexes.
- Store raw uploaded source files and generated bundle files in S3-compatible storage.
- Persist knowledge bases, upload tasks, source file records, release records, generated file records, cursors, and API keys through PostgreSQL and Redis-backed coordination.
- Expose knowledge-base CRUD, Markdown upload, task observation, generated file reads, deletion, and webhooks through Developer OpenAPI protected by Admin-generated bearer keys.

## Open Knowledge Format

[Google's Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/) describes OKF as an open, portable, human-readable, and agent-readable way to represent knowledge as Markdown files with YAML frontmatter.

The [OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) defines the field conventions and bundle structure. Core OKF ideas used by Focowiki include:

- Markdown files as the readable knowledge unit.
- YAML frontmatter for structured metadata.
- Markdown links for relationships between concepts.
- A file bundle that can be read by humans, developers, tools, and agents.

## Focowiki and OKF

Focowiki generates an OKF-style public bundle from uploaded Markdown files. The generated bundle follows the same practical model: Markdown pages, YAML frontmatter, links, indexes, and a stable file tree.

Focowiki keeps the implementation intentionally small. It focuses on Markdown intake, deterministic bundle generation, optional OpenAI-compatible Structured Outputs assistance, S3-compatible persistence, Admin workflows, and Developer OpenAPI integration. The project uses the OKF model as the output convention and links to the Google specification for readers who need formal format details.

## Markdown Upload Format

Uploads accept `.md` files. Each file can include YAML frontmatter followed by Markdown body content.

```md
---
type: "page"
title: "Customer Support Playbook"
description: "How the support team handles priority customer requests."
resource: "https://example.com/docs/support-playbook"
tags:
  - support
  - operations
timestamp: "2026-06-16T00:00:00Z"
owner: "Support Operations"
sourceSystem: "company-wiki"
---

# Customer Support Playbook

Use this playbook when a priority customer request arrives.

## Intake

Record the customer, request summary, severity, and expected response time.

## Related Documents

- [Escalation rules](./escalation-rules.md)
- [Incident handoff](./incident-handoff.md)
```

Common OKF-style fields:

- `type`: content kind, such as `page`.
- `title`: display title for the generated page.
- `description`: short summary for readers and search.
- `resource`: source URL or canonical reference when one exists.
- `tags`: searchable tags.
- `timestamp`: source, publication, or update timestamp.

Additional safe frontmatter fields can be preserved. Domain-specific fields such as owner, region, product, version, source system, official identifier, status, or category can pass through when they are present in the uploaded Markdown. Focowiki treats those fields as source metadata and keeps the product contract generic.

Markdown links are the primary relationship mechanism. Links in body content help readers and agents move from one generated page to related pages.

Current upload scope accepts `.md` files only. `.txt`, `.json`, `.yaml`, `.yml`, `.zip`, sidecar metadata files, archive uploads, and upload-to-Markdown conversion are outside the current product scope.

## Quick Start

This path runs the API services and Admin UI from pnpm, with PostgreSQL and Redis from the local Compose template.

```bash
pnpm install
cp .env.dev.example .env
cp docker-compose.local.yml.example docker-compose.local.yml
docker compose -f docker-compose.local.yml up -d postgres redis
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

Local service URLs:

- Admin UI: `http://127.0.0.1:43100`
- Admin API: `http://127.0.0.1:43000`
- Developer OpenAPI: `http://127.0.0.1:43200`

Open the Admin UI and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`. The Admin UI language switch is in the page header.

Real upload parsing requires S3-compatible storage. The development template gives local PostgreSQL and Redis only; configure `S3_ENDPOINT`, bucket, region, credentials, prefix, and path-style mode in `.env` before testing uploads.

## Docker Compose Deployment

The repository commits Compose templates. Copy the production template, fill `.env`, pull images from GitHub Container Registry, run migrations, and start the stack.

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

Default production images:

- `ghcr.io/farozerolabs/focowiki-api:latest`
- `ghcr.io/farozerolabs/focowiki-admin:latest`

The Docker Compose template uses `latest` by default. To pin a release, set the image tag directly in `.env`, for example:

```env
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
```

For private GHCR packages, run `docker login ghcr.io` before pulling images.

Production deployment requires:

- PostgreSQL for product records, tasks, releases, generated file records, OpenAPI key records, and audit evidence.
- Redis for sessions, rate limits, cursors, coordination, locks, and short-lived task refresh state.
- External S3-compatible storage for uploaded source files and generated public bundles.
- HTTPS public origins for Admin UI, Admin API, and Developer OpenAPI behind your reverse proxy.

Docker Compose reads the root `.env` file by default. Real `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.local.yml`, `.env`, credentials, local paths, S3 keys, model keys, session secrets, and raw Markdown data should stay out of git.

Useful production Compose commands:

```bash
pnpm compose:config
pnpm compose:example:config
pnpm compose:pull
pnpm compose:migrate
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down
pnpm compose:clean
```

`pnpm compose:clean` removes deployment containers, named volumes, orphans, and local copies of images used by the production Compose stack. It also removes local PostgreSQL and Redis data owned by that stack.

## Local Development

This repository uses pnpm and TypeScript.

Workspace packages:

- `apps/api`: Hono API server, Admin endpoints, Developer OpenAPI endpoints, runtime config, database repositories, Redis coordination, webhook delivery, and S3 storage.
- `apps/admin`: Vite React Admin UI with shadcn/ui components and `en-US` / `zh-CN` i18n resources.
- `packages/okf`: metadata resolution, OKF-style bundle generation, indexes, logs, and optional model assistance helpers.

Host-based development uses the local infrastructure template:

```bash
cp .env.dev.example .env
cp docker-compose.local.yml.example docker-compose.local.yml
pnpm compose:local:up
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

Useful local infrastructure commands:

```bash
pnpm compose:local:config
pnpm compose:local:example:config
pnpm compose:local:up
pnpm compose:local:ps
pnpm compose:local:down
pnpm compose:local:clean
```

`pnpm compose:local:clean` removes local PostgreSQL and Redis containers, named volumes, and orphans for the local infrastructure stack.

Docker development builds local API and Admin images from the Dockerfile:

```bash
cp .env.dev.example .env
cp docker-compose.dev.yml.example docker-compose.dev.yml
pnpm compose:dev:build
pnpm compose:dev:migrate
pnpm compose:dev:up
```

Useful Docker development commands:

```bash
pnpm compose:dev:config
pnpm compose:dev:example:config
pnpm compose:dev:build
pnpm compose:dev:migrate
pnpm compose:dev:up
pnpm compose:dev:ps
pnpm compose:dev:logs
pnpm compose:dev:down
pnpm compose:dev:clean
```

`pnpm compose:dev:clean` removes Docker development containers, named volumes, orphans, and locally built images used by the Docker development Compose stack.

## Configuration

Use `.env.dev.example` for local development and `.env.example` for deployment. The API process loads the root `.env` file automatically. Set `ENV_FILE=/absolute/path/to/.env` only when a different local file should be loaded.

Admin and public origins:

- `APP_ENV`: `development` or `production`.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`: Admin login credentials.
- `ADMIN_SESSION_SECRET`: high-entropy signing secret for HTTP-only Admin session cookies.
- `ADMIN_SESSION_TTL_SECONDS`, `ADMIN_SESSION_SECRET_MIN_LENGTH`, `ADMIN_SESSION_COOKIE_SECURE`, `ADMIN_SESSION_COOKIE_SAME_SITE`: session lifetime and cookie controls.
- `ADMIN_API_PORT`, `ADMIN_UI_HOST`, `ADMIN_UI_PORT`, `ADMIN_API_PROXY_TARGET`: Admin API and Admin UI runtime ports and proxy target.
- `ADMIN_PUBLIC_ORIGIN`, `ADMIN_API_PUBLIC_ORIGIN`, `PUBLIC_OPENAPI_PUBLIC_ORIGIN`: externally visible origins.
- `ADMIN_TRUSTED_ORIGINS`, `ALLOWED_HOSTS`, `TRUSTED_PROXY_MODE`, `CORS_ORIGINS`: browser, host, proxy, and public response controls.

Infrastructure:

- `DATABASE_URL`: PostgreSQL connection URL.
- `REDIS_URL`: Redis connection URL.
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `REDIS_PORT`: bundled Compose service settings and local host-published ports.

S3-compatible storage:

- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: object storage connection settings.
- `S3_PREFIX`: internal object-key namespace. Public URLs never expose this value.
- `S3_FORCE_PATH_STYLE`: set `true` for many local or self-hosted S3-compatible services.

Developer OpenAPI:

- `PUBLIC_OPENAPI_PORT`: Developer OpenAPI service port.
- `PUBLIC_BASE_URL`: base URL used for generated Developer OpenAPI file URLs.
- Developer OpenAPI bearer keys are generated and managed in the Admin UI under `OpenAPI keys`. Keys are stored as database-backed hash-only records.

Upload, generation, and pagination:

- `MAX_UPLOAD_BYTES`, `MAX_UPLOAD_FILES`: upload request bounds.
- `GENERATION_BATCH_SIZE`: bounded OKF generation batch size.
- `UPLOAD_TASK_CONCURRENCY`: active upload parsing and generation tasks per API process.
- `UPLOAD_FILE_PROCESSING_CONCURRENCY`: per-task Markdown source processing and OKF publication concurrency.
- `OKF_LOG_MAX_ENTRIES`, `OKF_LOG_MAX_BYTES`: rolling generated `log.md` bounds.
- `ADMIN_LIST_PAGE_SIZE`, `ADMIN_LIST_MAX_PAGE_SIZE`, `ADMIN_PAGINATION_CURSOR_TTL_SECONDS`: bounded Admin pagination defaults and Redis cursor TTL.

Security limits:

- `ADMIN_LOGIN_RATE_LIMIT_MAX`, `ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed Admin login throttle.
- `ADMIN_API_RATE_LIMIT_MAX`, `ADMIN_API_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed Admin API request throttle.
- `UPLOAD_RATE_LIMIT_MAX`, `UPLOAD_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed upload request throttle.
- `PUBLIC_OPENAPI_RATE_LIMIT_MAX`, `PUBLIC_OPENAPI_RATE_LIMIT_WINDOW_SECONDS`: Redis-backed Developer OpenAPI request throttle.
- `SECURITY_AUDIT_RETENTION_DAYS`: retention window for persisted security audit evidence.

Optional model assistance:

- `MODEL_BASE_URL`: OpenAI-compatible Responses API base URL. Defaults to `https://api.openai.com/v1` when model assistance is enabled and this value is empty.
- `MODEL_API_KEY`: model bearer credential.
- `MODEL_NAME`: model name.
- `MODEL_CONTEXT_WINDOW_TOKENS`: model context window used to decide how much Markdown can be sent.
- `MODEL_REQUEST_MAX_TIMEOUT_MS`: hard maximum model receive timeout.
- `MODEL_REQUEST_IDLE_TIMEOUT_MS`: idle no-progress receive timeout.
- `MODEL_SUGGESTION_CONCURRENCY`: concurrent model suggestion requests.

Model assistance stays disabled when either `MODEL_API_KEY` or `MODEL_NAME` is empty.

## Generated Bundle

Focowiki writes raw source files and generated bundle files under knowledge base scoped internal object keys in S3-compatible storage. Developer OpenAPI URLs expose only product-level identifiers and logical paths.

Generated bundle files:

```text
index.md
log.md
schema.md
pages/*.md
_index/manifest.json
_index/search.json
_index/links.json
```

Developer OpenAPI endpoint groups:

```text
GET    /openapi/v1/health
GET    /openapi/v1/version
GET    /openapi/v1/openapi.json
POST   /openapi/v1/knowledge-bases
GET    /openapi/v1/knowledge-bases
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}
DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}
POST   /openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks/{taskId}
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/tree
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content?path=pages%2Fexample.md
DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}
DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files?path=pages%2Fexample.md
POST   /openapi/v1/webhooks
GET    /openapi/v1/webhooks
DELETE /openapi/v1/webhooks/{webhookId}
GET    /openapi/v1/webhook-deliveries
POST   /openapi/v1/webhook-deliveries/{deliveryId}/redeliver
```

The health endpoint returns only health state. Use `/openapi/v1/version` for product and API version metadata, and `/openapi/v1/openapi.json` for the machine-readable contract.

`index.md` is the public navigation file. `log.md` is a bounded rolling update history generated from persisted release and task facts. `schema.md` describes the generated bundle metadata shape. `pages/*.md` contains public concept pages with YAML frontmatter. `_index/*.json` contains generated machine-readable indexes for manifests, search, and links.

The database stores knowledge base records, task lifecycle rows, source file records, release records, generated file records, checksums, metadata summaries, and S3 object-key mappings. Raw uploaded Markdown and generated Markdown/JSON bodies stay in S3-compatible storage. Public responses never expose bucket names, `S3_PREFIX`, internal release IDs, storage task IDs, or raw object keys.

Every Developer OpenAPI route requires `Authorization: Bearer <Admin-generated OpenAPI key>`. Key lifecycle remains Admin-only and is not exposed through Developer OpenAPI. Responses keep reusable identifiers continuous: `knowledgeBaseId`, `taskId`, `fileId`, `webhookId`, `deliveryId`, `cursor`, and `path` can be passed to the documented follow-up endpoints.

Developer OpenAPI errors use a stable JSON envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource was not found.",
    "httpStatus": 404
  },
  "requestId": "req-example"
}
```

Webhook subscriptions return the signing secret only on creation. Later list and delivery-log responses never expose signing secrets.

## Security Baseline

The Admin API is the authorization boundary. Every protected Admin API request validates the signed Redis-backed session server-side. Cookie-authenticated state-changing Admin API requests also require a trusted `Origin` or `Referer`.

Production mode rejects placeholder secrets, weak Admin session secrets, insecure public origins, unsafe session-cookie settings, wildcard private CORS, and missing allowed hosts before serving traffic. Login failures, throttling, invalid sessions, origin rejection, logout, selected upload events, and Developer OpenAPI rate-limit events write redacted audit evidence without passwords, cookies, API keys, S3 object keys, local paths, or raw Markdown bodies.

When deploying behind a domain reverse proxy, set public origins, `ALLOWED_HOSTS`, and `TRUSTED_PROXY_MODE` explicitly. Use HTTPS public origins in production. Keep PostgreSQL, Redis, and S3-compatible storage on private infrastructure.

## Quality Checks

Pull requests and `main` branch pushes run GitHub Actions CI. CI installs with pnpm and the committed lockfile, then runs lint, typecheck, tests, build, local path leak validation, and Compose config validation for the production, Docker development, and local infrastructure templates.

Contributor checks:

```bash
pnpm verify
pnpm build
pnpm validate:no-local-paths
pnpm compose:example:config
pnpm compose:dev:example:config
pnpm compose:local:example:config
```

Docker image publishing runs for semantic version tags such as `v1.2.3` and manual dispatch. The normal release path is to push a version tag; that workflow builds the Dockerfile `api` target into `ghcr.io/farozerolabs/focowiki-api` and the Dockerfile `admin` target into `ghcr.io/farozerolabs/focowiki-admin`. Published release images include version tags, `latest`, immutable `sha-*` tags, OCI metadata labels, and registry-linked build provenance attestations.

## Dependency Policy

Use pnpm for dependency changes. When adding packages, request current latest versions, for example:

```bash
pnpm add hono@latest
pnpm add -D vitest@latest
pnpm dlx shadcn@latest
```

Resolved versions are recorded in `pnpm-lock.yaml`. Keep imports and generated code compatible with the locked versions.

## Product Boundaries

- Uploaded source files must be `.md`.
- Metadata comes from Markdown frontmatter, deterministic Markdown signals, filename fallback, and optional model suggestions for missing generic fields.
- PostgreSQL and Redis are required for production Admin state, sessions, coordination, and paginated Admin reads.
- Search is served through generated `_index/search.json`.
- Developer OpenAPI serves knowledge-base CRUD, uploads, task state, generated files, deletion, and webhooks.
- Admin review is read-only. Generated files are viewed from the UI and regenerated from uploads.

## License

Focowiki is distributed under a modified Apache License 2.0. See [LICENSE](./LICENSE).

## References

- [Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [GitHub README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [Open Source Guides: Starting an Open Source Project](https://opensource.guide/starting-a-project/#writing-a-readme)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
