## Purpose

Define deterministic OKF-style bundle generation from uploaded Markdown sources, metadata, optional model suggestions, and static indexes.
## Requirements
### Requirement: Deterministic metadata resolution
The generator SHALL resolve metadata from persisted Markdown frontmatter, deterministic Markdown signals, optional model suggestions, and generic defaults using a deterministic precedence order.

#### Scenario: Multiple metadata sources define the same field
- **WHEN** a field is present in more than one metadata source
- **THEN** the generator MUST prefer user-provided Markdown frontmatter, then deterministic Markdown extraction, then locally schema-valid model suggestions for missing generic non-factual fields, then generic defaults

#### Scenario: Upload form defaults are absent
- **WHEN** generation starts for uploaded Markdown sources
- **THEN** the generator MUST NOT require upload-form default metadata
- **AND** it MUST NOT treat missing upload-form metadata as a generation blocker

#### Scenario: Unknown metadata fields are present
- **WHEN** uploaded metadata includes fields outside the known OKF fields
- **THEN** the generator MUST preserve those fields in the generated concept frontmatter unless they are unsafe to serialize
- **AND** it MUST NOT infer domain-specific meaning from unknown fields

#### Scenario: Non-Markdown upload reaches generation
- **WHEN** a non-`.md` upload is submitted for generation
- **THEN** the generator MUST reject it and MUST NOT parse or convert the file into Markdown

### Requirement: Formal concept validation
The generator SHALL ensure each generated non-reserved Markdown concept file contains parseable YAML frontmatter with non-empty `type` and `title` fields.

#### Scenario: Source has required metadata
- **WHEN** resolved metadata contains non-empty `type` and `title`
- **THEN** the generator MUST produce a concept Markdown file with parseable frontmatter and a Markdown body

#### Scenario: Source lacks title metadata
- **WHEN** persisted source metadata lacks `title`
- **THEN** the generator MUST resolve `title` from the first Markdown H1 heading or the original filename stem before publication
- **AND** it MUST use a locally schema-valid model title suggestion only when no deterministic title exists

#### Scenario: Source lacks type metadata
- **WHEN** persisted source metadata lacks `type`
- **THEN** the generator MUST resolve `type` from a locally schema-valid model type suggestion when available
- **AND** it MUST use the generic default `document` when no safe user or model type exists

#### Scenario: Source frontmatter is malformed
- **WHEN** a source file has malformed YAML frontmatter recorded by ingestion
- **THEN** the generator MUST NOT publish a concept file for that source
- **AND** it MUST report the source-level failure through the upload task detail

### Requirement: OKF-style bundle outputs
The generator SHALL produce the public OKF bundle files required by the product under the active bundle root.

#### Scenario: Bundle generation succeeds
- **WHEN** generation completes for valid sources
- **THEN** the public bundle MUST include `index.md`, `log.md`, `schema.md`, `pages/*.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`
- **AND** it MUST NOT expose internal raw uploaded source files as public `sources/*.md` bundle files

#### Scenario: Reserved and non-reserved Markdown files are generated
- **WHEN** the generator emits `index.md`, `log.md`, `schema.md`, and page concept files
- **THEN** `index.md` and `log.md` MUST follow reserved-file structure without concept frontmatter
- **AND** `schema.md` and page concept files MUST include concept frontmatter

#### Scenario: Root index is generated
- **WHEN** the generator emits root `index.md`
- **THEN** the file MUST contain one or more Markdown heading sections for progressive disclosure
- **AND** each page entry MUST use a standard Markdown link to a generated public page file
- **AND** each page entry MUST include the linked concept title
- **AND** each page entry MUST include the linked concept description when available
- **AND** entries MUST be grouped and sorted deterministically by resolved metadata such as `type`, with a stable fallback group when no group metadata exists

#### Scenario: Root log is generated
- **WHEN** the generator emits root `log.md`
- **THEN** the file MUST start with a Markdown H1 update-log heading
- **AND** it MUST contain date sections in ISO 8601 `YYYY-MM-DD` form, newest first
- **AND** it MUST contain flat Markdown list entries summarizing the generated bundle update
- **AND** it MUST NOT include YAML frontmatter
- **AND** it MUST NOT expose S3 bucket names, `S3_PREFIX`, release IDs, task IDs used in storage keys, raw S3 object keys, local filesystem paths, Redis keys, SQL details, model provider payloads, authorization headers, or secret values

