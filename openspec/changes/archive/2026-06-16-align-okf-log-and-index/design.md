## Context

Google OKF v0.1 describes a bundle as a directory tree of Markdown files with YAML frontmatter for non-reserved concept documents. It reserves `index.md` for directory listings and `log.md` for optional update history. The current Focowiki bundle already generates `index.md`, `schema.md`, `pages/*.md`, and `_index/*.json`, and it validates non-reserved Markdown against required frontmatter `type` and product-required `title`.

The current gaps are shape-level alignment rather than a new data model:

- `log.md` is not generated.
- `index.md` is a minimal list of page links without descriptions.
- `log.md` growth behavior is not defined, so a frequently updated knowledge base could produce an oversized generated history file if implementation simply appends every event.
- Public OpenAPI path safety does not currently allow `log.md`.
- JSON indexes and validation scripts need to understand `log.md` as a reserved Markdown file, not a concept page.

The product is not released yet, so this can be a breaking generated-bundle update. The implementation should remain lightweight, modular, and bounded. PostgreSQL remains the durable source of release/task/source facts, S3-compatible storage remains the generated file store, and Redis remains optional coordination/cache infrastructure. The API process must not become the source of truth for release history or generated indexes.

## Goals / Non-Goals

**Goals:**

- Generate root `log.md` for each active bundle.
- Keep `log.md` OKF-reserved: no frontmatter, update-history body shape, excluded from page concept search items.
- Format `log.md` as newest-first ISO date sections with flat Markdown list entries.
- Keep `log.md` bounded through a rolling newest-entry detailed window, maximum Markdown size, and compact older-history summaries.
- Generate a more OKF-aligned root `index.md`:
  - no frontmatter;
  - headings for progressive disclosure;
  - page entries with standard Markdown links;
  - descriptions from page frontmatter when available;
  - deterministic grouping, preferably by `type`.
- Include `log.md` in S3 bundle output, database bundle file records, bundle tree entries, `_index/manifest.json`, Admin file tree/detail reads, and Public OpenAPI reads.
- Preserve existing `_index/search.json` behavior for page concepts while excluding reserved files.
- Keep `_index/links.json` as a link-edge index and include valid edges from `index.md` and `log.md` when those files contain bundle links.
- Update validation to inspect real generated `index.md`, `log.md`, `manifest.json`, `search.json`, and `links.json` using real cleaned legal Markdown uploads.

**Non-Goals:**

- Do not implement a full git-style release history system.
- Do not use `log.md` as the complete audit log or durable source of historical truth.
- Do not expose internal task IDs, release IDs, S3 object keys, bucket names, storage prefixes, local paths, raw SQL, provider payloads, or secrets in `log.md`.
- Do not add a new database schema unless implementation proves existing task/release/source records cannot support the required summary.
- Do not make `_index/*.json` part of the Google OKF standard claim; they remain Focowiki retrieval extensions.
- Do not add heavy graph databases, background queues, or full-corpus in-memory catalogs for this change.

## Decisions

### 1. Generate `log.md` from persisted release/task/source summaries

`log.md` should be generated during release publication from PostgreSQL records already created by the upload/deletion lifecycle. It should summarize the current publication event and, where bounded data is available, recent prior events for the knowledge base.

`log.md` must be regenerated from durable database state on each release. It should not read the previous `log.md` body and append text, because that creates unbounded generated files and makes the Markdown file a second source of truth.

Recommended shape:

```md
# Directory Update Log

## 2026-06-16

* **Update**: Published 5 Markdown pages for this knowledge base.
* **Creation**: Added [Document title](/pages/document.md).

## Older Updates

* 2026-05: 18 publication events, 420 documents changed.
```

Rationale: OKF defines `log.md` as a chronological history file, not a machine API. The safest first version is a concise generated Markdown history that helps humans and agents understand bundle changes without leaking infrastructure details.

Alternative considered: generate `log.md` from every task event and phase detail. This is rejected because phase details are admin-internal, can become noisy, and are not part of the public knowledge bundle contract.

### 2. Bound `log.md` with a rolling public entry window

The first implementation should use conservative runtime configuration with these defaults:

- `OKF_LOG_MAX_ENTRIES=100`
- `OKF_LOG_MAX_BYTES=65536`

Detailed entries should be selected newest-first by persisted publication/update time until the configured entry or byte limit is reached. Date headings should group the selected entries by their actual dates, but calendar age is not a hard cutoff. If a knowledge base has no updates in the last 30 calendar days, `log.md` should still include the latest persisted update entries when they fit the configured entry and byte limits.

If detailed entries exceed the entry or byte limit, generation should stop adding detailed entries and summarize the remaining older database records by month. Older data must remain in PostgreSQL; it should not be copied into `log.md` as full detail.

Redis may be used for bounded cursor/cache coordination if the existing repository path needs it, but PostgreSQL remains the durable source. The renderer must request bounded slices or aggregate summaries from repository methods rather than loading all release, task, source, or file rows into process memory.

Rationale: frequently updated knowledge bases can produce large histories, while low-frequency knowledge bases may have no events in a recent calendar window. A newest-entry rolling window preserves useful recent update context for users and agents without making `log.md` empty solely because no update happened in the last 30 days.

