# cleaned-legal-e2e-validation Specification

## Purpose
TBD - created by archiving change validate-cleaned-legal-upload-flow. Update Purpose after archive.
## Requirements
### Requirement: External cleaned legal Markdown sample
The validation workflow SHALL use already-cleaned legal Markdown files from local-only configuration without committing file bodies, local directory roots, developer usernames, or private machine details.

#### Scenario: Sample directory is configured
- **WHEN** the validation workflow starts
- **THEN** it MUST read the cleaned legal Markdown directory from local-only configuration
- **AND** it MUST fail with a clear prerequisite error when the directory is missing or unreadable
- **AND** it MUST NOT fall back to committed legal data or synthetic replacement files

#### Scenario: Deterministic sample is selected
- **WHEN** the configured directory contains enough cleaned `.md` files
- **THEN** the workflow MUST select a deterministic bounded sample of already-cleaned legal Markdown files
- **AND** the sample MUST include varied metadata shapes, statuses, long names, duplicate-title/version patterns, and non-ASCII file names when available
- **AND** committed artifacts MUST record only selected basenames, counts, hashes, or redacted labels

#### Scenario: Source file is not Markdown
- **WHEN** the sample selector encounters non-`.md` files
- **THEN** those files MUST be ignored or reported as excluded inputs
- **AND** the upload validation MUST submit only `.md` files

### Requirement: Real service stack validation
The validation workflow SHALL run against the real local service stack rather than in-process mocks.

#### Scenario: Required services are unavailable
- **WHEN** PostgreSQL, Redis, S3-compatible storage, Admin API, Admin UI, or public OpenAPI is unavailable
- **THEN** the workflow MUST fail with the missing prerequisite
- **AND** it MUST NOT mark the validation as successful

#### Scenario: Services use high local ports
- **WHEN** the validation workflow starts local services
- **THEN** Admin API, Admin UI, and public OpenAPI MUST run on configured high local ports
- **AND** the final report MUST record the product-level service URLs used without exposing secrets

#### Scenario: Persistent boundaries are used
- **WHEN** the workflow uploads selected files and waits for generation
- **THEN** PostgreSQL MUST contain durable knowledge base, upload task, source file, release, bundle file, and bundle tree records
- **AND** Redis MUST be used only for coordination, cursors, cache, or locks
- **AND** raw Markdown and generated file bodies MUST be stored in S3-compatible storage rather than PostgreSQL, Redis, or process-global memory

### Requirement: White-box validation coverage
The validation workflow SHALL include white-box tests that inspect internal implementation contracts for the cleaned legal Markdown upload flow.

#### Scenario: Internal metadata and OKF generation are checked
- **WHEN** the legal Markdown sample is processed
- **THEN** white-box tests MUST verify frontmatter parsing, missing metadata fallback, unknown metadata preservation, model schema validation, generated frontmatter, citations, related links, manifest index, search index, and link index behavior
- **AND** these tests MUST use module-level or integration-level assertions rather than only checking HTTP responses

#### Scenario: Internal persistence boundaries are checked
- **WHEN** the legal Markdown sample upload completes
- **THEN** white-box tests MUST verify PostgreSQL row shape for source files, upload tasks, releases, bundle files, and bundle tree entries
- **AND** they MUST verify Redis coordination or cursor/cache data is not the durable source of truth
- **AND** they MUST verify S3-compatible object keys and stored generated file bodies match the public bundle tree without exposing raw source paths publicly

#### Scenario: Internal bug regression is required
- **WHEN** a bug is found in parser, generator, repository, Redis coordination, storage key, or publication code
- **THEN** a focused white-box regression test MUST be added or updated when practical
- **AND** the targeted internal test MUST fail before the fix and pass after the fix whenever the failure can be reproduced deterministically

### Requirement: Black-box validation coverage
The validation workflow SHALL include black-box tests that verify externally visible behavior without depending on internal implementation details.

#### Scenario: Admin API is tested as a client
- **WHEN** black-box validation calls Admin API endpoints
- **THEN** it MUST use only HTTP requests, cookies, documented request bodies, response status codes, response bodies, and configured public service URLs
- **AND** it MUST NOT depend on internal repository methods, storage keys, or process memory

