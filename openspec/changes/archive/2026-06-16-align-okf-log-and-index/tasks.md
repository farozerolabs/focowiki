## 1. Tests First

- [x] 1.1 Red: add OKF generator tests proving every generated bundle contains `index.md`, `log.md`, `schema.md`, `pages/*.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`.
- [x] 1.2 Red: add reserved-file tests proving `index.md` and `log.md` have no concept frontmatter while non-reserved Markdown files keep required `type` and product-required `title`.
- [x] 1.3 Red: add `index.md` formatting tests for heading sections, deterministic grouping by resolved metadata such as `type`, page links, titles, and descriptions when available.
- [x] 1.4 Red: add `log.md` formatting tests for H1 heading, newest-first ISO `YYYY-MM-DD` sections, flat update entries, no frontmatter, and no leaked storage/provider/internal identifiers.
- [x] 1.5 Red: add `log.md` rolling-window tests proving detailed entries are selected newest-first by update time, stop at configured entry and byte limits, and roll older records into compact monthly summaries.
- [x] 1.6 Red: add low-frequency history tests proving `log.md` still includes the newest persisted detailed entries when no updates happened in the last 30 calendar days.
- [x] 1.7 Red: add runtime configuration tests for `OKF_LOG_MAX_ENTRIES`, `OKF_LOG_MAX_BYTES`, invalid values, and conservative defaults.
- [x] 1.8 Red: add JSON index tests proving `_index/manifest.json` includes `log.md`, `_index/search.json` excludes reserved files, and `_index/links.json` only contains edges whose targets resolve to generated public bundle paths.
- [x] 1.9 Red: add public OpenAPI tests for `/kb/{knowledgeBaseId}/log.md`, path safety allowlists, deletion republish visibility, authentication, raw Markdown responses, and hidden S3 details.

## 2. OKF Bundle Generation

- [x] 2.1 Green: implement typed runtime configuration for `OKF_LOG_MAX_ENTRIES` and `OKF_LOG_MAX_BYTES`.
- [x] 2.2 Green: add small package-level reserved Markdown renderers for the root `index.md` and `log.md` without expanding unrelated publication modules.
- [x] 2.3 Green: update bundle generation so `index.md` is rendered as an OKF-aligned progressive-disclosure index with deterministic section labels, sorted entries, links, titles, and descriptions.
- [x] 2.4 Green: generate `log.md` from sanitized persisted publication facts using bounded database inputs and current release data, without reading unbounded history into process memory.
- [x] 2.5 Green: apply the rolling `log.md` limits so recent public entries are detailed, old data is summarized, and the generated Markdown stays within configured size and entry bounds.
- [x] 2.6 Green: keep `log.md` read-only and reserved in conformance validation so it is not treated as a page concept or searchable content.
- [x] 2.7 Refactor: keep runtime config, source metadata parsing, reserved-file rendering, JSON index generation, and validation in focused modules with small typed contracts.

## 3. Persistence, Tree, And Index Publication

- [x] 3.1 Green: persist `log.md` as a generated bundle file record, S3-compatible release object, and bundle tree entry under the knowledge-base-scoped release layout.
- [x] 3.2 Green: update `_index/manifest.json` generation to list `log.md` with reserved-file metadata and without concept metadata.
- [x] 3.3 Green: ensure `_index/search.json` remains page-concept-only and does not include `index.md` or `log.md`.
- [x] 3.4 Green: ensure `_index/links.json` includes valid links from `index.md` and `log.md` when present, while filtering deleted or missing page targets.
- [x] 3.5 Green: add or update bounded PostgreSQL repository methods for recent public update entries and older monthly summary aggregates; use Redis only for bounded coordination/cache where useful.
- [x] 3.6 Refactor: use existing PostgreSQL repositories, S3 storage helpers, Redis coordination/cache helpers where needed, and bounded batch helpers rather than process-local catalogs.

## 4. API And Admin UI Surface

- [x] 4.1 Green: update Admin API file tree/detail reads so `log.md` appears as a generated read-only root Markdown file and can be previewed like `index.md`.
- [x] 4.2 Green: update public OpenAPI scoped file reads and path safety to allow `/kb/{knowledgeBaseId}/log.md` while continuing to reject `sources/*.md` and traversal attempts.
- [x] 4.3 Green: update public deletion visibility so `index.md`, `log.md`, manifest, search, links, schema, and page reads all resolve only from the current active release.
- [x] 4.4 Green: update public URL builders and Admin API generation responses if they expose generated root files so product URLs stay under `PUBLIC_BASE_URL` and never expose S3 URLs.
- [x] 4.5 Refactor: keep public raw file response helpers, path validation, and admin file tree logic split by responsibility.

## 5. Documentation And Validation Tooling

- [x] 5.1 Update project documentation describing the generated bundle tree, including `index.md`, `log.md`, `schema.md`, `pages/*.md`, and `_index/*.json` as Focowiki retrieval extensions where applicable.
- [x] 5.2 Update `.env.example` and runtime configuration docs for `OKF_LOG_MAX_ENTRIES` and `OKF_LOG_MAX_BYTES`.
- [x] 5.3 Update validation scripts to inspect `index.md`, `log.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json` without committing local dataset paths, raw document bodies, credentials, or storage object keys.
- [x] 5.4 Update fixtures and snapshots to remove stale placeholder or smoke content and represent actual generated bundle data.

## 6. Full Verification

- [x] 6.1 Run package-level OKF generator, conformance, reserved-file, and index tests with pnpm.
- [x] 6.2 Run API/public OpenAPI tests for generated file reads, auth behavior, path safety, deletion republish visibility, and storage-detail redaction.
- [x] 6.3 Run TypeScript type checks and workspace build checks for affected packages/apps with pnpm.
- [x] 6.4 Start local services and upload selected real cleaned legal Markdown files from an external local dataset path supplied at runtime, then verify generated `index.md`, bounded `log.md`, `schema.md`, `_index/*.json`, file tree preview, and public OpenAPI reads.
- [x] 6.5 Perform at least three validation-and-fix passes: compare against Google OKF SPEC, run automated tests, run real upload/public read validation, then fix discovered bugs in the owning module and rerun affected checks.
- [x] 6.6 Run repository leak checks confirming no committed file contains local dataset absolute paths, raw legal document bodies, credentials, private S3 object keys, model provider payloads, or generated internal storage identifiers.
- [x] 6.7 Run `openspec validate align-okf-log-and-index --strict` and fix any OpenSpec issues before marking implementation complete.
