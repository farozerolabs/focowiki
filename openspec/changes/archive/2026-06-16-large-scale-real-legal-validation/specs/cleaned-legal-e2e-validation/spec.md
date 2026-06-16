## ADDED Requirements

### Requirement: Large-scale cleaned legal full-flow validation
The cleaned legal validation flow SHALL provide a large-scale profile that uploads at least 50 already-cleaned legal Markdown files from local-only configuration and validates the complete product lifecycle.

#### Scenario: Large-scale dataset is configured
- **WHEN** the large-scale validation profile starts
- **THEN** it MUST read the cleaned legal Markdown directory from local-only runtime configuration
- **AND** it MUST require at least 50 valid `.md` files for the large-scale batch sample
- **AND** it MUST fail with a clear prerequisite error when fewer than 50 valid Markdown files are available
- **AND** it MUST NOT commit, print, or persist the local absolute dataset root, local username, private directory name, or raw Markdown bodies in repository artifacts

#### Scenario: Large-scale sample is selected
- **WHEN** the configured dataset contains enough cleaned legal Markdown files
- **THEN** the validation flow MUST select a deterministic bounded sample with at least 50 files for one batch upload action
- **AND** the sample MUST include varied legal metadata shapes, statuses, categories, unknown-date files, long filenames, non-ASCII filenames, and duplicate-title/version patterns when available
- **AND** selection MUST NOT read every full Markdown body into process memory before choosing the sample

#### Scenario: Large-scale lifecycle completes
- **WHEN** the large-scale validation runs against valid local PostgreSQL, Redis, S3-compatible storage, Admin API, Admin UI, and public OpenAPI services
- **THEN** it MUST authenticate as an admin, create a validation knowledge base, upload at least 50 selected `.md` files in one batch action, wait for exactly one upload task to end, verify an active release, inspect generated Admin file tree and previews, verify public OpenAPI reads, delete at least one source-backed generated page, verify republish, delete the knowledge base, and verify deleted public routes are unavailable
- **AND** it MUST clean up validation-owned knowledge bases when the run can safely do so

### Requirement: Large-scale black-box validation coverage
The large-scale cleaned legal validation flow SHALL verify externally observable behavior across every production-facing surface without relying on private implementation state.

#### Scenario: Admin API black-box coverage runs
- **WHEN** the large-scale validation calls Admin API endpoints
- **THEN** it MUST verify login, knowledge base create/list/detail/delete, upload submit, task list, task detail, task source pagination, file tree pagination, file detail, release list, bundle file list, public URL list, source-backed page deletion, republish completion, expected unauthorized responses, expected validation errors, and expected safe not-found behavior
- **AND** it MUST verify one batch upload action appears as one task row with `sourceCount` equal to the accepted file count

#### Scenario: Admin UI black-box coverage runs
- **WHEN** browser validation runs for the large-scale profile
- **THEN** it MUST verify login, language switching, knowledge base card creation and opening, multi-file Markdown upload, upload dialog submitted state or closure, live task list refresh, expanded task file rows, paginated task/file tree behavior, generated file previews, public URL copy behavior, source-backed page deletion, file tree refresh after deletion, and knowledge base deletion
- **AND** it MUST verify the UI remains i18n-backed and does not expose raw source upload objects or public `sources/*.md` files

#### Scenario: Public OpenAPI black-box coverage runs
- **WHEN** public validation runs after the large-scale release is active
- **THEN** it MUST verify scoped reads for `/kb/{knowledgeBaseId}/index.md`, `/kb/{knowledgeBaseId}/log.md`, `/kb/{knowledgeBaseId}/schema.md`, representative `/kb/{knowledgeBaseId}/pages/*.md`, and `/_index/manifest.json`, `/_index/search.json`, and `/_index/links.json`
- **AND** it MUST verify API key behavior, unsupported methods, Admin route rejection on the public listener, traversal rejection, encoded traversal rejection, raw source path rejection, missing file errors, deleted page unavailability after republish, and knowledge base unavailability after knowledge base deletion

### Requirement: Large-scale white-box validation coverage
The large-scale cleaned legal validation flow SHALL inspect internal persistence, storage, indexing, and coordination contracts through bounded checks.

#### Scenario: PostgreSQL state is inspected
- **WHEN** the large-scale upload and publish flow completes
- **THEN** white-box checks MUST verify bounded PostgreSQL records for knowledge bases, source files, upload tasks, task phase details, releases, bundle files, bundle tree entries, public OpenAPI keys, and security audit events
- **AND** source file records MUST preserve original filenames and parsed frontmatter metadata
- **AND** database tables MUST NOT contain raw Markdown body columns or generated file body columns

#### Scenario: Redis state is inspected
- **WHEN** large-scale validation checks task, cursor, cache, lock, and rate-limit behavior
- **THEN** Redis checks MUST verify Redis is used only for bounded coordination/cache/cursor/rate-limit state
- **AND** durable records and file bodies MUST remain in PostgreSQL and S3-compatible storage
- **AND** Redis values MUST NOT contain selected raw Markdown body snippets, credentials, raw OpenAPI keys, or raw S3 object keys

#### Scenario: S3-compatible storage is inspected
- **WHEN** uploaded sources and generated bundle files are stored
- **THEN** storage checks MUST verify accepted source objects exist under internal knowledge-base-scoped upload paths
- **AND** generated public bundle objects MUST exist under active release bundle paths
- **AND** public Admin API responses, public OpenAPI responses, reports, logs, and UI copy outputs MUST NOT expose raw S3 bucket names, object keys, prefixes, credentials, release IDs used in storage keys, or task IDs used in storage keys

