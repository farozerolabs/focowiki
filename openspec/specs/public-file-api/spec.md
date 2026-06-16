## Purpose

Define the public OpenAPI file-read surface for serving generated Markdown and JSON index files with path safety, authentication modes, and CORS behavior.
## Requirements
### Requirement: Raw public file reads
The public file API SHALL serve the active bundle's generated Markdown and JSON index files as raw response bodies.

#### Scenario: Public OpenAPI runs separately from Admin API
- **WHEN** the system starts local services
- **THEN** public file-read routes MUST be served from the public OpenAPI listener instead of the internal Admin API listener
- **AND** Admin API routes MUST NOT be served from the public OpenAPI listener

#### Scenario: Read root Markdown entry
- **WHEN** a client requests `GET /index.md`
- **THEN** the API MUST return the active bundle's `index.md` body with a Markdown content type and no business JSON envelope

#### Scenario: Read root log Markdown entry
- **WHEN** a client requests `GET /log.md`
- **THEN** the API MUST return the active bundle's `log.md` body with a Markdown content type and no business JSON envelope

#### Scenario: Read concept Markdown file
- **WHEN** a client requests `GET /pages/{file}.md` for an existing generated page file
- **THEN** the API MUST return the Markdown body with a Markdown content type and no business JSON envelope

#### Scenario: Raw source Markdown path is requested
- **WHEN** a client requests `GET /sources/{file}.md`
- **THEN** the API MUST return a stable unsupported or not-found JSON error
- **AND** it MUST NOT return raw uploaded source content or S3 storage details

#### Scenario: Read JSON index file
- **WHEN** a client requests `GET /_index/manifest.json`, `GET /_index/search.json`, or `GET /_index/links.json`
- **THEN** the API MUST return the JSON body with an `application/json` content type and no business JSON envelope

### Requirement: Public API authentication modes
The public file API SHALL require database-backed bearer API keys for public OpenAPI reads and task status requests.

#### Scenario: Request has no API key
- **WHEN** a public OpenAPI request has no bearer API key
- **THEN** the API MUST return 401 without returning file content or task status data
- **AND** it MUST NOT reveal whether the requested knowledge base, file, or task exists

#### Scenario: Request has incorrect API key
- **WHEN** a public OpenAPI request includes an unknown, malformed, revoked, deleted, or otherwise invalid bearer API key
- **THEN** the API MUST return 401 without returning file content or task status data
- **AND** it MUST NOT reveal whether the requested knowledge base, file, or task exists

#### Scenario: Request has active API key
- **WHEN** a public OpenAPI request includes an active database-backed bearer API key
- **THEN** the API MUST authorize the request and continue enforcing knowledge base scoping, path safety, rate limits, and storage streaming rules

#### Scenario: Key lookup is cached
- **WHEN** the public OpenAPI validates a bearer API key
- **THEN** it MAY use Redis to cache active key lookup results with bounded TTL
- **AND** it MUST fall back to PostgreSQL on cache miss
- **AND** it MUST NOT cache or store raw key values in Redis

#### Scenario: Anonymous mode is attempted
- **WHEN** deployment attempts to disable public OpenAPI key authentication through env or request parameters
- **THEN** the public OpenAPI MUST continue requiring a valid active bearer key

### Requirement: Path safety and not found behavior
The public file API SHALL reject path traversal and unsupported paths before reading storage.

#### Scenario: Path traversal is requested
- **WHEN** a request path contains traversal, encoded traversal, backslashes, empty path segments, or another form that resolves outside the logical bundle root
- **THEN** the API MUST reject the request without reading S3 objects outside the active bundle

#### Scenario: Unsupported public path is requested
- **WHEN** a request path is outside `index.md`, `log.md`, `schema.md`, `pages/*.md`, or `/_index/*.json`
- **THEN** the API MUST return 404 or another stable unsupported-path JSON error
- **AND** requests for `sources/*.md` MUST be treated as unsupported public paths

#### Scenario: Allowed file does not exist
- **WHEN** a request path is allowed but the active bundle has no matching file
- **THEN** the API MUST return 404

