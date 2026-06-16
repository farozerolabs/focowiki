## 1. Tests First

- [x] 1.1 Red: add sample selector tests for a large-scale profile requiring at least 50 Markdown files and failing clearly when fewer are available.
- [x] 1.2 Red: add sample selector tests proving large-scale selection is deterministic, bounded, non-Markdown excluding, and does not read every full file body before selection.
- [x] 1.3 Red: add report redaction tests proving local absolute paths, private directory names, raw legal body snippets, credentials, raw OpenAPI keys, S3 secrets, raw object keys, provider payloads, and storage identifiers are removed.
- [x] 1.4 Red: add Admin API validation tests for 50+ file batch upload, one upload task row, task source pagination, file tree pagination, bundle file pagination, file detail, deletion, republish, and knowledge base deletion.
- [x] 1.5 Red: add public OpenAPI validation tests for `index.md`, `log.md`, `schema.md`, representative `pages/*.md`, `_index/*.json`, API key behavior, unsupported methods, traversal, raw source hiding, deletion state, and stable errors.
- [x] 1.6 Red: add white-box validation tests for PostgreSQL row shape, Redis coordination/cache boundaries, S3-backed bodies, OKF generated files, JSON index consistency, audit events, and absence of raw body persistence.
- [x] 1.7 Red: add security validation tests for admin auth/session, CSRF or origin checks, protected route redirects, upload rejection, path safety, CORS/security headers, and redacted audit evidence.
- [x] 1.8 Red: add performance and boundedness tests for configured batch size, task duration evidence, endpoint timing evidence, pagination page counts, memory evidence where practical, and no unbounded full-corpus/full-tree reads.

## 2. Validation Script Architecture

- [x] 2.1 Refactor validation code into focused modules for sample selection, Admin API checks, public OpenAPI checks, browser checks, white-box persistence checks, security checks, performance checks, reporting, and redaction.
- [x] 2.2 Add large-scale runtime configuration such as minimum batch file count, optional larger batch count, task timeout, performance budgets, and report output paths without hardcoding local dataset paths.
- [x] 2.3 Keep the existing single-file and 24-file validation profiles intact while adding a separate large-scale profile.
- [x] 2.4 Ensure validation artifacts and reports record only safe basenames, counts, redacted labels, product-level URLs or ports, metrics, and failure summaries.
- [x] 2.5 Ensure all large-scale validation reads use bounded pagination, direct logical paths, direct IDs, streaming reads, or aggregate queries rather than full in-memory catalogs.

## 3. Large-Scale Upload Flow

- [x] 3.1 Implement large-scale sample selection from local-only runtime configuration with a minimum of 50 `.md` files.
- [x] 3.2 Validate sample coverage for metadata shape, status/category variety, unknown-date files, long filenames, non-ASCII filenames, and duplicate-title/version patterns.
- [x] 3.3 Submit one authenticated Admin API upload action containing at least 50 selected Markdown files.
- [x] 3.4 Poll one persisted upload task until it ends, verify `sourceCount` matches the accepted file count, and verify internal phases remain task details.
- [x] 3.5 Verify active release creation, generated root files, generated page count, `_index` files, file tree pagination, bundle file pagination, and representative file previews.
- [x] 3.6 Verify source-backed page deletion creates one deletion task, republishes active files, removes stale page references, and keeps remaining source-backed pages available.
- [x] 3.7 Verify knowledge base deletion hides Admin API detail/list state and public OpenAPI reads for the validation-owned knowledge base.

## 4. Black-Box Coverage

- [x] 4.1 Exercise Admin API as an external HTTP client for login, create/list/detail/delete knowledge base, upload, tasks, task detail, file tree, file detail, releases, bundle files, public URLs, delete, and expected errors.
- [x] 4.2 Exercise Admin UI in a browser for login, language switching, knowledge base card creation/opening, 50+ file upload, dialog submitted state or closure, live task refresh, expanded task rows, file tree refresh, preview, copy action, deletion, and knowledge base deletion.
- [x] 4.3 Exercise public OpenAPI as an external client for scoped Markdown/JSON reads, task status, auth, unsupported routes, unsupported methods, traversal, raw source hiding, deletion state, and redacted error bodies.
- [x] 4.4 Capture browser screenshots or concise screenshot notes only for failures or key proof points, without storing local paths or private content.

