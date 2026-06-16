## MODIFIED Requirements

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