### Requirement: Public URL construction and CORS
The system SHALL construct public URLs from `PUBLIC_BASE_URL` and apply configured CORS origins to public file responses.

#### Scenario: Admin result returns public URLs
- **WHEN** generation succeeds
- **THEN** the Admin API MUST return public URLs for `index.md`, `_index/search.json`, and `_index/links.json` based on `PUBLIC_BASE_URL`

#### Scenario: CORS origins are configured
- **WHEN** `CORS_ORIGINS` contains allowed origins
- **THEN** public file responses MUST apply CORS headers only for configured origins

### Requirement: Knowledge base scoped public file reads
The public OpenAPI SHALL support knowledge base scoped raw generated file reads so multiple knowledge bases can coexist.

#### Scenario: Read scoped root Markdown entry
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/index.md`
- **THEN** the API MUST resolve the active file record from the database, read the `index.md` body from S3-compatible storage, and return it with a Markdown content type and no business JSON envelope

#### Scenario: Read scoped log Markdown entry
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/log.md`
- **THEN** the API MUST resolve the active file record from the database, read the `log.md` body from S3-compatible storage, and return it with a Markdown content type and no business JSON envelope

#### Scenario: Read scoped schema Markdown entry
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/schema.md`
- **THEN** the API MUST resolve the active file record from the database, read the `schema.md` body from S3-compatible storage, and return it with a Markdown content type and no business JSON envelope

#### Scenario: Read scoped concept Markdown file
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/pages/{file}.md` for an existing generated page file
- **THEN** the API MUST resolve the active file record from the database, read the Markdown body from S3-compatible storage, and return it with a Markdown content type and no business JSON envelope

#### Scenario: Scoped raw source Markdown path is requested
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/sources/{file}.md`
- **THEN** the API MUST return a stable unsupported or not-found JSON error
- **AND** it MUST NOT return raw uploaded source content or S3 storage details

#### Scenario: Read scoped JSON index file
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/_index/manifest.json`, `GET /kb/{knowledgeBaseId}/_index/search.json`, or `GET /kb/{knowledgeBaseId}/_index/links.json`
- **THEN** the API MUST resolve the active file record from the database, read the requested JSON body from S3-compatible storage, and return it with an `application/json` content type and no business JSON envelope

#### Scenario: Knowledge base does not exist
- **WHEN** a client requests a public file for a missing knowledge base identifier
- **THEN** the API MUST return 404

### Requirement: Public upload task status reads
The public OpenAPI SHALL expose the unified upload parsing task lifecycle status as JSON.

