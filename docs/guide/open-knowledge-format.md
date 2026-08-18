---
title: Open Knowledge Format
---

# Open Knowledge Format

Focowiki generates a portable Markdown knowledge base aligned with Google Open Knowledge Format (OKF) 0.2. Uploaded Markdown remains readable even when optional OKF metadata is absent.

## Official Baseline

- [Google Cloud OKF 0.2 announcement](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals)
- [OKF 0.2 specification, pinned revision `930b65fc`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/930b65fc3f5619d5d0591f88c72ebae8b848d60d/okf/SPEC.md)

The product applies three distinct rules:

| Rule | Meaning |
| --- | --- |
| Official OKF 0.2 | Defines recommended provenance, generation, verification, lifecycle, and Attested Computation metadata. |
| Upload safety | Requires a supported path, UTF-8 Markdown, parseable YAML when frontmatter is present, safe values, and an accepted size. |
| Generated knowledge base | Requires complete navigation, valid generated links, portable paths, and bounded index files. |

OKF fields are optional upload inputs. Missing, incomplete, or wrong-format OKF metadata does not by itself block upload, normal file reading, or unfiltered search. Safe original frontmatter remains visible; only successfully normalized values participate in OKF filters.

## Markdown Input

Files can contain plain Markdown or YAML frontmatter followed by Markdown.

```md
---
okf_version: "0.2"
type: "Guide"
title: "Incident response"
description: "Steps for responding to a production incident."
tags:
  - operations
  - reliability
sources:
  - id: "service-handbook"
    resource: "references/service-handbook.md"
generated:
  by: "publisher:docs"
  at: "2026-07-13T00:00:00Z"
verified:
  - by: "human:platform-reviewer"
    at: "2026-07-13T01:00:00Z"
status: "stable"
stale_after: "2026-10-13"
---

# Incident response

Start by confirming the affected service and current impact.
```

Use metadata only when the source provides reliable evidence:

- `sources` records provenance.
- `generated` records a production event.
- `verified` records review events.
- `status` and `stale_after` describe lifecycle.
- Safe domain-specific fields can remain in frontmatter.

Do not invent provenance, verification, ownership, or lifecycle values.

## Decision Signals And Filters

Developer OpenAPI file and search responses include the preserved `frontmatter` and normalized `okfSignals`.

The normalized signals cover status, verification tier, freshness, stale date, generated time, latest verification time, and source count. Invalid supplied values normalize to `null`. Omitted values use documented defaults only where the contract defines a default.

File search accepts optional `okfStatus`, `okfTrustTier`, and `okfFreshness` filters. A filter excludes files whose corresponding normalized signal is `null`. Omit these filters for unrestricted search.

These signals are advisory. They do not grant authorization and do not execute document content.

## Attested Computation

OKF 0.2 can describe an Attested Computation with runtime, parameters, computation content, executor, and attester metadata. Focowiki preserves safe metadata and exposes the Markdown through normal read and search operations.

Focowiki does not execute the described computation and does not treat its metadata as authorization. A referenced local file is discoverable only when that file was also uploaded and is currently readable.

## Generated Structure

The generated knowledge base uses ordinary Markdown navigation plus bounded JSON discovery and relationship records.

```text
index.md
log.md
pages/
  index.md
  index-directory-leaf-<stable-id>.md
  runbooks/
    index.md
    index-directory-leaf-<stable-id>.md
    incident-response.md
_index/
  index.md
  index-extension-leaf-<stable-id>.md
  catalog.json
  pages/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    all-documents.json
    runbooks/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      runbooks-documents.json
  terms/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    han/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      han-terms-part-0001.json
_graph/
  index.md
  index-extension-leaf-<stable-id>.md
  catalog.json
  by-directory/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    runbooks/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      runbooks-relationships.json
  by-file/
    index.md
    index-extension-leaf-<stable-id>.md
    runbooks/
      index.md
      index-extension-leaf-<stable-id>.md
      incident-response.json
```

The tree is illustrative. Every non-empty generated directory has an `index.md` plus bounded stable navigation leaves. Readable document directories use `index-directory-leaf-<stable-id>.md`; machine-readable directories use `index-extension-leaf-<stable-id>.md`. Machine-readable directory routers are named `index.json`. Semantic data files use directory or page names and add `-part-NNNN` only when sharding is required.

Only directories and records that currently have content are included. Relationship branches and per-file graph records exist only for accepted relationships.

| Location | Purpose |
| --- | --- |
| `pages/**` | Complete readable Markdown derived from uploaded documents. |
| `_index/pages/**` | Bounded page and directory discovery records. |
| `_index/terms/**` | Bounded multilingual navigation terms. |
| `_graph/by-directory/**` | Relationships grouped by document directory. |
| `_graph/by-file/**` | Relationships for one readable document. |
| `log.md` | Bounded recent document changes. |

`pages/**` is the final reading and citation evidence. `_index/**` and `_graph/**` help discovery and navigation.

## Reserved Navigation Files

The exact filenames `index.md` and `log.md` are reserved for generated navigation and update history.

The root `index.md` may contain `okf_version: "0.2"` frontmatter. Nested `index.md` files use headings and ordinary relative links. The root `log.md` has no frontmatter.

Large directories use stable `index-<stable-id>.md` continuation pages. Each continuation links to its directory and, when present, the previous and next continuation. A source document appears once in its directory navigation sequence.

Generated Markdown links are relative to the containing file. Generated JSON paths are relative to the knowledge-base root. Copying the complete generated directory to another location therefore preserves internal navigation.

## Portable Public Content

Generated knowledge-base files contain document paths and safe document metadata. They do not contain:

- Product or service names added by the generator.
- Database, queue, job, revision, model, or provider identifiers.
- Service URLs, local filesystem paths, storage locations, object keys, or credentials.

Source-authored content is preserved unless a value is unsafe for the supported format. Source-authored links and citation sections are not renumbered or replaced with inferred citations.

## Updates And Validation

Adding, replacing, renaming, moving, or deleting a document updates the affected navigation, index, relationship, and log files. Unrelated readable documents remain available during the update.

Generated files become readable after their paths, links, navigation, and record shapes pass validation. Optional or malformed OKF metadata remains non-blocking when the Markdown and values are safe. User-authored broken links can remain visible so readers can repair the source material.

For large knowledge bases, directory navigation and JSON resources remain bounded and use continuation or `-part-NNNN` files. The service does not require one Markdown page containing the entire corpus.
