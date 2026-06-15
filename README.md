# Focowiki File Knowledge Base

Focowiki is a minimal OKF-style Markdown knowledge-base generator. Admin users upload cleaned `.md` files, the backend parses optional Markdown frontmatter, generates a public OKF-style Markdown tree, publishes it to S3-compatible storage, and exposes scoped Markdown/JSON files for developers and agents.

## Workspace

This repository uses pnpm and TypeScript.

```bash
pnpm install
docker compose up -d postgres redis
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
cp .env.example .env
docker compose up -d postgres redis
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

Edit `.env` to configure admin auth, public API auth, S3-compatible storage, upload limits, and optional model assistance. The API process loads the root `.env` file automatically. Set `ENV_FILE=/absolute/path/to/.env` to load a different file.

Open `http://127.0.0.1:43100/` and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Admin UI language is switched from the page and is not configured through environment variables.

Real upload parsing publishes source and generated files through S3-compatible APIs. A dummy `S3_ENDPOINT` is enough to verify login and form validation, but upload parsing fails until a compatible object store is available.

For a pre-release destructive local reset, stop the app, remove the Compose volumes, start PostgreSQL and Redis again, then rerun migrations. Pre-release schema changes do not keep compatibility readers or local backfills for stale rows, so re-upload Markdown samples after the reset:

```bash
docker compose down -v
docker compose up -d postgres redis
pnpm --filter @focowiki/api db:migrate
```

## Environment Variables

Required admin configuration:

- `ADMIN_USERNAME`: admin login username.
- `ADMIN_PASSWORD`: admin login password.
- `ADMIN_SESSION_SECRET`: signing secret for HTTP-only admin session cookies.
- `ADMIN_API_PORT`: internal Admin API listen port. Defaults to `43000` when omitted.
- `ADMIN_UI_PORT`: local Vite admin UI listen port. Defaults to `43100` when omitted.
- `ADMIN_API_PROXY_TARGET`: local Admin UI proxy target. Defaults to `http://127.0.0.1:${ADMIN_API_PORT}`.

Required infrastructure configuration:

- `DATABASE_URL`: PostgreSQL connection URL for production admin records.
- `REDIS_URL`: Redis connection URL for sessions, coordination, locks, and pagination cursor/cache state.

Required public OpenAPI configuration:

- `PUBLIC_OPENAPI_PORT`: public OpenAPI file-read listen port. Defaults to `43200` when omitted.
- `PUBLIC_BASE_URL`: base URL for the public OpenAPI file-read endpoints and generated public file URLs.
- `PUBLIC_API_AUTH_REQUIRED`: `true` or `false`; controls whether public OpenAPI reads require a bearer API key.
- `PUBLIC_API_KEY`: required when `PUBLIC_API_AUTH_REQUIRED=true`; clients call private public OpenAPI reads with `Authorization: Bearer $PUBLIC_API_KEY`.

Required storage and upload configuration:

- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PREFIX`: object storage configuration.
- `S3_PREFIX`: internal object-key namespace, such as `dev`; it is never exposed in public URLs.
- `S3_FORCE_PATH_STYLE`: set `true` for many S3-compatible local or self-hosted stores.
- `MAX_UPLOAD_BYTES`: maximum bytes accepted in one upload request.
- `MAX_UPLOAD_FILES`: maximum number of files accepted in one upload request.
- `GENERATION_BATCH_SIZE`: bounded OKF generation batch size.
- `UPLOAD_TASK_CONCURRENCY`: active upload parsing and generation tasks per API process. Default `1`.
- `UPLOAD_FILE_PROCESSING_CONCURRENCY`: per-task Markdown source processing and OKF publication concurrency. Default `1`.

Optional:

- `ADMIN_LIST_PAGE_SIZE`, `ADMIN_LIST_MAX_PAGE_SIZE`, `ADMIN_PAGINATION_CURSOR_TTL_SECONDS`: bounded admin pagination defaults and Redis cursor TTL.
- `CORS_ORIGINS`: comma-separated allowed origins for public file responses.
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
      schema.md
      pages/*.md
      _index/manifest.json
      _index/search.json
      _index/links.json
```

`index.md` is a reserved navigation file and does not include frontmatter. `schema.md` and `pages/*.md` are public concept files with YAML frontmatter, non-empty `type`, and non-empty `title`. Raw uploaded source objects remain internal under the upload path and are not part of the public bundle tree.

The database stores knowledge base records, task lifecycle rows, source file records, release records, generated file records, checksums, metadata summaries, and S3 object keys. Raw uploaded Markdown and generated Markdown/JSON bodies stay in S3-compatible storage.

## Public File API

The public API serves knowledge base scoped raw files without a business JSON envelope:

```text
GET /kb/{knowledgeBaseId}/index.md
GET /kb/{knowledgeBaseId}/schema.md
GET /kb/{knowledgeBaseId}/pages/{file}.md
GET /kb/{knowledgeBaseId}/_index/manifest.json
GET /kb/{knowledgeBaseId}/_index/search.json
GET /kb/{knowledgeBaseId}/_index/links.json
GET /kb/{knowledgeBaseId}/tasks/latest
```

`PUBLIC_BASE_URL` must point to the public OpenAPI service, for example `http://127.0.0.1:43200`. Admin UI and Admin API URLs are separate. Public URLs are built as `PUBLIC_BASE_URL + /kb/{knowledgeBaseId}/...` and do not expose S3 bucket names, `S3_PREFIX`, release IDs, task IDs used in storage keys, or raw object keys.

Private mode requires `Authorization: Bearer $PUBLIC_API_KEY`. Public mode allows anonymous reads while still enforcing knowledge base scoping and path safety. Successful file reads return raw Markdown or JSON. Failed public reads return small JSON errors with stable codes.

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
