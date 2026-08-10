---
title: Open Knowledge Format
---

# Open Knowledge Format

Focowiki generates a Markdown knowledge base aligned with Google Open Knowledge Format (OKF) 0.2. The format keeps knowledge portable and readable through Markdown files, optional YAML frontmatter, standard links, directory indexes, and update logs.

## Official Baseline

Focowiki pins one retrieved specification revision so upstream edits cannot silently change validation behavior.

- [Google Cloud OKF 0.2 announcement](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals)
- [OKF 0.2 specification, pinned revision `930b65fc`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/930b65fc3f5619d5d0591f88c72ebae8b848d60d/okf/SPEC.md)

The implementation distinguishes official rules from Focowiki producer rules.

| Classification | Behavior |
| --- | --- |
| Official OKF 0.2 | Describes portable provenance, generation, verification, lifecycle, and Attested Computation metadata. These fields are recommendations for uploaded files. |
| Product safety | Uploaded files must remain safe Markdown with supported paths, valid YAML when frontmatter is present, safe serializable values, and accepted resource sizes. |
| Focowiki producer | Generated links resolve, labels agree with target concepts, navigation remains complete, and large directories use bounded continuation concepts. |

Missing, incomplete, or malformed OKF fields do not by themselves block upload, publication, unfiltered search, or file reads. Focowiki preserves safe raw frontmatter, uses only valid normalized values for derived signals and filters, and does not impose a domain taxonomy.

## Concept Files

Uploads may contain plain UTF-8 Markdown or Markdown with YAML frontmatter. All OKF 0.2 fields in this example are optional product inputs; adding them improves interoperability and decision support when the source provides reliable evidence.

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

`sources` records provenance, `generated` records the producer event, `verified` records review events, and `status` plus `stale_after` describe lifecycle. Legacy `timestamp` remains readable as a distinguishable generated-time fallback. Safe unknown fields remain available as producer metadata.

## Decision Signals And Search Filters

Developer OpenAPI file metadata and search results return the preserved raw `frontmatter` plus an `okfSignals` object. It contains nullable normalized values for effective status, verification tier, staleness, stale date, generated time and its source, latest verification time, and source count.

An omitted `status` has the effective value `stable`; an invalid supplied status produces `null`. Omitted verification has the tier `unverified`; malformed supplied verification produces `null`. Freshness is `null` without a valid `stale_after`, and malformed supplied sources produce a `null` source count. These signals are advisory and do not grant authorization or execute content.

The existing file-search operation accepts optional `okfStatus`, `okfTrustTier`, and `okfFreshness` filters. A filter excludes files whose corresponding normalized signal is `null`. The same files remain available through direct reads and unfiltered search.

## Attested Computation

OKF 0.2 can describe an `Attested Computation` with a runtime, parameters, inline or referenced computation content, an executor, and an attester. Focowiki preserves complete and incomplete safe metadata and exposes the Markdown through the same tree, file, content, search, graph, and related-file operations. It does not execute the computation or treat the metadata as proof of authorization.

Safe local references are discoverable only when the referenced file was uploaded and published as a supported knowledge-base file. A reference to an excluded runtime asset can remain in frontmatter without being advertised as a readable Focowiki file.

## Reserved Files

The exact filenames `index.md` and `log.md` are reserved.

The root `index.md` may declare only `okf_version: "0.2"` in frontmatter. Nested `index.md` files contain no frontmatter. Both use headings and standard Markdown links.

```md
---
okf_version: "0.2"
---
# Product knowledge

## Explore

- [Browse documents](/pages/index.md) - 3 top-level entries.
- [Relationship graph](/_graph/index.md) - 12 accepted relationships.
- [Metadata schema](/schema.md)
- [Update history](/log.md)
- [Machine-readable indexes](/_index/index.md)
```

A nested directory index keeps the same direct form without frontmatter:

```md
# Runbooks

[Parent directory](/pages/index.md)

[Knowledge base](/index.md) · [Documents](/pages/index.md) · [Machine-readable indexes](/_index/index.md) · [Relationship graph](/_graph/index.md)

[Browse entries](/pages/runbooks/index-<stable-id>.md)
```

The root `log.md` contains no frontmatter. It starts with `# Directory Update Log`, includes the active publication date when available, and contains one bounded publication summary.

```md
# Directory Update Log

## 2026-07-13

* **Publication**: Published 12 Markdown files created from uploaded sources.
```

## Links And Sources

Focowiki-generated internal links use bundle-relative paths beginning with `/`. A generated relationship must resolve to a Markdown file created from an uploaded source or to a typed navigation concept that leads to source-file evidence.

Focowiki does not synthesize numbered `# Citations` sections. Structured `sources` are emitted only from explicit evidence. Source-authored links, footnotes, and citation sections remain unchanged instead of being restyled, renumbered, or inferred from unrelated fields.

## Generated Structure

```text
index.md
log.md
schema.md
pages/
  index.md
  runbooks/
    index.md
    incident-response.md
  large-directory/
    index.md
    index-<stable-id>.md
_index/
  index.md
  catalog.json
  search/
    index.md
    v1/
      index.md
      index-<stable-id>.md
      0000.json
  manifest/, links/, tree/
    ...
_graph/
  index.md
  graph_node/, graph_edge/
    ...
  by-file/
    index.md
    index-<stable-id>.md
    <source-file-id>.json
```

Concepts under `pages/` that come from uploaded files remain the final reading and citation evidence. `schema.md`, directory continuation pages, `_index/`, and `_graph/` are Focowiki producer extensions. The active publication format keeps the update summary in the exact root `log.md` file and does not emit numbered history pages.

Generated Markdown concepts outside exact `index.md` and `log.md` use normal concept frontmatter and a descriptive `type`, such as `Schema Reference` or `Directory Index Page`. Exact directory indexes, including `_index/index.md` and `_graph/index.md`, remain reserved navigation files and contain no frontmatter.

## Large Directories And Update Log

An exact directory `index.md` remains bounded. When a direct listing exceeds the configured entry or byte budget, it links to stable `index-<stable-id>.md` continuation concepts. Each continuation exposes directory, previous, and next navigation and lists a deterministic range of direct entries. Focowiki does not create artificial domain folders or omit source concepts. Each concept created from an uploaded file appears exactly once in its directory navigation sequence.

Root, document-directory, machine-index, and graph navigation pages link back to the same bounded global destinations. Typed projection JSON and per-file relationship JSON are discoverable through their extension directory chains. A per-file relationship entry also links to its current source Markdown evidence page; `_index/catalog.json` remains bounded and does not enumerate every per-file resource.

The root `log.md` contains the bounded summary for the active publication. The current publication format does not generate `log-000001.md` or other numbered history pages.

## Publication Validation

A candidate generation becomes readable after concept, reserved-file, generated-link, continuation-chain, source-navigation, shard-schema, and deletion-absence checks pass. Validation returns bounded rule IDs and logical paths when generated output is invalid.

Missing or malformed OKF fields, unknown types, unknown safe fields, missing optional user indexes, source-authored references to excluded assets, and source-authored broken links remain readable. Focowiki applies strict ownership and link checks to Focowiki-generated artifacts while reporting user-authored conformance gaps as non-blocking guidance.

Admin preview and Developer OpenAPI expose the same logical paths and generated Markdown content. Generated files do not contain Admin URLs, storage paths, queue state, credentials, or internal identifiers used only by the service.

## Scale Profile

Directory navigation and generation validation use bounded pages, continuation concepts, and generation-scoped durable facts. A large knowledge base does not require one corpus-wide Markdown index or loading all source bodies into one process.

The validation suite covers flat and nested 100,000-concept structures. It verifies bounded Markdown files, complete navigation, deterministic link coverage, and stable resource use.