## 5. White-Box Coverage

- [x] 5.1 Inspect PostgreSQL through bounded queries for knowledge base, source file, upload task, task event, release, bundle file, bundle tree, public key, and audit records.
- [x] 5.2 Verify PostgreSQL preserves original filenames and parsed metadata while avoiding raw Markdown and generated body columns.
- [x] 5.3 Inspect Redis for bounded coordination, cursor/cache, lock, and rate-limit state without raw body snippets, secrets, raw OpenAPI keys, or raw object keys.
- [x] 5.4 Inspect S3-compatible storage for internal source objects and generated bundle objects without exposing raw storage paths through product responses or reports.
- [x] 5.5 Inspect generated OKF artifacts for `index.md`, `log.md`, `schema.md`, representative `pages/*.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json` consistency.
- [x] 5.6 Inspect security audit evidence for expected event types and redaction.

## 6. Security Coverage

- [x] 6.1 Validate unauthenticated Admin API rejection, valid login, invalid login shape, login throttling when configured, signed cookie rejection, logout invalidation, and protected Admin UI redirects.
- [x] 6.2 Validate CSRF or origin rejection for state-changing Admin API requests and server-side scoping for tampered knowledge base IDs, task IDs, source IDs, file paths, and cursors.
- [x] 6.3 Validate upload rejection for non-Markdown files, duplicate filenames, unsafe filenames, oversized files, too many files, malformed requests, and special Markdown/HTML content where applicable.
- [x] 6.4 Validate public OpenAPI key behavior, Admin route rejection on the public listener, unsupported method rejection, traversal rejection, raw source hiding, CORS/security headers, and rate limiting when configured.
- [x] 6.5 Validate all errors, logs, audit records, and reports redact credentials, cookies, raw OpenAPI keys, model keys, S3 secrets, object keys, provider payloads, local paths, and raw Markdown body snippets.

## 7. Performance And Boundedness

- [x] 7.1 Record task duration, publish duration, generated file count, selected file count, accepted file count, representative endpoint response times, pagination page counts, Redis key scan summary, and process memory evidence where practical.
- [x] 7.2 Add configurable performance budgets for task duration, endpoint latency, memory growth, and pagination behavior.
- [x] 7.3 Fail validation on clear boundedness violations such as unbounded `Promise.all`, process-local task state as source of truth, full corpus materialization, full tree materialization, or raw body storage in PostgreSQL/Redis.
- [x] 7.4 Verify upload processing, model suggestion requests, OKF generation, S3 reads/writes, and database batches honor configured concurrency or batch limits.

## 8. Bug Fix Loop

- [x] 8.1 When a product bug is found, record the failing command, endpoint, browser step, assertion, metric, or screenshot note before fixing.
- [x] 8.2 Add or update focused regression coverage for each reproducible product bug when practical.
- [x] 8.3 Fix discovered bugs in the owning module with minimal modular changes and no unrelated refactors.
- [x] 8.4 Rerun the targeted regression check and affected validation slice after each fix.
- [x] 8.5 Rerun the final large-scale profile after blocking bug fixes, or document an explicit blocker with reproduction steps and residual risk.

## 9. Documentation And Reports

- [x] 9.1 Update validation documentation with the large-scale profile, required services, runtime env variables, safe local dataset configuration, and example commands without committing local paths.
- [x] 9.2 Generate a final redacted large-scale validation report under the change directory with sample count, selected basenames, commands, service ports, black-box results, white-box results, security results, performance metrics, bugs found, fixes applied, tests run, and remaining risks.
- [x] 9.3 Ensure the final report and repository-visible files pass local path and secret leak checks.

## 10. Final Verification

- [x] 10.1 Run unit and integration tests for affected packages and apps with pnpm.
- [x] 10.2 Run TypeScript type checks and workspace build checks with pnpm.
- [x] 10.3 Run validation script tests and repository no-local-path leak checks.
- [x] 10.4 Run the large-scale real legal validation profile with at least 50 files from local-only configuration.
- [x] 10.5 Run Admin UI browser validation for the large-scale profile.
- [x] 10.6 Run `openspec validate large-scale-real-legal-validation --strict` and fix any issues before marking implementation complete.