#### Scenario: OKF bundle is inspected
- **WHEN** the large-scale active release is published
- **THEN** white-box checks MUST verify `index.md`, `log.md`, `schema.md`, representative `pages/*.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`
- **AND** checks MUST verify metadata pass-through, generic fallback metadata, citations, related links, generated graph edges, manifest coverage, search index coverage, reserved-file exclusion from search, deleted page removal after republish, and no public `sources/*.md` exposure

### Requirement: Large-scale security validation
The large-scale cleaned legal validation flow SHALL include security checks across Admin UI, Admin API, upload ingestion, public OpenAPI, generated previews, and reports.

#### Scenario: Admin security checks run
- **WHEN** large-scale security validation exercises Admin UI and Admin API
- **THEN** it MUST verify unauthenticated rejection, valid login, invalid login, generic login failure shape, login throttling when configured, signed cookie rejection, logout invalidation, protected route redirect, CSRF or origin rejection for state-changing requests, server-side scope enforcement for tampered IDs and cursors, and safe error redaction

#### Scenario: Upload security checks run
- **WHEN** large-scale security validation exercises upload inputs
- **THEN** it MUST verify unsupported extensions, unsafe filenames, duplicate filenames, oversized file attempts, too-many-files attempts, special Markdown content, raw HTML/script-like content, and malformed request bodies are rejected or safely rendered according to product rules
- **AND** rejected uploads MUST NOT create active source records, active release files, public pages, or leaked storage objects

#### Scenario: Public OpenAPI security checks run
- **WHEN** large-scale security validation calls public OpenAPI
- **THEN** it MUST verify active API key success, missing or invalid key rejection, unsupported method rejection, traversal rejection, raw source hiding, stable JSON errors, CORS behavior, security headers, public rate limiting when configured, and absence of S3 details or secret-like values

#### Scenario: Security report is redacted
- **WHEN** large-scale security validation writes reports or diagnostics
- **THEN** the report MUST include security checks performed, failures, fixed bugs, residual risks, and audit event evidence
- **AND** it MUST NOT include passwords, session cookies, raw OpenAPI keys, model keys, S3 credentials, raw Markdown bodies, local absolute paths, raw storage object keys, provider payloads, or authorization headers

### Requirement: Large-scale performance and boundedness validation
The large-scale cleaned legal validation flow SHALL verify the product remains bounded and responsive enough for a 50+ file real Markdown batch.

#### Scenario: Performance evidence is recorded
- **WHEN** the large-scale validation runs
- **THEN** it MUST record selected file count, accepted file count, upload task duration, publish duration, generated file count, representative endpoint response times, pagination page counts, Redis key scan summary, and process memory evidence where practical
- **AND** the final report MUST distinguish measured performance data from pass/fail assertions

#### Scenario: Bounded API reads are checked
- **WHEN** validation reads tasks, task source files, file tree, releases, bundle files, file details, public files, and public task status
- **THEN** each check MUST use paginated or directly scoped API/database reads
- **AND** validation MUST fail if a product endpoint requires full source, full tree, full index, or full knowledge base materialization in process memory for a page request

#### Scenario: Configurable performance budgets are applied
- **WHEN** performance thresholds are configured for the large-scale profile
- **THEN** validation MUST fail when task duration, endpoint latency, memory growth, or pagination behavior exceeds the configured blocking budgets
- **AND** validation MUST record non-blocking warnings separately from blocking failures

#### Scenario: Concurrency limits are honored
- **WHEN** the 50+ file batch is processed
- **THEN** upload file processing, model suggestion requests, OKF generation, S3 reads/writes, and database batches MUST use explicit configured concurrency or batch limits
- **AND** validation MUST treat unbounded `Promise.all` over all selected sources, process-local queues as source of truth, or full in-memory corpus catalogs as product bugs

### Requirement: Large-scale bug fix loop and report
The large-scale cleaned legal validation flow SHALL turn discovered bugs into minimal fixes and produce final evidence.

#### Scenario: Product bug is found
- **WHEN** a black-box, white-box, security, performance, API, OpenAPI, UI, storage, Redis, PostgreSQL, or OKF check fails because of product behavior
- **THEN** the failing command, endpoint, browser step, assertion, metric, or screenshot note MUST be recorded before fixing
- **AND** a focused regression test or validation check MUST be added or updated when practical

#### Scenario: Product bug is fixed
- **WHEN** implementation fixes a discovered bug
- **THEN** the fix MUST be scoped to the owning module and keep code modular
- **AND** the targeted regression test or validation check MUST pass
- **AND** the affected slice and final large-scale profile MUST be rerun before completion unless the final report records an explicit blocker

#### Scenario: Final large-scale report is produced
- **WHEN** large-scale validation completes
- **THEN** it MUST produce a redacted report with selected basenames, sample count, service URLs or ports, commands run, black-box results, white-box results, security results, performance metrics, bugs found, fixes applied, tests run, unresolved blockers, and remaining risks
- **AND** the report MUST NOT contain local absolute paths, private directory names, credentials, raw legal document bodies, raw OpenAPI keys, S3 secrets, raw S3 object keys, model provider payloads, or generated internal storage identifiers