#### Scenario: Root log retention limits are applied
- **WHEN** persisted publication history exceeds the configured `log.md` detailed retention limits
- **THEN** the generated `log.md` MUST include detailed public-safe entries selected newest-first by persisted publication/update time
- **AND** it MUST stop adding detailed entries when the configured maximum entry count or maximum Markdown size is reached
- **AND** older persisted history MUST be represented only by compact summary entries such as monthly counts
- **AND** complete publication history MUST remain in PostgreSQL rather than being copied into `log.md`
- **AND** generation MUST use bounded repository reads or aggregate queries instead of loading all historical release, task, source, or file rows into process memory

#### Scenario: Root log has no recent calendar activity
- **WHEN** a knowledge base has persisted publication history but no updates in the last 30 calendar days
- **THEN** the generated `log.md` MUST still include the newest persisted detailed entries that fit the configured maximum entry count and maximum Markdown size
- **AND** date headings MUST reflect the actual dates of those selected entries
- **AND** calendar age alone MUST NOT cause `log.md` to omit all detailed entries

### Requirement: Markdown links and citations
The generator SHALL use standard Markdown links for relationships, preserve the LLM-assisted relationship graph in generated bundle outputs, and include only deterministic citations when source references are available.

#### Scenario: Related concepts are linked
- **WHEN** generated concepts are related by metadata, content, or model-suggested relationships
- **THEN** generated Markdown MUST express the relationship with standard Markdown links using bundle-relative paths where possible
- **AND** `_index/links.json` MUST include the validated relationship edge

#### Scenario: LLM relationship graph is projected
- **WHEN** optional model assistance returns locally schema-valid `related_links` for generated concepts
- **THEN** the generator MUST filter each relationship edge to existing public bundle paths before publication
- **AND** it MUST write accepted relationship edges into generated Markdown and `_index/links.json`
- **AND** it MUST NOT keep accepted relationship graph output only in process memory

#### Scenario: LLM relationship graph contains invalid targets
- **WHEN** optional model assistance returns relationship edges that target missing files, unsafe paths, internal raw source paths, S3 object keys, or non-public bundle paths
- **THEN** the generator MUST discard those relationship edges before writing Markdown or `_index/links.json`
- **AND** it MUST NOT expose internal storage details in task warnings, generated files, or public indexes

#### Scenario: Source references exist and citations are absent
- **WHEN** a concept has deterministic `resource` metadata or deterministic source citation data and the concept body does not already contain a citations section
- **THEN** the concept body MUST include one `# Citations` section listing those sources without inventing new source facts

#### Scenario: Source body already has citations
- **WHEN** an uploaded Markdown body already contains a `# Citations` section
- **THEN** the generator MUST preserve that section
- **AND** it MUST NOT append a duplicate citations section for the same generated concept

#### Scenario: Source references are absent
- **WHEN** a concept has no deterministic `resource` metadata or source citation data
- **THEN** the generator MUST NOT invent citations from model output or domain assumptions

### Requirement: Index files for agent retrieval
The generator SHALL create static JSON indexes that enable agents to discover files and candidate matches without a server-side search engine.

#### Scenario: Manifest is generated
- **WHEN** bundle generation succeeds
- **THEN** `_index/manifest.json` MUST list every generated public bundle file with path and metadata needed for discovery
- **AND** it MUST include `log.md` as a generated Markdown file
- **AND** it MUST NOT attach concept metadata to `log.md`

#### Scenario: Search index is generated
- **WHEN** bundle generation succeeds
- **THEN** `_index/search.json` MUST include searchable items with path, title, description when available, tags, and keywords
- **AND** it MUST include generated page concepts
- **AND** it MUST NOT include reserved files such as `index.md` or `log.md`

#### Scenario: Link index is generated
- **WHEN** bundle generation succeeds
- **THEN** `_index/links.json` MUST list Markdown link relationships discovered or generated between bundle files
- **AND** it MAY include valid edges from `index.md` or `log.md` to generated public page files
- **AND** every edge target MUST resolve to a generated public bundle path