#### Scenario: Admin UI is tested as a user
- **WHEN** black-box validation drives the Admin UI
- **THEN** it MUST use browser-visible controls and rendered content to verify login, language switching, knowledge base navigation, file-only upload, task refresh, file tree refresh, previews, and copy actions
- **AND** it MUST NOT pass by inspecting React component state or private implementation variables

#### Scenario: Public OpenAPI is tested as an external client
- **WHEN** black-box validation calls public OpenAPI
- **THEN** it MUST verify only public HTTP status codes, headers, raw Markdown or JSON bodies, public auth behavior, and stable error bodies
- **AND** it MUST verify raw source paths are unavailable without inspecting internal S3 object keys

#### Scenario: External bug regression is required
- **WHEN** a bug is found in Admin API, Admin UI, or public OpenAPI behavior
- **THEN** a focused black-box regression check MUST be added or updated when practical
- **AND** the affected user-visible or API-visible flow MUST be rerun after the fix

### Requirement: Admin API end-to-end validation
The validation workflow SHALL verify Admin API behavior for the legal Markdown upload flow.

#### Scenario: Admin API requires authentication
- **WHEN** protected Admin API endpoints are called without a valid admin session
- **THEN** knowledge base, upload, task, file tree, and file preview endpoints MUST reject the request

#### Scenario: Knowledge base upload succeeds
- **WHEN** the workflow logs in with configured admin credentials
- **AND** creates a test knowledge base
- **AND** uploads the selected legal Markdown files in one upload action
- **THEN** the Admin API MUST return one upload task identifier
- **AND** the task MUST eventually end
- **AND** the knowledge base MUST have an active release after generation succeeds

#### Scenario: Generated records are bounded
- **WHEN** the workflow reads tasks, task phase details, file tree, file details, releases, or bundle files
- **THEN** each Admin API response MUST be paginated or directly scoped
- **AND** the API MUST NOT require loading every source file, generated file, or tree entry into process memory for a page request

### Requirement: Admin UI browser validation
The validation workflow SHALL verify the production Admin UI behavior in a browser.

#### Scenario: Login and language switch work
- **WHEN** the workflow opens the Admin UI login page
- **AND** switches language through the page control
- **AND** logs in with configured credentials
- **THEN** user-visible labels MUST come from i18n resources
- **AND** the admin home page MUST be shown without hardcoded user-facing strings in UI components

#### Scenario: File-only upload is submitted
- **WHEN** the workflow opens a test knowledge base
- **AND** opens the upload dialog
- **AND** selects the sampled legal `.md` files
- **AND** submits the upload
- **THEN** the dialog MUST close or show a clear submitted state
- **AND** the task list MUST refresh without a manual full-page reload
- **AND** the upload dialog MUST NOT ask the user to enter metadata fields

#### Scenario: Task and file tree refresh after completion
- **WHEN** the upload task completes
- **THEN** the task menu MUST show one ended task row for the upload action
- **AND** internal phase details MUST remain details under that task rather than separate task rows
- **AND** the file tree MUST show generated public bundle files from the active release

#### Scenario: Preview uses generated public files
- **WHEN** the workflow selects generated Markdown and JSON files in the Admin UI
- **THEN** the preview pane MUST show the selected generated file content safely
- **AND** the file tree MUST NOT show raw internal source upload objects or public `sources/*.md` files

### Requirement: Public OpenAPI end-to-end validation
The validation workflow SHALL verify public knowledge-base-scoped OpenAPI reads for the uploaded legal Markdown sample.

#### Scenario: Public generated files are readable
- **WHEN** generation completes for the test knowledge base
- **THEN** public OpenAPI MUST serve `/kb/{knowledgeBaseId}/index.md`, `/kb/{knowledgeBaseId}/schema.md`, `/kb/{knowledgeBaseId}/pages/*.md`, and `/kb/{knowledgeBaseId}/_index/*.json` for existing generated files
- **AND** successful file reads MUST return raw Markdown or JSON bodies without a business envelope

#### Scenario: Raw source paths are unavailable
- **WHEN** public OpenAPI receives a request for `/kb/{knowledgeBaseId}/sources/*.md`
- **THEN** it MUST return a stable not-found or unsupported-path error
- **AND** it MUST NOT expose S3 bucket names, prefixes, object keys, release IDs, storage task IDs, provider headers, or secrets

#### Scenario: Public auth mode is enforced
- **WHEN** public API auth is enabled
- **THEN** public file and task status requests without the configured bearer key MUST return `401`
- **AND** requests with the correct bearer key MUST return allowed existing resources

