# cleaned-markdown-upload-validation Specification

## Purpose
TBD - created by archiving change validate-cleaned-markdown-upload-flow. Update Purpose after archive.
## Requirements
### Requirement: Curated cleaned Markdown sample set
The validation workflow SHALL select a deterministic 24-file sample set from the final renamed cleaned Markdown dataset through local-only configuration without copying Markdown bodies or developer-machine paths into the repository.

#### Scenario: Sample set is selected
- **WHEN** the validation workflow prepares upload inputs
- **THEN** it MUST read the source directory from `FOCOWIKI_VALIDATION_MARKDOWN_DIR`
- **AND** it MUST select exactly 24 `.md` files
- **AND** it MUST record only selected file basenames or redacted relative sample labels in committed validation manifests or reports

#### Scenario: Local path is not committed
- **WHEN** validation scripts, tests, manifests, reports, docs, or OpenSpec artifacts are written for this change
- **THEN** they MUST NOT contain developer-machine absolute paths, local usernames, local-only directory labels, or local cleaned-data directory names
- **AND** local filesystem roots MUST be supplied only through uncommitted environment configuration or local command arguments

#### Scenario: Sample set covers risky legal data shapes
- **WHEN** the 24-file sample set is built
- **THEN** it MUST include files with multiple legal statuses, multiple legal categories, duplicated legal titles with different versions, long titles, and files whose names contain `unknown-date`

#### Scenario: Sample source path is missing
- **WHEN** the expected cleaned Markdown directory or a selected file does not exist
- **THEN** the validation workflow MUST fail with a clear prerequisite error
- **AND** it MUST NOT silently select replacement files

### Requirement: End-to-end upload flow validation
The validation workflow SHALL verify that the selected cleaned Markdown files can be uploaded into a real knowledge base and published as an OKF bundle through the production service boundaries.

#### Scenario: Upload and publish succeeds
- **WHEN** local PostgreSQL, Redis, S3-compatible storage, Admin API, Admin UI, and public OpenAPI configuration are available
- **AND** an authenticated admin creates a test knowledge base
- **AND** the 24 selected `.md` files are uploaded in one upload action
- **THEN** the system MUST create exactly one upload task for that upload action
- **AND** the task MUST eventually have an end timestamp
- **AND** the knowledge base MUST have an active release after generation succeeds

#### Scenario: Persistent records are created
- **WHEN** the 24-file upload completes successfully
- **THEN** PostgreSQL MUST contain knowledge base, upload task, source file, release, bundle file, and bundle tree records for the test knowledge base
- **AND** raw Markdown and generated Markdown or JSON file bodies MUST NOT be stored in database columns

#### Scenario: File bodies remain storage-backed
- **WHEN** generated file previews or public file reads are requested after the upload completes
- **THEN** file bodies MUST be resolved through database file records and streamed from S3-compatible storage
- **AND** Redis MUST NOT be the source of truth for file bodies or durable release data

### Requirement: Admin API validation
The validation workflow SHALL verify the Admin API behavior that supports the cleaned Markdown upload flow.

#### Scenario: Admin authentication is required
- **WHEN** the validation workflow calls Admin API endpoints without a valid admin session
- **THEN** protected knowledge base, upload, task, file tree, and file preview endpoints MUST reject the request

#### Scenario: Knowledge base and upload APIs work together
- **WHEN** the validation workflow logs in with environment-configured admin credentials
- **AND** creates a knowledge base
- **AND** uploads the selected `.md` files
- **THEN** Admin API responses MUST include stable IDs needed to poll task status and inspect generated files

#### Scenario: Task API returns one lifecycle status
- **WHEN** the validation workflow reads upload tasks for the test knowledge base
- **THEN** the uploaded file set MUST appear as one task record
- **AND** the task lifecycle MUST be represented by start and end timestamps
- **AND** admin-only phase details MUST be bounded detail entries under that one task

#### Scenario: Admin file APIs are bounded
- **WHEN** the validation workflow reads generated file tree, source file list, release list, bundle file list, task list, or task phase details
- **THEN** the Admin API MUST use bounded paginated responses
- **AND** it MUST NOT require loading all records into process memory or browser memory

### Requirement: Public OpenAPI validation
The validation workflow SHALL verify public knowledge-base-scoped OpenAPI reads for the uploaded sample knowledge base.

