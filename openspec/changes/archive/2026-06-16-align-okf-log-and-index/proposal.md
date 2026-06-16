## Why

Current generated bundles pass the core OKF conformance gate, but they do not emit the optional reserved `log.md` file and the root `index.md` is still a minimal page list. Google OKF v0.1 defines `log.md` as an optional reserved update-history file and recommends `index.md` entries grouped under headings with descriptions for progressive disclosure, so adding both will make Focowiki's generated bundle closer to the reference OKF shape while keeping the product lightweight.

## What Changes

- Generate a root `log.md` file for every published bundle.
- Keep `log.md` reserved: it must not have concept frontmatter, must not appear in `_index/search.json`, and must not be treated as a page concept.
- Populate `log.md` from persisted database release/task/source metadata, newest first, without exposing task IDs, release IDs, S3 object keys, bucket names, storage prefixes, local paths, provider payloads, secrets, or raw SQL details.
- Generate `log.md` as a bounded rolling public summary, not an infinite append-only audit file:
  - default detailed window is the newest 100 public update entries by update time;
  - detailed entries are capped by configured maximum entry count and maximum Markdown size;
  - calendar age alone MUST NOT make `log.md` drop all detailed entries when a knowledge base has no recent activity;
  - older persisted history is summarized into compact monthly sections;
  - complete history remains in PostgreSQL, while `log.md` remains a generated public view.
- Optimize root `index.md` to follow OKF progressive-disclosure guidance more closely:
  - no frontmatter;
  - one or more headings;
  - Markdown list entries using bundle-relative links;
  - each page entry includes the concept title and a short description when available;
  - entries are grouped by stable metadata such as `type` when available, with a deterministic fallback group.
- Include `log.md` in `_index/manifest.json`, bundle tree records, S3 release objects, Admin file tree/detail reads, and public OpenAPI scoped reads.
- Keep `_index/search.json` focused on page concepts only.
- Keep `_index/links.json` focused on Markdown link edges, including valid links that originate from `index.md` and `log.md`.
- Preserve the current minimal architecture: use PostgreSQL as the durable source, S3 as generated file storage, Redis only for bounded coordination/cache where useful, and bounded reads/queries instead of process-memory catalogs.
- **BREAKING**: The public generated bundle shape changes by adding `log.md` and by changing `index.md` body formatting before public release.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `okf-bundle-generation`: Generated bundles must include OKF reserved `log.md` and an OKF-aligned progressive-disclosure `index.md`.
- `public-file-api`: Public scoped reads must support `log.md` as a generated Markdown file while preserving path safety and storage-detail hiding.

## Impact

- `packages/okf` generator, indexes, conformance tests, fixtures, and bundle tree behavior.
- `apps/api/src/okf/publication.ts` runtime publication, bundle persistence, tree entries, manifest generation, and public path registration.
- Admin UI file tree/detail reads only insofar as `log.md` appears as a generated read-only bundle file.
- Public OpenAPI scoped file reads and path allowlist for `/kb/{knowledgeBaseId}/log.md`.
- Validation scripts and real cleaned legal Markdown flow checks for `index.md`, `log.md`, `_index/manifest.json`, `_index/search.json`, and `_index/links.json`.
- Documentation describing generated bundle layout and public file endpoints.