#### Scenario: Public path safety is enforced
- **WHEN** public OpenAPI receives traversal, encoded traversal, backslash, unsupported path, or missing file requests
- **THEN** it MUST return stable JSON errors
- **AND** it MUST NOT read S3 objects outside the active knowledge base bundle

### Requirement: Bug fix and validation report
The validation workflow SHALL convert discovered bugs into minimal fixes and final evidence.

#### Scenario: Validation finds a bug
- **WHEN** Admin API, backend persistence, Redis coordination, S3 storage, Admin UI, OKF generation, or public OpenAPI validation fails due to a product bug
- **THEN** the failing command, endpoint, browser step, assertion, or screenshot note MUST be recorded before fixing
- **AND** a focused failing test or validation check MUST be added when practical

#### Scenario: Bug is fixed
- **WHEN** a bug fix is implemented
- **THEN** the fix MUST be scoped to the owning module
- **AND** the targeted regression test or validation check MUST pass
- **AND** the affected portion of the legal Markdown upload flow MUST be rerun

#### Scenario: Final report is produced
- **WHEN** validation completes
- **THEN** the final report MUST list selected file basenames, sample count, commands run, service URLs or ports used, white-box checks, black-box checks, API checks, browser checks, OpenAPI checks, bugs found, fixes applied, tests run, and remaining risks
- **AND** the report MUST NOT contain local absolute paths, private directory names, credentials, API keys, S3 secrets, or legal Markdown bodies

### Requirement: Full cleaned legal validation lifecycle
The cleaned legal validation flow SHALL exercise the complete product lifecycle with already-cleaned Markdown files from a local-only dataset configuration.

#### Scenario: Local dataset is selected
- **WHEN** the validation flow starts
- **THEN** it MUST read the cleaned legal Markdown dataset location from local-only configuration such as an environment variable or CLI argument
- **AND** it MUST NOT require, commit, print, or persist the developer's absolute local path in repository artifacts or product code

#### Scenario: Sample is bounded and deterministic
- **WHEN** the validation flow selects files from the cleaned legal dataset
- **THEN** it MUST choose a deterministic bounded Markdown sample, defaulting to 24 files unless explicitly configured otherwise
- **AND** it MUST ignore non-Markdown files
- **AND** it MUST NOT read the full dataset bodies into process memory before selecting the sample

#### Scenario: Full lifecycle succeeds
- **WHEN** validation runs with valid local infrastructure and a valid cleaned Markdown sample
- **THEN** it MUST authenticate as an admin, create a knowledge base, upload the selected files, wait for one upload task to end, verify an active release, inspect the admin file tree and preview, verify public OpenAPI reads, delete a source-backed generated page, verify republish, delete the knowledge base, and verify deleted public routes are unavailable

### Requirement: White-box full-flow validation
The cleaned legal validation flow SHALL verify persisted internal state across the full lifecycle.

#### Scenario: Upload persistence is inspected
- **WHEN** the sampled upload has completed
- **THEN** white-box checks MUST verify PostgreSQL knowledge base, source file, upload task, task phase, release, bundle file, tree entry, source mapping, and generated metadata records through bounded queries
- **AND** source file records MUST preserve original filenames and parsed frontmatter metadata without using generated public paths as source identity

#### Scenario: Storage layout is inspected
- **WHEN** uploaded source files and generated bundle files are stored
- **THEN** white-box checks MUST verify S3-compatible objects exist under the configured internal knowledge-base-scoped storage layout
- **AND** public URLs, admin API responses, reports, and logs MUST NOT expose raw S3 bucket names, object keys, local file paths, task-scoped storage keys, or credentials

#### Scenario: OKF files are inspected
- **WHEN** an active release is published
- **THEN** white-box checks MUST verify generated Markdown and JSON files satisfy the OKF-facing structure used by the product, including `index.md`, source-backed `pages/*.md`, `schema.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`
- **AND** checks MUST verify metadata, headings, graph link data, search entries, and manifest entries stay consistent with the selected source files

#### Scenario: Redis-backed coordination is inspected
- **WHEN** validation reads task, pagination, lock, or cache behavior that uses Redis
- **THEN** white-box checks MUST verify Redis is used only for coordination or cache state while PostgreSQL remains the source of truth for durable records
- **AND** the product MUST NOT fall back to process memory for cross-request task state, pagination state, file tree state, or generated index state