#### Scenario: Public Markdown and JSON files are readable
- **WHEN** generation completes for the test knowledge base
- **THEN** public OpenAPI requests under `/kb/{knowledgeBaseId}/index.md`, `/kb/{knowledgeBaseId}/schema.md`, `/kb/{knowledgeBaseId}/pages/*.md`, and `/kb/{knowledgeBaseId}/_index/*.json` MUST return the expected raw Markdown or JSON body for existing generated files
- **AND** successful file reads MUST NOT expose a business JSON envelope

#### Scenario: Public raw source paths are not exposed
- **WHEN** generation completes for the test knowledge base
- **THEN** public OpenAPI requests under `/kb/{knowledgeBaseId}/sources/*.md` MUST return a stable unsupported or not-found JSON error
- **AND** the response MUST NOT expose raw uploaded source bodies, S3 bucket names, S3 prefixes, object keys, release IDs, provider headers, or secrets

#### Scenario: Public task status hides internal phase details
- **WHEN** the validation workflow requests the public latest task status for the test knowledge base
- **THEN** the response MUST expose only the unified task lifecycle shape
- **AND** it MUST NOT expose admin-only phase details

#### Scenario: Public auth mode is enforced
- **WHEN** `PUBLIC_API_AUTH_REQUIRED=true`
- **THEN** public file and task status requests without the configured bearer key MUST return `401`
- **AND** requests with the correct bearer key MUST return allowed existing resources

#### Scenario: Public unsafe paths are rejected
- **WHEN** the validation workflow requests traversal, encoded traversal, backslash paths, unsupported logical paths, or missing files
- **THEN** public OpenAPI responses MUST return stable JSON errors without exposing S3 bucket names, prefixes, object keys, release IDs, provider headers, or secrets

### Requirement: Admin UI browser validation
The validation workflow SHALL verify the production Admin UI behavior in a browser after realistic cleaned Markdown upload.

#### Scenario: Login and knowledge base creation work in the browser
- **WHEN** the validation workflow opens the Admin UI in a browser
- **AND** logs in with the configured username and password
- **AND** creates a knowledge base
- **THEN** the home page MUST show the created knowledge base as a clickable card

#### Scenario: Upload dialog submits selected Markdown files
- **WHEN** the validation workflow opens the test knowledge base detail page
- **AND** selects the 24 cleaned `.md` files in the upload dialog
- **AND** submits the upload
- **THEN** the dialog MUST close or show a clear submitted state
- **AND** the task list MUST refresh without requiring a manual full-page browser reload

#### Scenario: Task list and file tree refresh after completion
- **WHEN** the upload task completes
- **THEN** the Admin UI MUST show the completed task in the task menu
- **AND** the file tree MUST show generated files from the active release without replacing unrelated existing files incorrectly

#### Scenario: File preview and copy actions work
- **WHEN** the validation workflow selects generated Markdown and JSON files in the Admin UI
- **THEN** the preview pane MUST render the selected file safely
- **AND** public URL copy actions MUST copy knowledge-base-scoped public URLs that do not expose S3 implementation details

#### Scenario: Language switching remains page-local
- **WHEN** the validation workflow switches language from the login page or authenticated pages
- **THEN** user-visible labels, errors, status text, and task messages MUST be loaded from i18n resources
- **AND** no new hardcoded user-facing Chinese or English strings may be introduced in UI components

### Requirement: Bug fix and regression evidence
The validation workflow SHALL turn discovered issues into minimal fixes with reproducible regression coverage.

#### Scenario: Validation finds a product bug
- **WHEN** an Admin UI, Admin API, public OpenAPI, OKF generation, database, Redis, or S3 boundary bug is found during the 24-file validation flow
- **THEN** the failing command, endpoint, browser step, or screenshot note MUST be recorded before fixing
- **AND** a focused failing test or validation check MUST be added when practical

#### Scenario: Bug is fixed
- **WHEN** a bug fix is implemented
- **THEN** the fix MUST be scoped to the owning module
- **AND** the targeted regression test or validation check MUST pass
- **AND** the 24-file validation flow or affected subset MUST be rerun after the fix

#### Scenario: Validation completes
- **WHEN** all blocking validation failures are fixed or explicitly reported as residual risk
- **THEN** the change MUST include a final validation report listing selected files, commands, service URLs or ports used, bugs found, fixes applied, tests run, browser verification notes, OpenAPI verification notes, and remaining risks

