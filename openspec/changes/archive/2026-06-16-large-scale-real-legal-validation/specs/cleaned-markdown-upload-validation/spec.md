## ADDED Requirements

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