### Requirement: Black-box full-flow validation
The cleaned legal validation flow SHALL verify externally observable behavior across Admin UI, Admin API, and public OpenAPI.

#### Scenario: Admin UI flow is exercised
- **WHEN** black-box browser validation runs
- **THEN** it MUST verify login, language switching, knowledge base card creation and opening, Markdown-only upload, upload dialog closure or feedback, live task list refresh, paginated task display, paginated file tree display, file preview rendering, source-backed page deletion, file tree refresh after deletion, and knowledge base deletion

#### Scenario: Admin API flow is exercised
- **WHEN** black-box API validation runs
- **THEN** it MUST verify authenticated create, upload, task list, task detail, file tree, file detail, source-backed page delete, republish completion, knowledge base delete, pagination cursors, and expected error responses
- **AND** task list responses MUST represent one upload action as one task row with one lifecycle status

#### Scenario: Public OpenAPI flow is exercised
- **WHEN** black-box public validation runs
- **THEN** it MUST verify generated public file reads, API key behavior when enabled, path safety, absence of raw source exposure, absence of S3 key exposure, deleted page unavailability after republish, updated index files after deletion, and knowledge base unavailability after knowledge base deletion

### Requirement: Validation bug-fix loop
The cleaned legal validation flow SHALL require discovered product bugs to be fixed or explicitly reported before completion.

#### Scenario: Validation discovers a product bug
- **WHEN** a white-box or black-box validation check fails because of product behavior
- **THEN** implementation MUST add or update focused regression coverage where practical
- **AND** it MUST fix the owning module with minimal modular changes
- **AND** it MUST rerun the failed validation slice before marking the task complete

#### Scenario: Validation cannot fix a discovered issue
- **WHEN** a discovered issue cannot be fixed within the implementation pass
- **THEN** the final validation report MUST identify the blocker, affected flow, reproduction steps, attempted checks, and any required manual action

#### Scenario: Validation report is produced
- **WHEN** validation finishes
- **THEN** it MUST produce a redacted report summarizing selected sample count, enabled services, commands or scripts run, white-box results, black-box results, fixed bugs, unresolved blockers, and manual review items
- **AND** the report MUST NOT include local absolute paths, raw source contents, credentials, S3 object keys, or provider secrets

### Requirement: Single and batch legal upload full-flow validation
The cleaned legal validation flow SHALL validate both a single-file upload and a multi-file batch upload with already-cleaned legal Markdown files.

#### Scenario: Single-file upload flow completes
- **WHEN** validation runs against the real local service stack with one selected cleaned legal `.md` file
- **THEN** it MUST authenticate as an admin, create a test knowledge base, upload that one file, wait for exactly one upload task to end, and verify that the task has `sourceCount` equal to one
- **AND** it MUST verify that the active release contains a generated page for the uploaded source and the expected root and `_index` files

#### Scenario: Batch upload flow completes after single upload
- **WHEN** validation uploads a distinct bounded batch of cleaned legal `.md` files to the same test knowledge base after the single-file upload has completed
- **THEN** it MUST create exactly one additional upload task for that batch
- **AND** that task MUST have `sourceCount` equal to the accepted batch size
- **AND** the active release MUST contain the earlier single-upload generated page plus every accepted batch generated page

#### Scenario: Upload tasks remain one row per upload action
- **WHEN** validation lists tasks after both upload flows
- **THEN** the Admin API and Admin UI MUST show one lifecycle row for the single-file upload and one lifecycle row for the batch upload
- **AND** internal phases and individual source files MUST NOT appear as separate task rows

#### Scenario: Batch source files are paginated
- **WHEN** the batch task has more source files than the task detail source-file page size
- **THEN** validation MUST follow the task detail source-file cursor through Admin API or Admin UI behavior
- **AND** it MUST verify that source-file pagination is bounded and scoped to the selected task

### Requirement: White-box validation for single and batch uploads
The cleaned legal validation flow SHALL inspect persisted internal state for both upload modes.

#### Scenario: Single upload persistence is inspected
- **WHEN** the single-file upload completes
- **THEN** white-box checks MUST verify PostgreSQL knowledge base, source file, upload task, phase detail, release, bundle file, tree entry, source mapping, and generated metadata records for that file through bounded queries
- **AND** they MUST verify raw file bodies are stored in S3-compatible storage rather than PostgreSQL, Redis, or process-global memory

