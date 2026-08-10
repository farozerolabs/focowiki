---
title: Source-file Evidence and Graph Relationships
---

# Source-file Evidence and Graph Relationships

Focowiki builds a lightweight relationship graph for generated Markdown pages and, when a knowledge base has an active semantic contract, maintains vector and GraphRAG semantic projections. The graph is stored in PostgreSQL for consistency, coordinated with Redis during processing, and published as files in the OKF bundle. Agents can explore relationships by reading files through the same tree and content APIs used for normal Markdown pages.

“Source-file evidence” means that source Markdown remains authoritative: search, vectors, and graph relationships discover candidates, and an Agent still reads the source file before answering. It does not define search-lane priority. When Developer OpenAPI omits `mode`, the default `hybrid` plan runs all eligible file, lexical, vector, and graph lanes concurrently and fuses them into source-file results. The feature also adds stable relationship files to the bundle and keeps graph state available for deletion, retry, and republish workflows.

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
  graph_node/v1/
    {shard}.json
  graph_edge/v1/
    {shard}.json
  by-file/
    {fileId}.json
```

| File | Purpose |
| --- | --- |
| `_graph/index.md` | Human and Agent entry point for graph navigation. |
| `_index/catalog.json` | Bounded descriptors for active graph-node and graph-edge projection shards. |
| `_graph/graph_node/v1/*.json` | Sharded graph-node records. |
| `_graph/graph_edge/v1/*.json` | Sharded relationship records for exports and audits. |
| `_graph/by-file/{fileId}.json` | Bounded local neighborhood for one Markdown page created from an uploaded file. This is the primary Agent exploration file. |

The root `index.md` links to `_graph/index.md` whenever graph output is available. Normal Agent reading should start from generated Markdown pages and then use `_graph/by-file/{fileId}.json`. Agents rarely need to read full edge shards.

## Page References

Markdown pages created from uploaded files include stable graph references in frontmatter when graph data exists.

```yaml
fileId: "source-file-123"
graph: "../_graph/by-file/source-file-123.json"
```

The generated page body can also include a `Related` section derived from persisted graph edges. The same graph edges drive `_index/links.json`, so relationship data stays consistent across Markdown pages, JSON indexes, and per-file graph files.

## Relationship Fields

Each relationship record contains safe public fields.

| Field | Meaning |
| --- | --- |
| `fileId` | Related published source-file identifier. |
| `path` | Related generated Markdown path, such as `pages/example.md`. |
| `title` | Related file title. |
| `relationType` | Relationship type, such as `direct_reference`, `same_entity`, `same_specific_subject`, or `metadata_supported_content`. |
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

Developer OpenAPI file search defaults to `mode=hybrid`. Within independent bounded budgets, it concurrently runs eligible exact-path, exact-title, lexical, Jieba, file-graph, content-vector, entity-vector, relationship-vector, and community-vector lanes, then applies deterministic fusion and stable ordering to produce one deduplicated source-file result list. Exact paths and body-grounded exact titles retain explicit priority. `mode=file` explicitly narrows discovery to the file scope while preserving the existing calling contract; `mode=graph` explicitly narrows discovery to persisted graph nodes and relationships.

Content vectors cover every active source file. When an active semantic projection is available, fused retrieval can also use bounded entity, relationship, and community evidence to improve source-file discovery. Sparse selection applies only to the generation-model semantic skeleton; files outside that selection still participate in exact, lexical, Jieba, content-vector, and file-graph retrieval. Search continues to return published source-file results and an optional `semanticStatus`; it does not return generated answers, raw vectors, prompts, or internal semantic records. If an optional semantic lane is slow or unavailable, completed safe lanes can still return results within the overall query deadline.

Graph search reads the same active relationship projection that generates `_graph/` files and `Related` sections. It does not parse graph files during the request. This keeps large knowledge-base queries bounded and lets ingestion, deletion, and publication update graph reads through one active generation.

Each graph result can include `matchType`, `graphContext.graphRef`, `graphContext.relationships`, `graphContext.graphPaths`, and result-level `readActions`. Use graph fields as navigation hints, then follow `readActions` to read the generated Markdown file by ID or path. The generated Markdown file content remains the evidence source that should be read before producing an answer.

Graph expansion accepts a file, node, edge, or query seed and returns bounded relationship paths with file read actions. Use it after an Agent has a promising file or graph candidate, then continue the same loop by reading the returned Markdown files. Search and graph expansion are discovery tools. Complete Markdown files remain the evidence that supports the final answer.

## Operational Notes

PostgreSQL stores relationship facts, projection impacts, active graph nodes, and active graph edges. Redis coordinates scoped locks, cursors, and short-lived graph caches. S3-compatible storage keeps generated `_graph/` Markdown and machine shards as immutable objects referenced by the active generation.

Processing is file-level. For a knowledge base with a current semantic contract, upload and body replacement automatically run complete source indexing, bounded GraphRAG enrichment, semantic reconciliation, embedding generation, affected graph and generated-content projection, and selected-provider search publication. Every source remains covered by exact path, exact title, lexical, Jieba, content-vector, file-graph, and provider indexing. Model-generated graph enrichment is limited to a deterministic set of structurally or relationally important sources so large imports do not make one generation request for every chunk. Search publication is the final readiness gate. Creating, replacing, renaming, moving, or deleting a file updates only the affected file, relationship, semantic, vector, reverse-reference, generated-content, and search scopes. Directory operations use bounded child batches. Ordinary changes do not run a complete knowledge-base graph rebuild or require manual index maintenance, and failed files can be retried through the same source-file retry flow.

Optional semantic enrichment uses an Admin-managed generation model and embedding model. It can add bounded entity context and stronger evidence-grounded relationship explanations to the existing pages and `_graph` resources, but it does not add another public tree, a graph database, an entity-management console, or a graph visualization UI. Existing Markdown paths, navigation files, stable leaves, source bodies, and Developer OpenAPI read workflow remain unchanged. Explicit maintenance is reserved for first-contract establishment, contract or provider adoption, repair, recovery, and full rebuild; existing readable content stays active while it builds and validates a replacement semantic projection.

The current release starts from a clean breaking storage baseline and does not reuse or convert knowledge bases, source content, model settings, generated content, semantic artifacts, or search indexes from an earlier release. Import source Markdown again into the empty target deployment. **Maintain index** remains available for later current-baseline contract or provider adoption. Complete coverage and sparse enrichment have different meanings: every active source receives the complete deterministic and vector retrieval coverage listed above, while only the bounded semantic skeleton uses the generation model. Source Markdown remains authoritative and continues to be returned through the same Developer OpenAPI read actions.

For large imports, keep the source-worker CPU and memory limits configured in the deployment environment and increase Admin concurrency only after observing the generation endpoint, embedding endpoint, PostgreSQL, object storage, and selected search service together. External-model latency can remain the dominant indexing cost even when local CPU and memory stay within their limits. The file-processing status and maintenance status expose progress and safe failures without requiring a full-corpus retry.