### Requirement: Optional model assistance uses OpenAI Structured Outputs
The generator SHALL treat model output as optional generic metadata and relationship graph assistance and MUST request it through OpenAI Responses API Structured Outputs with a strict JSON Schema.

#### Scenario: Model configuration is absent
- **WHEN** model environment variables are not configured
- **THEN** generation MUST still produce the deterministic bundle from uploaded content and metadata

#### Scenario: Model configuration is present
- **WHEN** model environment variables are configured
- **THEN** the generator MUST call the OpenAI Responses API using the effective model base URL, `MODEL_API_KEY`, `MODEL_NAME`, `MODEL_CONTEXT_WINDOW_TOKENS`, and `text.format` with type `json_schema`, a schema name, `strict: true`, and the local suggestion JSON Schema

#### Scenario: Model suggestions are generated for multiple sources
- **WHEN** model assistance prepares suggestions for multiple uploaded Markdown sources
- **THEN** the generator MUST limit concurrent model requests with `MODEL_SUGGESTION_CONCURRENCY`
- **AND** it MUST NOT use a hardcoded model request concurrency or unbounded `Promise.all` over all sources

#### Scenario: Structured output schema is defined
- **WHEN** the generator requests model suggestions
- **THEN** the JSON Schema MUST allow only suggestion fields for missing generic non-factual metadata and relationship graph output: `title`, `type`, `description`, `tags`, `related_links`, and `keywords`
- **AND** every object in the schema MUST set `additionalProperties: false`
- **AND** the schema MUST NOT include factual or domain-specific fields such as `resource`, `timestamp`, official identifiers, source URLs, hashes, legal status, or owner fields

#### Scenario: Model suggests relationship graph edges
- **WHEN** model output includes `related_links`
- **THEN** each relationship suggestion MUST be treated as a candidate graph edge between generated public bundle files
- **AND** accepted edges MUST be written to generated Markdown links and `_index/links.json` after validation
- **AND** rejected edges MUST NOT block deterministic generation

#### Scenario: Model output fails once with retryable error
- **WHEN** the first model suggestion attempt returns missing output, malformed JSON, local schema validation failure, a safe retryable provider error, or a retryable receive timeout
- **THEN** the generator MUST make at most one repair attempt for that source
- **AND** the repair attempt MUST include the original output contract, the same bounded Markdown source view, and a sanitized bounded summary of the previous error
- **AND** the repair attempt MUST NOT include secrets, provider authorization headers, unbounded invalid response bodies, or raw storage object keys

#### Scenario: Model output fails twice
- **WHEN** the normal model suggestion attempt and the repair attempt both fail
- **THEN** the generator MUST continue without model suggestions for that source
- **AND** it MUST record a safe warning without exposing credentials or unbounded provider output

#### Scenario: Model response is still making progress
- **WHEN** a model response is actively producing output or receive progress and the hard maximum request timeout has not been reached
- **THEN** the generator MUST continue receiving the response instead of aborting only because the request is slow

#### Scenario: Model response is idle or exceeds hard timeout
- **WHEN** a model response produces no output or receive progress for the configured idle timeout, or reaches the configured hard maximum request timeout
- **THEN** the generator MUST abort the current attempt and treat the failure as retryable only if another attempt remains

#### Scenario: Full Markdown fits the model context window
- **WHEN** a model-assisted source prompt including metadata, candidate links, instructions, response reserve, and the full Markdown body fits within the configured model context window
- **THEN** the generator MUST send the full Markdown body to the model suggestion request

#### Scenario: Full Markdown exceeds the model context window
- **WHEN** a model-assisted source prompt would exceed the configured model context window
- **THEN** the generator MUST send a bounded deterministic source view instead of the full Markdown body
- **AND** that bounded source view MUST include source identity, resolved metadata, a deterministic Markdown heading outline, bounded body excerpts, and truncation metadata

#### Scenario: Related link candidates are selected
- **WHEN** the generator prepares candidate related bundle paths for a source
- **THEN** it MUST preselect a bounded domain-neutral candidate list before the model call
- **AND** candidate selection MUST be based on deterministic source data such as titles, file names, types, tags, and generated public paths
- **AND** candidate selection MUST NOT rely on law-specific rules or graph-database state