### Requirement: Cleaned Markdown sample participates in full-flow evidence
The cleaned Markdown upload validation SHALL provide the real Markdown sample used by the full-flow validation.

#### Scenario: Sample files are prepared
- **WHEN** the full-flow validation needs cleaned Markdown files
- **THEN** the cleaned Markdown upload validation MUST provide a deterministic bounded sample from local-only configuration
- **AND** it MUST preserve original filenames, frontmatter metadata, headings, and source URLs already present in the Markdown
- **AND** it MUST NOT require upload-form metadata fields

#### Scenario: Sample upload completes
- **WHEN** the selected cleaned Markdown sample is uploaded through the Admin API or Admin UI
- **THEN** the upload MUST create one upload task row for that upload action
- **AND** the task MUST end after storage, metadata parsing, OKF generation, validation, index publication, and activation finish
- **AND** generated file tree records MUST grow from the uploaded source set rather than replacing previous non-deleted source-backed files in the knowledge base

#### Scenario: Sample data is redacted from repository outputs
- **WHEN** validation artifacts, reports, test fixtures, or logs are written to repository-tracked locations
- **THEN** they MUST omit raw legal document bodies, local absolute paths, private dataset names, credentials, and raw storage object keys
- **AND** they MAY include redacted basenames, counts, IDs, and checksums when needed for reproducible debugging

### Requirement: Single and batch cleaned Markdown samples
The cleaned Markdown upload validation SHALL provide deterministic local-only sample inputs for both single-file and multi-file upload validation.

#### Scenario: Single-upload sample is selected
- **WHEN** validation prepares the single-file upload input
- **THEN** it MUST select exactly one `.md` file from the local-only cleaned Markdown dataset configuration
- **AND** it MUST preserve the file's original basename, frontmatter metadata, headings, and source URLs during upload
- **AND** committed artifacts MUST record only the basename or a redacted label, not the local path or raw body

#### Scenario: Batch-upload sample is selected
- **WHEN** validation prepares the batch upload input
- **THEN** it MUST select a bounded deterministic set of `.md` files that does not include the single-upload sample
- **AND** it MUST include varied cleaned legal data shapes when available, including multiple metadata shapes, long names, non-ASCII names, status variants, and duplicate-title/version patterns
- **AND** it MUST not load the full dataset bodies into process memory before selecting the sample

#### Scenario: Invalid sample inputs are found
- **WHEN** the configured dataset is missing, unreadable, has too few `.md` files, or includes selected non-Markdown inputs
- **THEN** validation MUST fail with a clear prerequisite or input error
- **AND** it MUST NOT silently select replacement files or submit non-Markdown files

### Requirement: Upload validation preserves local data safety
The cleaned Markdown upload validation SHALL prevent local dataset details and private content from entering repository artifacts.

#### Scenario: Validation artifacts are written
- **WHEN** scripts, tests, manifests, reports, OpenSpec artifacts, or logs are written to repository-tracked locations
- **THEN** they MUST omit local absolute paths, local usernames, private dataset directory names, raw legal document bodies, credentials, API keys, S3 secrets, and raw storage object keys
- **AND** they MAY include sample counts, redacted labels, basenames, checksums, public route paths, and product-level service ports when needed for debugging

#### Scenario: Upload form metadata is not required
- **WHEN** the selected single or batch cleaned Markdown samples are uploaded through Admin UI or Admin API
- **THEN** validation MUST confirm the upload flow does not require default type, title, description, tags, source URL, legal status, or sidecar metadata fields
- **AND** metadata must be parsed or resolved from each uploaded Markdown file after upload according to the domain-agnostic ingestion contract

### Requirement: Security validation for Markdown upload flows
The cleaned Markdown upload validation SHALL include security regression checks for realistic upload, preview, Admin API, and public OpenAPI attack paths.

#### Scenario: Malicious Markdown sample is validated
- **WHEN** validation prepares security-focused Markdown inputs
- **THEN** it MUST include bounded fixtures or generated samples with script-like Markdown, raw HTML, special filenames, long filenames, duplicate filename attempts, and unsupported file extensions
- **AND** committed fixtures MUST NOT include real private legal document bodies, local absolute paths, credentials, or raw S3 object keys

