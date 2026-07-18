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

The root `index.md` links to `_graph/index.md` whenever graph output is available. Normal Agent reading should start from generated Markdown pages and then use `_graph/by-file/{fileId}.json`. Agents rarely need to read full edge shards.

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
| `relationType` | Relationship type, such as `direct_reference`, `direct_reference`, `same_entity`, `same_specific_subject`, `metadata_supported_content`, or `same_specific_subject`. |
| `direction` | `outgoing` when the current file points to the related file, `incoming` when another file points to the current file. |
| `weight` | Bounded priority score from `0` to `1`. |
| `reason` | Safe explanation for users, developers, and Agents. |
| `source` | Relationship source, such as `deterministic` or `model_confirmed`. |
| `contentAvailable` | Whether generated Markdown content is available through the file read API. |

Graph files expose logical identifiers and paths. They do not expose S3 object keys, local filesystem paths, Redis keys, SQL details, provider payloads, or secrets.

## Agent Exploration Flow

1. Read `index.md` to understand the knowledge base.
2. Follow the graph entry in `index.md` when relationship discovery is useful.
3. Read `schema.md` when metadata or generated file conventions are unclear.
4. Inspect `_index/*` when the task needs generated search, link, manifest, or tree hints.
5. List the generated file tree with pagination.
6. Open relevant `pages/*.md` files and read complete Markdown content.
7. Read the page frontmatter and find `fileId`, `path`, and `graph`.
8. Open `_graph/by-file/{fileId}.json`, call the related-file endpoint, or use Developer OpenAPI graph expansion with the known file ID.
9. Read related page paths returned by graph expansion or graph files.
10. Continue following Markdown links, tree entries, `_index/*`, search candidates, and graph relationships while the task needs more evidence.

Developer OpenAPI also exposes a bounded related-file endpoint for backend integrations that prefer JSON lists. File reads remain the primary Agent-facing contract.

Admin previews copy a Developer OpenAPI content URL for the selected generated file. Safe Unicode page paths such as `pages/示例.md` are encoded in the copied URL and resolved back to the active generated file by the Developer OpenAPI.

## Graph Search

Developer OpenAPI file search uses generated file discovery by default. `mode=file` searches generated file documents and preserves the existing file-search contract. `mode=hybrid` combines file and graph candidates into one deduplicated file-level result list. `mode=graph` searches persisted graph node and relationship search documents.

Graph search reads the same active relationship projection that generates `_graph/` files and `Related` sections. It does not parse graph files during the request. This keeps large knowledge-base queries bounded and lets ingestion, deletion, and publication update graph reads through one active generation.

Each graph result can include `matchType`, `graphContext.graphRef`, `graphContext.relationships`, `graphContext.graphPaths`, and result-level `readActions`. Use graph fields as navigation hints, then follow `readActions` to read the generated Markdown file by ID or path. The generated Markdown file content remains the evidence source that should be read before producing an answer.

Graph expansion accepts a file, node, edge, or query seed and returns bounded relationship paths with file read actions. Use it after an Agent has a promising file or graph candidate, then continue the same loop by reading the returned Markdown files. Search and graph expansion are discovery tools. Complete Markdown files remain the evidence that supports the final answer.

## Operational Notes

PostgreSQL stores relationship facts, projection impacts, active graph nodes, and active graph edges. Redis coordinates scoped locks, cursors, and short-lived graph caches. S3-compatible storage keeps generated `_graph/` Markdown and machine shards as immutable objects referenced by the active generation.

Processing is file-level. A graph failure for one source file does not require unrelated files to stop processing. Failed files can be retried manually through the same source-file retry flow.

The first implementation does not add embeddings, vector search, rerankers, a graph database, or a graph visualization UI. Search and vector systems can still be added by developers as separate access layers on top of the generated bundle.