#### Scenario: Batch upload persistence is inspected
- **WHEN** the multi-file batch upload completes
- **THEN** white-box checks MUST verify PostgreSQL contains one source file record per accepted batch file and one upload task record for the batch action
- **AND** generated bundle records, tree entries, manifest entries, search entries, headings, and graph links MUST remain consistent with all active non-deleted source files

#### Scenario: Redis and S3 boundaries are inspected
- **WHEN** validation inspects Redis and S3-compatible storage after both uploads
- **THEN** Redis MUST only contain coordination, cursor, lock, cache, or refresh state
- **AND** S3-compatible storage MUST contain internal raw uploads and generated public bundle bodies under normalized knowledge-base-scoped storage keys
- **AND** reports MUST NOT expose raw storage keys or raw source bodies

### Requirement: Black-box validation for single and batch uploads
The cleaned legal validation flow SHALL verify externally visible behavior for both upload modes across Admin UI, Admin API, and public OpenAPI.

#### Scenario: Admin API black-box flow covers both uploads
- **WHEN** black-box Admin API validation runs
- **THEN** it MUST verify unauthenticated rejection, admin login, knowledge base creation, single upload, single task polling, batch upload, batch task polling, task detail reads, file tree pagination, file preview reads, source-backed page deletion, republish completion, knowledge base deletion, pagination cursor behavior, and stable error responses

#### Scenario: Admin UI black-box flow covers both uploads
- **WHEN** black-box browser validation runs
- **THEN** it MUST verify login, language switching, knowledge base card creation and opening, single-file upload selection and submission, batch upload multi-select and submission, upload dialog closure or clear feedback, live task list refresh, task source-file pagination, file tree refresh, generated file preview rendering, copy actions, source-backed page deletion, and knowledge base deletion

#### Scenario: Public OpenAPI black-box flow covers both uploads
- **WHEN** public OpenAPI validation runs after both upload tasks have ended
- **THEN** it MUST verify generated public reads for `index.md`, `schema.md`, `pages/*.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`
- **AND** it MUST verify API key behavior when enabled, path traversal rejection, unsupported path rejection, missing file errors, raw source path unavailability, deleted page unavailability after republish, updated indexes after deletion, and knowledge base unavailability after knowledge base deletion

### Requirement: Bug-fix loop for single and batch validation
The cleaned legal validation flow SHALL convert discovered product bugs into minimal fixes and rerun evidence.

#### Scenario: Validation discovers a bug
- **WHEN** a white-box or black-box check fails because of product behavior in the single upload, batch upload, backend persistence, Admin UI, Admin API, or public OpenAPI flow
- **THEN** implementation MUST record the failing command, endpoint, browser step, assertion, or screenshot note before fixing
- **AND** it MUST add or update focused regression coverage where practical
- **AND** it MUST fix the owning module with minimal modular changes

#### Scenario: Bug fix is verified
- **WHEN** a bug fix has been implemented
- **THEN** the targeted regression check MUST pass
- **AND** the affected validation slice MUST be rerun before the task is marked complete

#### Scenario: Final validation report is produced
- **WHEN** single and batch validation completes
- **THEN** the final report MUST include selected sample count, selected basenames or redacted labels, service URLs or ports, commands run, white-box results, black-box results, Admin UI notes, Admin API notes, public OpenAPI notes, bugs found, fixes applied, tests run, and remaining risks
- **AND** it MUST NOT include local absolute paths, private dataset names, raw legal Markdown bodies, credentials, API keys, S3 secrets, raw S3 object keys, or provider secrets

### Requirement: Real legal data release-gate validation
The cleaned legal validation flow SHALL provide a release-gate validation pass using real cleaned legal Markdown data from local-only configuration.

#### Scenario: Real legal dataset is required
- **WHEN** the release-gate validation starts
- **THEN** it MUST require a configured local real legal Markdown dataset
- **AND** it MUST fail with a clear prerequisite error when the dataset is missing, unreadable, empty, or contains no accepted `.md` files
- **AND** it MUST NOT replace the real dataset with committed fixtures, mock files, generated legal text, or synthetic samples