#### Scenario: Unsupported uploads are tested
- **WHEN** validation submits non-Markdown files, oversized files, too many files, duplicate filenames, or unsafe filenames
- **THEN** the Admin API and Admin UI MUST reject the inputs with stable safe errors
- **AND** no source records, generated pages, or S3 source objects from invalid uploads may become active

### Requirement: Security validation for admin authentication and sessions
The cleaned Markdown upload validation SHALL verify admin authentication, session, and write protection behavior.

#### Scenario: Admin security validation runs
- **WHEN** security validation exercises Admin API and Admin UI authentication
- **THEN** it MUST verify unauthenticated rejection, valid login, invalid login, generic login failure shape, login throttling, automated probing resistance, signed cookie rejection, session fixation rejection, logout invalidation, CSRF or origin rejection for state-changing requests, and safe error redaction

#### Scenario: Console access tampering is validated
- **WHEN** security validation tampers with frontend route state, request payloads, cookies, object identifiers, cursors, logical paths, or mutation routes
- **THEN** Admin API requests MUST remain protected by server-side authorization and validation
- **AND** protected console data MUST NOT be returned because of tampered client-side state

#### Scenario: Protected route redirects are validated
- **WHEN** browser validation opens protected Admin UI URLs without a valid session or after session invalidation
- **THEN** the browser MUST land on the login page
- **AND** protected console content MUST NOT be visible before or after the redirect

#### Scenario: Security audit evidence is checked
- **WHEN** validation triggers security-sensitive events
- **THEN** it MUST verify bounded audit evidence exists where required
- **AND** that evidence MUST NOT include passwords, session cookies, API keys, S3 object keys, model keys, raw Markdown bodies, or local paths

### Requirement: Security validation for public OpenAPI
The cleaned Markdown upload validation SHALL verify public OpenAPI read-only and path-safety behavior.

#### Scenario: Public OpenAPI security validation runs
- **WHEN** validation calls public OpenAPI after a successful upload
- **THEN** it MUST verify API key behavior, unsupported method rejection, Admin route rejection, traversal and encoded traversal rejection, raw source path rejection, CORS behavior, rate limiting, stable errors, and absence of S3 or secret leakage

#### Scenario: Public OpenAPI remains bounded
- **WHEN** validation reads generated Markdown and JSON through public OpenAPI
- **THEN** it MUST verify the request uses scoped public routes and does not require full tree materialization or raw S3 path exposure

### Requirement: Security validation for reverse proxy deployment behavior
The cleaned Markdown upload validation SHALL verify domain and reverse-proxy security behavior without depending on a specific proxy vendor.

#### Scenario: Reverse proxy security validation runs
- **WHEN** validation runs with configured public origins, trusted proxy settings, forwarded headers, and allowed hosts
- **THEN** it MUST verify secure cookie decisions, host allowlist behavior, forwarded header trust, CORS decisions, generated public URLs, and redacted errors
- **AND** untrusted forwarded headers or Host values MUST NOT change auth, origin, cookie, URL, or rate-limit decisions

### Requirement: Security validation report
The cleaned Markdown upload validation SHALL produce a redacted security validation report.

#### Scenario: Security validation completes
- **WHEN** security validation finishes
- **THEN** the report MUST include commands run, service origins or ports, checks passed or failed, bugs found, fixes applied, residual risks, and redacted sample labels
- **AND** it MUST NOT include local absolute paths, credentials, secret values, raw Markdown bodies, raw S3 object keys, provider headers, model prompts, or session cookies

### Requirement: Large-scale cleaned Markdown sample inputs
The cleaned Markdown upload validation SHALL support a large-scale sample profile that selects at least 50 real cleaned Markdown files from local-only configuration.

#### Scenario: Large-scale sample count is configured
- **WHEN** validation prepares a large-scale batch upload input
- **THEN** it MUST require a minimum batch size of 50 valid `.md` files
- **AND** it MUST allow a larger configured count when explicitly configured
- **AND** it MUST fail with a clear input error when the configured dataset cannot satisfy the minimum

#### Scenario: Large-scale sample selection is bounded
- **WHEN** validation selects 50 or more cleaned Markdown files
- **THEN** it MUST select files deterministically without reading every full source body into process memory
- **AND** it MUST ignore non-Markdown files
- **AND** it MUST preserve original basenames, frontmatter metadata, headings, and source URLs during upload
- **AND** committed artifacts MUST record only redacted labels, basenames, counts, checksums, or safe product route paths when needed

