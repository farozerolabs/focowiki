## MODIFIED Requirements

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
