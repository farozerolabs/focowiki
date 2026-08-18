---
title: Source-file Evidence and Document Relationships
---

# Source-file Evidence and Document Relationships

Focowiki keeps uploaded Markdown as the authoritative evidence and builds a lightweight relationship graph between readable documents. Search, embeddings, GraphRAG, and relationship records help find relevant files; an Agent should still read the source Markdown before answering.

This graph connects documents. It is not a separate entity-management graph, and it does not replace the file tree.

## Relationship Sources

Relationships can come from:

- Markdown links written in the source document.
- Safe local references in supported metadata.
- Content-based candidate discovery confirmed during document indexing.

A relationship is published only when both ends resolve to readable documents. A broad tag, common status, generic type, or similar title is not sufficient by itself.

The generated page may contain a `Related` section with ordinary relative Markdown links. Adding, replacing, renaming, moving, or deleting a document updates the affected links and relationship files. Unrelated documents remain available while that work completes.

## Portable Files

Relationship and discovery files use paths that point back to readable Markdown under `pages/`.

```text
index.md
log.md
pages/
  index.md
  index-directory-leaf-<stable-id>.md
  guides/
    index.md
    index-directory-leaf-<stable-id>.md
    install.md
_index/
  index.md
  index-extension-leaf-<stable-id>.md
  catalog.json
  pages/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    all-documents.json
    guides/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      guides-documents.json
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
    guides/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      guides-relationships.json
  by-file/
    index.md
    index-extension-leaf-<stable-id>.md
    guides/
      index.md
      index-extension-leaf-<stable-id>.md
      install.json
```

This is an illustrative tree. `pages/` mirrors the uploaded directory structure. `_index/pages/` and both `_graph/` branches mirror only the applicable `pages/` directories. Every non-empty generated directory has an `index.md` and one or more stable navigation leaves. Human-readable directories use `index-directory-leaf-<stable-id>.md`; `_index/` and `_graph/` directories use `index-extension-leaf-<stable-id>.md`.

Each machine-readable directory uses `index.json` as its router. Document packets use semantic names such as `all-documents.json` or `<directory>-documents.json`; relationship packets use `<directory>-relationships.json`. Additional shards append `-part-NNNN`. A per-file graph record mirrors the readable page path without the `pages/` prefix or `.md` suffix, for example `pages/guides/install.md` becomes `_graph/by-file/guides/install.json`.

Only directories and data that currently exist are generated. Term bucket directories are created only for populated writing systems. `_graph/by-directory/`, `_graph/by-file/`, and their navigation leaves are omitted when no accepted relationship requires them. A document without accepted relationships has no per-file graph JSON.

| Resource | Purpose |
| --- | --- |
| `pages/**/*.md` | Complete readable documents and final citation evidence. |
| `_index/pages/**` | Bounded directory and document discovery records. |
| `_index/terms/**` | Bounded language-aware navigation terms. This is not a complete full-text index. |
| `_graph/by-directory/**` | Relationships grouped by readable document directory. |
| `_graph/by-file/**` | A bounded neighborhood for one readable document. |
| `index-*-leaf-<stable-id>.md` | Bounded Markdown navigation pages linked from the `index.md` in the same directory. |

Generated JSON uses bundle-root-relative document paths. Generated Markdown uses relative links. The portable files do not expose database IDs, model names, service URLs, storage keys, or processing identifiers.

## Relationship Fields

Relationship records use public document fields:

| Field | Meaning |
| --- | --- |
| `path`, `from`, `to`, `targetPath` | Current readable `pages/*.md` paths. |
| `title`, `fromTitle`, `toTitle`, `targetTitle` | Titles of the linked documents. |
| `relationType` | `references` for directional source evidence or `related` for an accepted association. |
| `direction` | `outgoing` or `incoming` relative to the current document. |
| `weight` | Bounded relationship priority from `0` to `1`. |
| `reason` | A safe explanation of why the documents are connected. |

## Online Agent Flow

For an Agent connected through Developer OpenAPI:

1. Send the complete user question to file search. Omit `mode` to use `hybrid`.
2. Treat returned items as candidates.
3. Follow a returned read action and read the full Markdown file.
4. If evidence is incomplete, call the related-file endpoint or graph expansion with the returned `fileId`.
5. Read the returned related Markdown files before using them as evidence.
6. Stop when the files cover the question or no new useful candidate remains.

Graph expansion requires one current readable `fileId`. It does not accept a free-text query, node ID, or edge ID as its starting value.

Search modes have these public meanings:

| Mode | Use |
| --- | --- |
| `hybrid` | Recommended default that combines eligible file and relationship discovery. |
| `file` | Focus discovery on file content, titles, paths, metadata, and content embeddings. |
| `graph` | Focus discovery on document relationships and graph-derived signals. |

Search results, excerpts, scores, relationship summaries, and reranker output are navigation aids. Read the returned Markdown before presenting a factual answer.

## Static Bundle Flow

When only a copied bundle or static HTTP host is available:

1. Start at `index.md`.
2. Browse `pages/` through its directory indexes.
3. Use `_index/catalog.json` and declared page or term routes only when additional discovery is needed.
4. Follow ordinary Markdown links or the matching `_graph/by-file/**` record.
5. Read the target `pages/*.md` files and cite those files.

The term index is intentionally bounded. Use Developer OpenAPI search for online full-text and hybrid retrieval.

## Document Availability

Each uploaded document is indexed independently. One document can become available while other files from the same upload are still processing.

Use the document `state` as the public lifecycle:

- `waiting`: accepted and waiting to start.
- `processing`: indexing is in progress.
- `available`: the current document is readable and searchable.
- `error`: processing ended with a safe error and may expose an allowed retry action.
- `deleting`: deletion is in progress.

When a replacement fails, `generatedOutputStatus=previous_available` can keep the earlier readable content available. A failed first upload is not returned by tree, content, relationship, or search reads.

Large imports should begin with the documented defaults. Increase concurrency only after observing the Admin processing view, external model latency, search latency, CPU, and memory.