#### Scenario: Dataset details are redacted
- **WHEN** the validation logs selected files or writes reports
- **THEN** it MUST record only safe basenames, counts, hashes, or redacted labels
- **AND** it MUST NOT persist local absolute paths, private directory names, raw legal Markdown bodies, credentials, S3 object keys, provider headers, model prompts, or session secrets

#### Scenario: Sample is representative and bounded
- **WHEN** the configured dataset contains enough files
- **THEN** the selector MUST choose a deterministic bounded sample that includes varied frontmatter shapes, missing optional metadata, unknown metadata, long filenames, non-ASCII filenames, status or version differences, and duplicate-title patterns when available
- **AND** it MUST ignore non-Markdown files
- **AND** it MUST NOT load the full corpus body into process memory before selection

### Requirement: Release-gate black-box validation
The cleaned legal validation flow SHALL verify externally visible behavior across Admin UI, Admin API, and public OpenAPI with the selected real legal sample.

#### Scenario: Admin UI is validated as a user
- **WHEN** browser black-box validation runs
- **THEN** it MUST verify login, unauthenticated redirect, language switching, knowledge base card creation and opening, single-file upload, multi-file upload, upload dialog submission feedback, live task list refresh, paginated task display, paginated file tree display, file preview rendering, copy behavior, source-backed page deletion, file tree refresh after deletion, knowledge base deletion, and session-expiry handling
- **AND** it MUST verify user-visible text comes from i18n resources rather than hardcoded UI component strings

#### Scenario: Admin API is validated as an HTTP client
- **WHEN** Admin API black-box validation runs
- **THEN** it MUST verify unauthenticated rejection, authenticated login, knowledge base creation, single upload, batch upload, task polling, task details, file tree pagination, file detail reads, source-backed page deletion, republish completion, knowledge base deletion, pagination cursors, rate-limit or security error behavior where applicable, and stable JSON error shapes
- **AND** it MUST use only HTTP requests, cookies, documented request bodies, response status codes, response bodies, and configured service URLs

#### Scenario: Public OpenAPI is validated as an external client
- **WHEN** public OpenAPI black-box validation runs
- **THEN** it MUST verify generated reads for `index.md`, `schema.md`, `pages/*.md`, `_index/manifest.json`, `_index/search.json`, `_index/links.json`, and task status endpoints when available
- **AND** it MUST verify public API key behavior when enabled, unsupported method rejection, traversal rejection, raw `sources/` path unavailability, missing file errors, deleted page unavailability after republish, updated index files after deletion, knowledge base unavailability after knowledge base deletion, and absence of S3 or local path exposure

#### Scenario: Upload actions stay task-scoped
- **WHEN** validation lists upload tasks after one single-file upload and one batch upload
- **THEN** Admin UI and Admin API MUST show one task row for the single upload and one task row for the batch upload
- **AND** internal phases and individual source files MUST remain nested task details rather than separate upload-task rows

### Requirement: Release-gate white-box validation
The cleaned legal validation flow SHALL inspect persisted internal state and generated artifacts for the selected real legal sample.

#### Scenario: PostgreSQL durable state is inspected
- **WHEN** single-file and batch uploads complete
- **THEN** white-box checks MUST verify bounded PostgreSQL records for knowledge bases, source files, upload tasks, task phase events, releases, bundle files, bundle tree entries, source mappings, deletion state, security audit evidence where applicable, and generated metadata summaries
- **AND** source records MUST preserve original filenames and parsed frontmatter metadata without using generated public paths as source identity

#### Scenario: Redis coordination state is inspected
- **WHEN** validation checks task, pagination, cursor, lock, cache, refresh, rate-limit, or session behavior
- **THEN** white-box checks MUST verify Redis contains only coordination or cache state
- **AND** PostgreSQL MUST remain the durable source of truth for knowledge bases, upload tasks, source files, releases, tree entries, generated files, and deletion state
- **AND** the product MUST NOT rely on process memory for cross-request task state, pagination state, file tree state, generated index state, security counters, or upload progress

#### Scenario: S3-compatible storage is inspected
- **WHEN** raw uploads and generated bundle files are published
- **THEN** white-box checks MUST verify S3-compatible objects exist under knowledge-base-scoped internal storage layout
- **AND** raw uploads MUST remain internal
- **AND** generated public bundle bodies MUST match database file records and public OpenAPI reads without exposing bucket names, prefixes, object keys, release IDs, task IDs, provider headers, or credentials