#### Scenario: Related link candidate reads are bounded
- **WHEN** candidate related bundle paths are selected from a knowledge base with many source or bundle records
- **THEN** the generator MUST read persisted metadata through bounded database queries, cursors, or batches
- **AND** it MUST NOT build a full in-process corpus list solely to prepare model prompt candidates

#### Scenario: Source files are published for a release
- **WHEN** OKF pages, indexes, S3 objects, database bundle files, or file-tree entries are generated from uploaded Markdown sources
- **THEN** the generator MUST limit per-task source processing work with `UPLOAD_FILE_PROCESSING_CONCURRENCY`
- **AND** it MUST NOT use a hardcoded publication concurrency or unbounded concurrent work over all source records

#### Scenario: Model source body is read
- **WHEN** model assistance needs Markdown body content for a source
- **THEN** the generator MUST read the body from S3-compatible storage with bounded per-source processing
- **AND** it MUST NOT store raw Markdown bodies in PostgreSQL or Redis as a shortcut for prompt construction

#### Scenario: Model suggests fact metadata
- **WHEN** model output includes `resource`, `timestamp`, official identifiers, source URLs, hashes, legal status, owner fields, unknown user metadata, or changes to user-provided metadata fields
- **THEN** the generator MUST ignore those suggestions and preserve the user-provided or deterministically extracted facts

#### Scenario: Structured output cannot be used
- **WHEN** the model returns a refusal, incomplete response, invalid schema output, provider error, or output that does not match the local schema
- **THEN** the generator MUST continue without model suggestions and MUST report a safe warning without exposing credentials

### Requirement: Failed generation does not publish partial bundles
The generator SHALL publish a new bundle only after all output files are produced and validated.

#### Scenario: Generation fails before publication
- **WHEN** generation fails before the active bundle pointer is updated
- **THEN** the public file API MUST continue serving the previously active bundle when one exists

#### Scenario: Generation passes validation
- **WHEN** every generated file and index validates successfully
- **THEN** the system MUST update the active bundle pointer so public URLs resolve to the new bundle

### Requirement: Google OKF conformance gate
The generator SHALL validate generated knowledge bundles against Google OKF conformance rules before publication.

#### Scenario: Non-reserved Markdown file is generated
- **WHEN** the generator emits any `.md` file other than reserved `index.md` or `log.md`
- **THEN** the file MUST be UTF-8 Markdown with a parseable YAML frontmatter block and a non-empty `type` field

#### Scenario: Product required title is generated
- **WHEN** the generator emits any `.md` file other than reserved `index.md` or `log.md`
- **THEN** the file MUST include a non-empty `title` field resolved from Markdown frontmatter, the first Markdown H1 heading, the original filename stem, or a locally schema-valid model suggestion only when no deterministic title exists

#### Scenario: Product required type is generated
- **WHEN** the generator emits any `.md` file other than reserved `index.md` or `log.md`
- **THEN** the file MUST include a non-empty `type` field resolved from Markdown frontmatter, a locally schema-valid model suggestion, or the generic default `document`

#### Scenario: Reserved index file is generated
- **WHEN** the generator emits `index.md`
- **THEN** the file MUST follow OKF reserved index file behavior and MUST NOT be treated as a concept document requiring concept frontmatter
- **AND** it MUST use heading sections and Markdown list entries for progressive disclosure

#### Scenario: Reserved log file is generated
- **WHEN** the generator emits `log.md`
- **THEN** the file MUST follow OKF reserved log file behavior and MUST NOT be treated as a concept document requiring concept frontmatter
- **AND** it MUST use ISO date headings and flat update list entries

#### Scenario: Unknown metadata is present
- **WHEN** uploaded frontmatter contains unknown keys or unknown `type` values
- **THEN** generation MUST preserve unknown frontmatter keys and MUST NOT reject unknown `type` values solely because they are not registered

#### Scenario: Markdown links are generated
- **WHEN** generated concept bodies, `index.md`, or `log.md` link to other bundle concepts
- **THEN** links MUST use standard Markdown link syntax with bundle-relative or relative paths that remain valid within the OKF bundle tree

#### Scenario: Relationship graph index is generated
- **WHEN** generated concept bodies include deterministic or model-suggested related links
- **THEN** `_index/links.json` MUST include the accepted relationship edges between public bundle files
- **AND** those edges MUST match links that can be followed within the generated OKF bundle tree