Alternative considered: keep every historical detail in `log.md`. This is rejected because the generated file can grow without bound, slow down agents, and create avoidable memory pressure during generation and reads.

Alternative considered: use a hard 30-day retention cutoff. This is rejected because a quiet knowledge base could produce an empty or near-empty update log even when older useful update entries exist.

### 3. Keep `log.md` reserved and read-only

`log.md` should be stored and served like `index.md`: generated by the system, read-only in Admin UI, publicly readable through `/kb/{knowledgeBaseId}/log.md`, and not treated as a concept requiring frontmatter.

Rationale: OKF reserves `log.md` and conformance treats it differently from concept documents. Adding frontmatter or search entries would make it behave like product content rather than an update-history file.

Alternative considered: make `log.md` a normal concept with `type: log`. This is rejected because it conflicts with OKF reserved filename semantics.

### 4. Group `index.md` entries by concept `type`

The root `index.md` should group generated pages by resolved frontmatter `type` when available, sorted deterministically by group label and title. Each entry should include the title link and description when available.

Example:

```md
# Knowledge base name

Generated at: 2026-06-16T00:00:00.000Z

## 地方性法规

* [遵义市地方立法条例](/pages/遵义市地方立法条例.md) - 遵义市地方立法条例

## Documents

* [Untyped source](/pages/untyped-source.md)
```

Rationale: OKF recommends index sections and descriptions for progressive disclosure. Grouping by `type` is domain-neutral and uses existing metadata. It also keeps the first screen useful for agents without requiring a server-side query.

Alternative considered: preserve a single `## Pages` list. This is simpler but does not fully follow the OKF index guidance the user asked to align with.

### 5. Keep JSON indexes as Focowiki retrieval extensions

`_index/manifest.json` must include `log.md`. `_index/search.json` must not include `log.md`; it should continue to contain searchable concept pages only. `_index/links.json` may include edges from `index.md` and `log.md` if those files contain standard Markdown links to generated public files.

Rationale: Google OKF standardizes Markdown tree semantics, not Focowiki's JSON index files. Keeping JSON files as retrieval extensions avoids overstating standards alignment while still supporting agents.

Alternative considered: add `log.md` to search. This is rejected because search should return knowledge concepts, not generated navigation/history files.

### 6. Preserve bounded generation and module boundaries

Implementation should add small helpers rather than expanding one large publication file:

- package-level reserved file rendering helpers;
- API publication log/index rendering helpers;
- typed runtime configuration for log entry and size limits;
- bounded repository methods for recent public update summaries and older monthly aggregates;
- existing bundle file/tree persistence paths;
- public path safety allowlist changes;
- validation assertions.

Any release/task/source data used for `log.md` must come from bounded repository methods or already bounded publication inputs. Avoid reading every historical row into memory. Use current publish data, a bounded recent-history query, and aggregate monthly summaries for older rows.

Rationale: The project explicitly prioritizes a lightweight, understandable architecture and database/Redis/S3-backed processing over process memory.

Alternative considered: build a full in-memory release timeline during generation. This is rejected because it does not scale and duplicates durable database state.

## Risks / Trade-offs

- [Risk] `log.md` could accidentally leak internal IDs or storage paths. → Mitigation: generate prose from sanitized titles, counts, operation labels, dates, and public bundle links only; add tests and validation scans for forbidden fields.
- [Risk] `log.md` could grow without bound for frequently updated knowledge bases. → Mitigation: regenerate it from database state with a default newest-100-entry detailed window, maximum byte size, and older monthly summaries.
- [Risk] `index.md` can become large for big knowledge bases. → Mitigation: generate from the bounded active release publication flow and keep entries concise; future pagination/index splitting can be proposed if large bundles require it.
- [Risk] Grouping by `type` may produce many sections for noisy metadata. → Mitigation: sort deterministically, omit empty group labels, and use a generic fallback group.
- [Risk] `log.md` could become empty for low-frequency knowledge bases if retention is interpreted as a hard calendar window. → Mitigation: use newest-entry rolling selection, with dates only for grouping and monthly summaries.
- [Risk] Links in `log.md` may reference deleted pages after republish. → Mitigation: only link to files in the current active bundle and ensure deletion validation checks `log.md` for stale references.
- [Risk] Focowiki JSON indexes may be confused with Google OKF standard files. → Mitigation: documentation and specs should state they are product retrieval extensions.

## Migration Plan

1. Update tests to expect `log.md`, rolling entry limits, older summaries, and the revised `index.md` body.
2. Add typed runtime configuration for `log.md` entry and size defaults and validation.
3. Implement package generator changes.
4. Implement runtime API publication changes and public path allowlist updates.
5. Update docs and validation scripts.
6. Run package/API/public/browser/real-cleaned-legal validation.

Because the product has not been publicly released, existing generated bundles can be replaced by republishing knowledge bases. No backward-compatible migration is required.

## Open Questions

None. Recommended first version: generate `log.md` from sanitized current publication facts, a default newest-100-entry rolling detailed window, maximum byte limit, and compact older monthly summaries; optimize `index.md` by grouping page links by `type` with descriptions.