#### Scenario: Large-scale sample covers risky shapes
- **WHEN** the configured dataset contains varied cleaned Markdown records
- **THEN** the selected large-scale sample MUST include multiple metadata shapes, missing or unknown metadata fields, long filenames, non-ASCII filenames, duplicate-title/version patterns, unknown-date files, and multiple status/category values when available
- **AND** validation MUST record coverage warnings when the dataset cannot provide one of those shapes

### Requirement: Large-scale upload validation flow
The cleaned Markdown upload validation SHALL verify that single-file, 24-file baseline, and 50+ file large-scale upload profiles all work through the production service boundaries.

#### Scenario: Large-scale upload is submitted
- **WHEN** an authenticated admin submits one upload request containing at least 50 valid Markdown files
- **THEN** the Admin API MUST accept the request only when it is within configured upload limits
- **AND** it MUST create exactly one upload task row
- **AND** `sourceCount` MUST equal the accepted file count
- **AND** upload validation MUST reject non-Markdown, duplicate, unsafe, too-large, or too-many-file inputs before they become active public pages

#### Scenario: Large-scale upload completes
- **WHEN** the 50+ file upload task completes successfully
- **THEN** the active release MUST include generated public pages for all accepted non-deleted sources in the knowledge base
- **AND** root files and `_index` files MUST include `index.md`, `log.md`, `schema.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`
- **AND** the file tree MUST grow from the uploaded source set rather than replacing unrelated previously active non-deleted source-backed files

#### Scenario: Large-scale upload progress is visible
- **WHEN** the 50+ file upload task is running
- **THEN** Admin API task reads and Admin UI task rows MUST expose one unified lifecycle status with bounded task-level aggregate progress when enough persisted data exists
- **AND** expanded task file rows MUST be paginated and scoped to the selected task
- **AND** internal phases MUST remain details under the one task rather than separate task rows

### Requirement: Large-scale upload persistence boundaries
The cleaned Markdown upload validation SHALL prove large uploads remain storage-backed and pagination-backed.

#### Scenario: Large-scale source records are persisted
- **WHEN** at least 50 files are accepted for upload
- **THEN** PostgreSQL MUST contain one source record per accepted source, preserving original filename and parsed metadata
- **AND** source records MUST be queryable through bounded pages
- **AND** raw Markdown bodies MUST NOT be persisted in PostgreSQL or Redis

#### Scenario: Large-scale source bodies are stored
- **WHEN** accepted files are stored
- **THEN** source bodies MUST be stored in S3-compatible storage under internal knowledge-base-scoped upload paths
- **AND** generated public bodies MUST be stored in S3-compatible storage under active release bundle paths
- **AND** Admin previews and public OpenAPI reads MUST resolve file bodies through database records and S3-compatible storage rather than process-memory caches

#### Scenario: Large-scale pagination is enforced
- **WHEN** validation reads task files, file tree nodes, bundle files, releases, generated files, public files, or internal verification rows
- **THEN** reads MUST be bounded by page size, cursor, direct logical path, direct ID, or aggregate query
- **AND** no validation or product code path may load all files, all tree nodes, all source bodies, or all generated index rows into process memory to answer a paginated request

### Requirement: Large-scale upload safety report
The cleaned Markdown upload validation SHALL produce redacted large-scale upload evidence suitable for repository artifacts.

#### Scenario: Large-scale upload report is written
- **WHEN** validation writes a report for the large-scale profile
- **THEN** it MUST include sample count, selected basenames, coverage warnings, upload task ID or redacted task label, generated file counts, pagination evidence, storage-backed evidence, public route evidence, security checks, performance metrics, bugs found, fixes applied, and tests run
- **AND** it MUST omit local absolute paths, private directory names, raw legal bodies, credentials, raw OpenAPI keys, S3 secrets, raw object keys, provider payloads, session cookies, and internal storage identifiers

#### Scenario: Repository leak check runs
- **WHEN** implementation completes the large-scale validation change
- **THEN** repository-visible files MUST be scanned for local dataset roots, raw body snippets, credentials, S3 object keys, provider payloads, and generated internal storage identifiers
- **AND** the change MUST NOT be marked complete until that scan passes or an explicit blocker is reported