#### Scenario: OKF bundle artifacts are inspected
- **WHEN** an active release is published
- **THEN** white-box checks MUST verify `index.md`, `schema.md`, source-backed `pages/*.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`
- **AND** checks MUST verify frontmatter parsing, unknown metadata preservation, generated common metadata, headings, citations or source references when available, graph link data, manifest entries, search entries, link entries, public paths, and source mappings remain consistent with active non-deleted source files

### Requirement: Model-assisted real data validation
The cleaned legal validation flow SHALL validate optional model assistance with real legal Markdown input without making the product legal-specific.

#### Scenario: Model assistance is enabled
- **WHEN** model assistance configuration is complete for validation
- **THEN** validation MUST run the configured model-assisted metadata or graph-generation path against the selected real legal Markdown sample
- **AND** it MUST verify Structured Outputs schema validation, retry-on-invalid-output behavior, model timeout and idle-timeout behavior, configured context-window handling, and configured model concurrency limits
- **AND** it MUST verify the model cannot override authorization, storage paths, database IDs, task IDs, source IDs, security config, or original source identity

#### Scenario: Model assistance is disabled
- **WHEN** model assistance configuration is incomplete or explicitly disabled
- **THEN** validation MUST run the deterministic generation path
- **AND** the final report MUST state that model assistance was disabled without treating that as a product failure

#### Scenario: Domain-specific metadata is not invented
- **WHEN** the selected legal files contain domain-specific metadata such as legal status, issuer, region, source URL, or official identifiers
- **THEN** the product MUST preserve parsed source metadata as unknown or source metadata when present
- **AND** model assistance MUST only fill generic knowledge-base metadata and graph relationships where the schema allows it
- **AND** it MUST NOT invent legal-only product-required fields

### Requirement: Release-gate bug-fix loop and evidence
The cleaned legal validation flow SHALL require discovered bugs to be fixed or explicitly reported before completion.

#### Scenario: Validation discovers a product bug
- **WHEN** a black-box or white-box check fails because of product behavior
- **THEN** implementation MUST record the failing command, endpoint, browser step, assertion, log excerpt, screenshot note, or persisted-state mismatch before fixing
- **AND** it MUST add or update focused regression coverage where practical
- **AND** it MUST fix the owning module with minimal modular changes and without adding unrelated fallback logic

#### Scenario: Fix is verified through affected slice
- **WHEN** a product bug has been fixed
- **THEN** the targeted regression check MUST pass
- **AND** the affected black-box or white-box validation slice MUST be rerun before the task is marked complete

#### Scenario: Three validation passes are completed
- **WHEN** implementation reaches final verification
- **THEN** it MUST perform at least three validation-and-correction passes across the affected flow
- **AND** if three passes cannot be completed, the final report MUST explain the blocker, completed passes, remaining risk, and required manual action

#### Scenario: Final report is redacted
- **WHEN** validation completes
- **THEN** the final report MUST include selected sample count, selected basenames or redacted labels, service URLs or ports, commands run, black-box results, white-box results, model-assistance mode, security checks, fixed bugs, tests run, unresolved blockers, and manual review items
- **AND** it MUST NOT include local absolute paths, private dataset names, raw legal Markdown bodies, credentials, API keys, S3 secrets, raw S3 object keys, provider secrets, session cookies, model prompts, or provider authorization headers

### Requirement: Release-gate cleanup and repeatability
The cleaned legal validation flow SHALL keep local validation repeatable without leaving misleading product state.

#### Scenario: Destructive local reset is allowed
- **WHEN** validation requires a clean local state
- **THEN** it MAY clear local PostgreSQL, Redis, and S3-compatible test state because the product is pre-release
- **AND** it MUST rerun required migrations and service startup checks before validation

#### Scenario: Cleanup is verified
- **WHEN** validation deletes source-backed pages or knowledge bases
- **THEN** black-box checks MUST verify deleted public resources are unavailable
- **AND** white-box checks MUST verify PostgreSQL deletion state, replacement releases, updated bundle indexes, Redis coordination state, and S3-compatible generated artifacts no longer expose stale active public references

#### Scenario: Repository remains safe for open source
- **WHEN** validation artifacts, tests, reports, or documentation are written
- **THEN** repository-visible files MUST remain safe for an open-source project
- **AND** a no-local-path or equivalent redaction check MUST pass before the change is marked complete

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