#### Scenario: Citations are present
- **WHEN** deterministic source references are available for a concept body
- **THEN** the concept MUST include a `# Citations` section without inventing unsupported source facts
- **AND** the generator MUST NOT duplicate an existing citations section

#### Scenario: Model assistance suggests metadata
- **WHEN** optional model assistance suggests metadata for generated OKF files
- **THEN** the generator MUST use only locally schema-valid suggestions for missing generic non-factual fields
- **AND** it MUST NOT use model output to invent factual `resource`, `timestamp`, official identifiers, source URLs, citations, or unknown domain metadata

### Requirement: Knowledge base scoped S3 bundle layout
The system SHALL store uploaded Markdown and generated OKF bundle files under normalized S3 object keys scoped by knowledge base ID.

#### Scenario: Uploaded source is stored
- **WHEN** a valid Markdown source is accepted for a knowledge base upload task
- **THEN** its internal S3 object key MUST be under `S3_PREFIX/knowledge-bases/{knowledgeBaseId}/uploads/{taskId}/sources/`

#### Scenario: Generated release is stored
- **WHEN** a knowledge base release is generated
- **THEN** every generated S3 object key MUST be under `S3_PREFIX/knowledge-bases/{knowledgeBaseId}/releases/{releaseId}/bundle/`

#### Scenario: Generated OKF tree is stored
- **WHEN** generated files are stored under a release bundle root
- **THEN** the paths below `bundle/` MUST keep the public OKF tree shape including `index.md`, `log.md`, `schema.md`, `pages/*.md`, and `_index/*.json`
- **AND** raw uploaded source objects MUST remain under the internal upload path rather than the public release bundle tree

#### Scenario: Storage path is normalized
- **WHEN** the system computes a knowledge base scoped S3 object key
- **THEN** it MUST reject traversal, encoded traversal, backslashes, empty path segments, or values that escape `S3_PREFIX/knowledge-bases/{knowledgeBaseId}/`

### Requirement: Internal storage paths are not public URLs
The system SHALL keep S3 bucket names, `S3_PREFIX`, release IDs, task IDs, raw upload paths, and object keys out of public OpenAPI URLs and responses.

#### Scenario: Public URL is returned
- **WHEN** the Admin API returns a public URL for a generated file
- **THEN** the URL MUST use the public `/kb/{knowledgeBaseId}/...` route shape and MUST NOT include the S3 bucket, `S3_PREFIX`, release ID, task ID, raw upload path, or object key

#### Scenario: Public file read succeeds
- **WHEN** a client reads a public knowledge base file
- **THEN** the API MUST map the public path to a database file record and S3 object key internally without exposing that object key in the response

#### Scenario: Raw uploaded source is requested publicly
- **WHEN** a client requests an internal raw uploaded source path or a public `sources/*.md` path
- **THEN** the public OpenAPI MUST reject the request without exposing internal storage location details

### Requirement: Bounded OKF generation
The generator SHALL create, validate, and publish OKF bundles without unbounded in-process memory or CPU-heavy full-corpus work.

#### Scenario: Source files are read for generation
- **WHEN** a release is generated from uploaded Markdown sources
- **THEN** the generator MUST read source file records and S3 bodies through bounded batches or streams rather than loading the full source corpus into process memory

#### Scenario: Generated bundle metadata is indexed
- **WHEN** the generator creates `manifest.json`, `search.json`, `links.json`, or file tree metadata
- **THEN** it MUST derive those outputs from database records, bounded iterators, or streamed file reads rather than holding the entire generated bundle body set in memory

#### Scenario: Admin file tree entries are published
- **WHEN** a generated release is activated
- **THEN** the system MUST create `bundle_tree_entries` for generated directory and file nodes through bounded database batches
- **AND** file tree entries MUST be scoped by knowledge base ID, release ID, parent directory path, node name, and logical path so the Admin API can page each directory without scanning the full bundle

#### Scenario: Conformance is validated before publication
- **WHEN** generated files are checked against OKF conformance rules
- **THEN** validation MUST iterate over generated file records and S3 bodies with bounded memory and explicit concurrency limits before the release becomes active

### Requirement: Release generation from non-deleted sources
The generator SHALL build active releases only from non-deleted source files.