#### Scenario: Read latest task status
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/tasks/latest` with an active database-backed bearer key
- **THEN** the API MUST return a JSON document containing the knowledge base identifier, task identifier, `startedAt`, nullable `endedAt`, and unified running-or-ended lifecycle state

#### Scenario: Internal phase details exist
- **WHEN** admin task menu phase detail entries exist for the latest upload parsing task
- **THEN** the public task status response MUST NOT include internal phase keys, phase messages, phase timestamps, or separate phase statuses

#### Scenario: Task status lacks active key
- **WHEN** a task status request lacks an active database-backed bearer key
- **THEN** the API MUST return 401 without returning task status data

#### Scenario: File read lacks active key
- **WHEN** a public file request lacks an active database-backed bearer key
- **THEN** the API MUST return 401 without returning file data

#### Scenario: Task does not exist
- **WHEN** a client requests task status for a knowledge base with no upload parsing task using an active database-backed bearer key
- **THEN** the API MUST return 404

### Requirement: Public OpenAPI error responses
The public OpenAPI SHALL return small JSON error bodies for failed public requests.

#### Scenario: Public file read fails
- **WHEN** a public Markdown or JSON file request fails due to auth, validation, path safety, not found, or server error
- **THEN** the API MUST return a JSON error body with a stable error code
- **AND** it MUST NOT return a business envelope on successful file reads

#### Scenario: Public task status read fails
- **WHEN** a public task status request fails due to auth, validation, path safety, not found, or server error
- **THEN** the API MUST return a JSON error body with a stable error code

#### Scenario: Public error is returned
- **WHEN** any public OpenAPI error response is returned
- **THEN** it MUST NOT expose S3 bucket names, `S3_PREFIX`, raw object keys, release IDs, storage task IDs, provider headers, or secret values

### Requirement: Public path safety for scoped routes
The public OpenAPI SHALL apply the same path safety rules to knowledge base scoped file and status routes.

#### Scenario: Scoped path traversal is requested
- **WHEN** a scoped public request contains traversal, encoded traversal, backslashes, empty path segments, or another form that resolves outside the logical knowledge base route
- **THEN** the API MUST reject the request without reading S3 objects or database records outside the requested knowledge base scope

### Requirement: Public URLs hide S3 storage details
The public OpenAPI SHALL expose product-level knowledge base paths and SHALL NOT expose internal S3 storage details.

#### Scenario: Public file response is returned
- **WHEN** a public file or task status response succeeds
- **THEN** the response MUST NOT include S3 bucket names, `S3_PREFIX`, release IDs, task IDs used in storage keys, or raw S3 object keys unless the task identifier is explicitly part of the public task status contract

#### Scenario: Public URL is constructed
- **WHEN** the Admin API returns public file URLs after generation
- **THEN** each URL MUST use `PUBLIC_BASE_URL` plus `/kb/{knowledgeBaseId}/...` paths instead of S3 URLs

### Requirement: Streaming public file responses
The public OpenAPI SHALL serve file bodies without loading full S3 objects or generated indexes into process memory.

#### Scenario: Public file lookup is requested
- **WHEN** a client requests a scoped public Markdown or JSON file by knowledge base ID and logical path
- **THEN** the API MUST perform a single scoped database file record lookup using indexed fields
- **AND** it MUST NOT list or materialize the full knowledge base file tree to find the requested file

#### Scenario: Public Markdown or JSON file is read
- **WHEN** a client requests a scoped public Markdown or JSON file
- **THEN** the API MUST resolve the database file record and stream the S3-compatible object body to the response with bounded memory

#### Scenario: Public index file is large
- **WHEN** a generated `_index/*.json` file grows with the knowledge base
- **THEN** the API MUST read it as an S3-compatible object stream or bounded buffer according to configured response limits rather than recomputing it in process memory for the request

### Requirement: Public deletion visibility
The public OpenAPI SHALL serve only non-deleted knowledge bases and files from the current active release.

#### Scenario: Deleted knowledge base is requested
- **WHEN** a client requests any public file or task status for a deleted knowledge base
- **THEN** the public OpenAPI MUST return not found or the stable auth response required by private mode
- **AND** it MUST NOT reveal whether historical internal records or S3 objects remain

#### Scenario: Deleted page is requested after republish
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/pages/{file}.md` for a page removed by a deletion republish
- **THEN** the public OpenAPI MUST return not found
- **AND** it MUST NOT fall back to older releases or raw source objects

#### Scenario: Public indexes are requested after deletion
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/_index/search.json` or `GET /kb/{knowledgeBaseId}/_index/links.json` after deletion republish
- **THEN** the public OpenAPI MUST return the index files from the current active release
- **AND** those files MUST NOT include the deleted page path or graph edges involving that path

#### Scenario: Public manifest is requested after deletion
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/_index/manifest.json` after deletion republish
- **THEN** the public OpenAPI MUST return the manifest file from the current active release
- **AND** the manifest MUST NOT include the deleted page path

#### Scenario: Public schema is requested after deletion
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/schema.md` after deletion republish
- **THEN** the public OpenAPI MUST return the schema file from the current active release
- **AND** it MUST not fall back to S3 object keys or files outside the active release

#### Scenario: Public root index is requested after deletion
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/index.md` after deletion republish
- **THEN** the public OpenAPI MUST return the root index file from the current active release
- **AND** it MUST NOT include links to deleted page paths

#### Scenario: Public root log is requested after deletion
- **WHEN** a client requests `GET /kb/{knowledgeBaseId}/log.md` after deletion republish
- **THEN** the public OpenAPI MUST return the root log file from the current active release
- **AND** it MUST NOT expose deleted raw source paths, S3 object keys, release IDs, task IDs used in storage keys, or files outside the active release

#### Scenario: Deleted resource errors are returned
- **WHEN** a public request fails because a knowledge base or page was deleted
- **THEN** the error body MUST use a stable error code
- **AND** it MUST NOT expose S3 bucket names, `S3_PREFIX`, raw object keys, deleted source identifiers, release IDs, task IDs used in storage keys, provider headers, or secret values

### Requirement: Public OpenAPI read-only enforcement
The public OpenAPI SHALL expose only scoped read behavior for generated files and public task status.

#### Scenario: Unsupported method is requested
- **WHEN** a client sends POST, PUT, PATCH, DELETE, or another unsupported method to a public OpenAPI file or task route
- **THEN** the public OpenAPI MUST return a stable safe error
- **AND** it MUST NOT mutate knowledge bases, source files, tasks, releases, storage objects, or audit state except for bounded security audit events

#### Scenario: Admin route is requested on public listener
- **WHEN** a client requests an Admin API route from the public OpenAPI listener
- **THEN** the public OpenAPI MUST return not found or another stable unsupported-route response
- **AND** it MUST NOT proxy or expose Admin API behavior

### Requirement: Public OpenAPI rate limiting
The public OpenAPI SHALL enforce independent read rate limits.

#### Scenario: Public requests exceed limit
- **WHEN** public file or task status requests exceed configured limits for a client, API key, or route within the configured window
- **THEN** the public OpenAPI MUST return a stable rate-limit response before reading S3 objects or running expensive database work
- **AND** the rate limit state MUST be Redis-backed or otherwise coordinated outside process memory

#### Scenario: Private mode key is invalid repeatedly
- **WHEN** requests in private mode repeatedly provide missing or incorrect bearer keys
- **THEN** the public OpenAPI MUST continue returning stable authentication errors and MAY apply stricter configured throttling
- **AND** it MUST NOT reveal whether the requested knowledge base or file exists

### Requirement: Public OpenAPI CORS and response security
The public OpenAPI SHALL apply configured CORS and security headers without weakening private mode.

#### Scenario: Allowed CORS origin requests public content
- **WHEN** a request Origin matches the configured CORS allowlist
- **THEN** the public OpenAPI MUST emit the configured CORS headers for allowed methods and headers

#### Scenario: Disallowed CORS origin requests public content
- **WHEN** a request Origin does not match the configured CORS allowlist
- **THEN** the public OpenAPI MUST omit permissive CORS headers
- **AND** private mode MUST NOT use wildcard CORS origins

#### Scenario: Public response is returned
- **WHEN** the public OpenAPI returns Markdown, JSON, task status, auth error, path error, or rate-limit error responses
- **THEN** it MUST include security headers appropriate for raw file reads
- **AND** it MUST NOT expose S3 storage details or secret values

#### Scenario: Public OpenAPI runs behind a domain reverse proxy
- **WHEN** public OpenAPI is accessed through a configured domain and reverse proxy
- **THEN** auth, CORS, rate limiting, generated public URLs, and security headers MUST use configured public origins and trusted proxy settings
- **AND** untrusted Host or forwarded headers MUST NOT alter public URL construction, CORS decisions, auth behavior, or rate-limit identity

### Requirement: Public OpenAPI path and object safety
The public OpenAPI SHALL reject unsafe paths before resolving storage records.

#### Scenario: Unsafe path variant is requested
- **WHEN** a public request contains traversal, encoded traversal, mixed separators, control characters, null bytes, double-encoded segments, unsupported directories, or another path that resolves outside the allowed public logical paths
- **THEN** the public OpenAPI MUST reject the request without reading S3 objects outside the active release
- **AND** the response MUST use a stable redacted error

#### Scenario: Public file is read
- **WHEN** a public file request passes auth, rate limit, method, and path checks
- **THEN** the public OpenAPI MUST resolve exactly one active database file record scoped to the requested knowledge base and logical path
- **AND** it MUST stream or bounded-read the corresponding S3 object without listing a full bucket or materializing the full file tree
