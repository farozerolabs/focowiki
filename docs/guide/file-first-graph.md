---
title: File-first Graph
---

# File-first Graph

Focowiki builds a lightweight relationship graph for generated Markdown pages. The graph is stored in PostgreSQL for consistency, coordinated with Redis during processing, and published as files in the OKF bundle. Agents can explore relationships by reading files through the same tree and content APIs used for normal Markdown pages.

The graph feature keeps the product file-first. It adds stable relationship files to the bundle and keeps graph state available for deletion, retry, and republish workflows.

## Why It Exists

Large knowledge bases need stable cross-file relationships. A model prompt can inspect one file and a bounded set of candidates, but it cannot compare a file with every document in a corpus containing thousands or tens of thousands of files.

Focowiki handles this by separating relationship work into two layers:

| Layer | Purpose |
| --- | --- |
| Content profile | Build one generic profile from each Markdown body, including summary, subjects, keywords, entities, explicit references, heading outline, and safe frontmatter context. |
| Deterministic candidates | Use bounded database reads and content evidence such as Markdown links, title mentions, shared entities, shared subjects, explicit references, and existing reciprocal relationships. |
| Optional model confirmation | Send only the current file profile, bounded source view, and selected candidate cards to the configured model. The model can confirm, reject, classify, weight, and explain provided candidates. |

The model cannot invent target files. If model confirmation rejects a candidate, that candidate is not published as an accepted relationship. If model confirmation fails, deterministic relationships can still be published when they have strong content evidence.

Generic metadata such as one shared status, one broad type, one low-information tag, or a generated system heading does not create a page `Related` link by itself. Metadata can support a relationship when the body profile already shows content evidence.

## Generated Files

Graph files live under `_graph/` in the generated bundle.

```text
_graph/
  index.md
  manifest.json
  nodes.jsonl
  nodes/
    0000.jsonl
  edges/
    0000.jsonl
  by-file/
    {fileId}.json
```

| File | Purpose |
| --- | --- |
| `_graph/index.md` | Human and Agent entry point for graph navigation. |
| `_graph/manifest.json` | Counts, path patterns, generation time, and graph metadata. |
| `_graph/nodes.jsonl` | Node index entry. Small knowledge bases store node records here; large knowledge bases store shard descriptors here. |
| `_graph/nodes/*.jsonl` | Sharded node records for large generated knowledge bases. |
| `_graph/edges/*.jsonl` | Sharded relationship records. These are useful for exports and audits. |
| `_graph/by-file/{fileId}.json` | Bounded local neighborhood for one generated source-backed page. This is the primary Agent exploration file. |

Normal Agent reading should start from generated Markdown pages and then use `_graph/by-file/{fileId}.json`. Agents rarely need to read full edge shards.

## Page References

Source-backed pages include stable graph references in frontmatter when graph data exists.

```yaml
fileId: "source-file-123"
graph: "../_graph/by-file/source-file-123.json"
```

The generated page body can also include a `Related` section derived from persisted graph edges. The same graph edges drive `_index/links.json`, so relationship data stays consistent across Markdown pages, JSON indexes, and per-file graph files.

## Relationship Fields

Each relationship record contains safe public fields.

| Field | Meaning |
| --- | --- |
| `fileId` | Related source-backed file identifier. |
| `path` | Related generated Markdown path, such as `pages/example.md`. |
| `title` | Related file title. |
| `relationType` | Relationship type, such as `explicit_reference`, `title_mention`, `shared_entity`, `shared_subject`, `metadata_supported_content`, or `model_related_link`. |
| `direction` | `outgoing` when the current file points to the related file, `incoming` when another file points to the current file. |
| `weight` | Bounded priority score from `0` to `1`. |
| `reason` | Safe explanation for users, developers, and Agents. |
| `source` | Relationship source, such as `deterministic` or `model_confirmed`. |
| `contentAvailable` | Whether generated Markdown content is available through the file read API. |

Graph files expose logical identifiers and paths. They do not expose S3 object keys, local filesystem paths, Redis keys, SQL details, provider payloads, or secrets.

## Agent Exploration Flow

1. Read `index.md` to understand the knowledge base.
2. Read `schema.md` when metadata or generated file conventions are unclear.
3. List the generated file tree with pagination.
4. Open a relevant `pages/*.md` file.
5. Read the page frontmatter and find `fileId` and `graph`.
6. Open `_graph/by-file/{fileId}.json`.
7. Read related page paths returned by the graph file.
8. Continue following Markdown links and graph relationships while the task needs more evidence.

Developer OpenAPI also exposes a bounded related-file endpoint for backend integrations that prefer JSON lists. File reads remain the primary Agent-facing contract.

Admin previews copy a Developer OpenAPI content URL for the selected generated file. Safe Unicode page paths such as `pages/示例.md` are encoded in the copied URL and resolved back to the active generated file by the Developer OpenAPI.

## Operational Notes

PostgreSQL stores graph nodes, graph edges, and graph job records. Redis coordinates locks, cursors, and processing state. S3-compatible storage stores the generated `_graph/` files with the rest of the OKF bundle.

Processing is file-level. A graph failure for one source file does not require unrelated files to stop processing. Failed files can be retried manually through the same source-file retry flow.

The first implementation does not add embeddings, vector search, rerankers, a graph database, or a graph visualization UI. Search and vector systems can still be added by developers as separate access layers on top of the generated bundle.