#### Scenario: Normal upload release is generated
- **WHEN** a release is generated after an upload parsing task
- **THEN** the generator MUST include valid non-deleted source files for that knowledge base
- **AND** it MUST exclude soft-deleted source file records

#### Scenario: Deletion republish release is generated
- **WHEN** a release is generated after a source-backed Markdown document deletion
- **THEN** the generator MUST use the remaining non-deleted source files as the release input set
- **AND** the deleted source file MUST NOT produce a `pages/*.md` file in the new release

### Requirement: Generated page records preserve source mapping
The generator SHALL persist the source file mapping for generated page bundle file records.

#### Scenario: Page file is generated from source
- **WHEN** the generator emits a `pages/*.md` file from an uploaded source file
- **THEN** the persisted bundle file record MUST include the source file identifier that produced it
- **AND** it MUST include a file kind or equivalent classification that marks the file as a source-backed page
- **AND** it MUST persist generated frontmatter and metadata summaries used by admin reads, search indexes, and deletion capability checks

#### Scenario: Reserved or index file is generated
- **WHEN** the generator emits `index.md`, `schema.md`, `_index/manifest.json`, `_index/search.json`, or `_index/links.json`
- **THEN** the persisted bundle file record MUST include a file kind or equivalent classification for that generated system file
- **AND** it MUST NOT be treated as a source-backed deletable page

### Requirement: All derived release outputs are regenerated after source deletion
The generator SHALL treat metadata summaries, JSON index files, and file tree metadata as derived release outputs that are regenerated after source deletion.

#### Scenario: Manifest is regenerated after deletion
- **WHEN** a deletion republish generates a new release
- **THEN** `_index/manifest.json` MUST list the generated files in that new release only
- **AND** it MUST not include the deleted page path

#### Scenario: Search index is regenerated after deletion
- **WHEN** a deletion republish generates a new release
- **THEN** `_index/search.json` MUST be derived from the remaining non-deleted source-backed pages and their generated metadata
- **AND** it MUST not include search items for the deleted page

#### Scenario: Link index is regenerated after deletion
- **WHEN** a deletion republish generates a new release
- **THEN** `_index/links.json` MUST be rebuilt from generated Markdown links in the new release
- **AND** it MUST not include graph edges from or to the deleted page

#### Scenario: Persisted metadata summaries are regenerated after deletion
- **WHEN** a deletion republish writes bundle file records for the new release
- **THEN** `frontmatter_json`, `okf_type`, `title`, `description`, `tags_json`, file kind, content type, checksum, and logical path summaries MUST match the newly generated files

#### Scenario: File tree metadata is regenerated after deletion
- **WHEN** a deletion republish writes file tree entries for the new release
- **THEN** the tree entries MUST be derived from the new release bundle file records
- **AND** the deleted page MUST not appear in any active-release tree page

### Requirement: Relationship graph after deletion
The generator SHALL rebuild relationship graph outputs from the files in the new active release after a source deletion.

#### Scenario: Deleted page had incoming links
- **WHEN** a deleted page was previously targeted by Markdown links or `_index/links.json` edges
- **THEN** the deletion republish output MUST NOT include links that target that deleted page
- **AND** `_index/links.json` MUST list only edges whose `from` and `to` paths exist in the new release

#### Scenario: Deleted page had outgoing links
- **WHEN** a deleted page previously linked to other generated pages
- **THEN** the deletion republish output MUST NOT include those outgoing edges in `_index/links.json`

#### Scenario: Model suggestions reference deleted paths
- **WHEN** optional model assistance suggests related links to a deleted source's previous page path during deletion republish
- **THEN** the generator MUST discard those relationship suggestions before writing generated Markdown or `_index/links.json`

### Requirement: Deletion republish preserves publication safety
The generator SHALL preserve active-release safety when deletion republish fails.

#### Scenario: Deletion republish fails before activation
- **WHEN** deletion republish fails during source reads, model assistance, generation, OKF validation, S3 writes, database writes, or cache invalidation
- **THEN** the previous active release MUST remain available for admin and public reads
- **AND** the deletion task MUST record a safe admin-visible failure without exposing secrets or internal storage object keys

#### Scenario: Deletion republish succeeds
- **WHEN** deletion republish validates and activates a new release
- **THEN** public URLs for the knowledge base MUST resolve to the new active release
- **AND** the old release MUST NOT be mutated in place
