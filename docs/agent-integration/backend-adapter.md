---
title: Backend Adapter
---

# Backend Adapter

The backend adapter is the application code that connects your product to Focowiki Developer OpenAPI. It keeps credentials server-side, supports resumable upload and per-document indexing observation, and provides a smaller read interface for Agent access.

## Responsibilities

| Responsibility | Detail |
| --- | --- |
| Credential storage | Store the Focowiki OpenAPI base URL and API key in your backend secret manager or runtime configuration. |
| Knowledge-base selection | Map product tenants, projects, or users to allowed `knowledgeBaseId` values. |
| Request shaping | Convert product-level requests into Focowiki OpenAPI calls. |
| Response shaping | Return only fields the Agent needs for exploration and reading. |
| Error mapping | Convert Focowiki error codes into stable application errors. |
| Rate control | Apply product-level rate limits before requests reach Focowiki. |
| Mode routing | Serve built-in tools for own Agent clients and read-only HTTP endpoints for third-party Agent clients. |

## Connection Steps

1. Create an OpenAPI key from Focowiki Admin UI.
2. Store the key in the backend environment or secret manager.
3. Store the Focowiki OpenAPI base URL, such as `https://openapi.example.com`.
4. Resolve or configure the target `knowledgeBaseId`.
5. Add a small Focowiki client module that handles authentication, JSON parsing, pagination, and error mapping.
6. Add product workflow services for knowledge-base creation, upload, source-file observation, retry, deletion, and webhook management when your product needs them.
7. Add Agent-facing endpoints or tools that call the client module for read access.

## Product Workflow Boundary

The backend can use the full Focowiki Developer OpenAPI surface:

| Workflow | Typical operations |
| --- | --- |
| Knowledge-base management | `listKnowledgeBases`, `createKnowledgeBase`, `updateKnowledgeBase`, `deleteKnowledgeBase` |
| Markdown ingestion | `createUploadSession`, `addUploadManifestEntries`, `sealUploadManifest`, `uploadSessionEntryContent`, `getUploadSession`, `finalizeUploadSession` |
| Source observation | `listKnowledgeBaseSourceFiles`, `getKnowledgeBaseSourceFile`, `retryKnowledgeBaseSourceFile` |
| Source maintenance | `moveSourceFile`, `replaceSourceFileContent`, `deleteSourceFile`, `listSourceDirectories`, `moveSourceDirectory`, `deleteSourceDirectory`, `listResourceOperations`, `getResourceOperation` |
| File reading and exploration | `listKnowledgeBaseTree`, `getFileById`, `getFileContentById`, `getFileContentByPath`, `searchGeneratedFiles`, `listRelatedFiles`, `expandGraph`, `getGraphOverview` |
| Webhooks | `listWebhooks`, `createWebhook`, `deleteWebhook`, `listWebhookDeliveries`, `redeliverWebhook` |

These operations belong to the developer backend. The Agent-facing layer should expose only the read operations needed for exploration unless the product intentionally supports Agent-driven maintenance.

## Document Indexing Lifecycle

An upload session is a resumable transport envelope, not an availability batch. `finalizeUploadSession` returns an `operationId` after accepting the uploaded entries. Every accepted document is indexed independently and may become available while sibling documents are still waiting or processing.

For each returned `sourceFileId`:

1. Read `getKnowledgeBaseSourceFile`, follow `links.self`, or consume the `document.waiting`, `document.processing`, `document.available`, `document.error`, and `document.deleting` Webhook events.
2. Treat `state=available` plus `generatedOutputStatus=current_available` as the current readable result.
3. Follow `actions[].href` or `links.generatedContent` instead of constructing a generated path.
4. Treat `state=error` with `generatedOutputStatus=unavailable` as unreadable. When `generatedOutputStatus=previous_available`, the current processing attempt failed but the prior readable revision remains available.
5. Use `retryKnowledgeBaseSourceFile` only when the returned action and failure guidance allow document processing retry.

Do not wait for every document in the upload operation before exposing documents that are already available.

## Minimal Backend Interface

The exact routes belong to your product. This example shows a small shape that works well for Agent access:

| Backend route or tool | Calls Focowiki | Returns |
| --- | --- | --- |
| `GET /agent/knowledge/tree` | `listKnowledgeBaseTree` | `activeContentRevision`, file entries, and `nextCursor`. |
| `GET /agent/knowledge/files/{fileId}` | `getFileById` | Current readable file metadata and `readActions`. |
| `GET /agent/knowledge/files/{fileId}/content` | `getFileContentById` | Exact `{ file, content }` response. |
| `GET /agent/knowledge/files/content?path=...` | `getFileContentByPath` | Exact `{ file, content }` response by logical path. |
| `GET /agent/knowledge/files/{fileId}/related` | `listRelatedFiles` | Bounded related files with their `readActions`. |
| `GET /agent/knowledge/graph/expand?fileId=...` | `expandGraph` | Direct or second-level related files from one readable file. |
| `GET /agent/knowledge/search?query=<standalone natural-language question>` | `searchGeneratedFiles` | Ranked readable candidates and continuation actions. |

The `search` route should remain a thin pass-through to `searchGeneratedFiles`. Send the user's complete standalone question first and use the recommended default `hybrid` mode. Preserve `activeContentRevision`, `searchStatus`, `semanticStatus`, `evidenceStatus`, `rerankerStatus`, `graphStatus`, `resultSummary`, `nextActions`, and each result's `readActions`. The Agent must read selected source Markdown before using it as evidence.

For third-party Agent clients, you can publish the read-only base URL as `https://knowledge.example.com` and route it internally to the same `/agent/knowledge` adapter. The Skill then sees shorter paths such as `/tree`, `/files/{fileId}`, and `/files/content?path=index.md`, while your backend still controls authentication, authorization, and Focowiki OpenAPI access.

For own Agent clients, register tools with the same contract:

| Tool | Backend route |
| --- | --- |
| `list_tree` | `GET /agent/knowledge/tree` |
| `get_file` | `GET /agent/knowledge/files/{fileId}` |
| `read_file` | `GET /agent/knowledge/files/{fileId}/content` or `GET /agent/knowledge/files/content?path=...` |
| `read_related` | `GET /agent/knowledge/files/{fileId}/related` or a content read using the returned `graphRef` |
| `search_files` | `GET /agent/knowledge/search?query=<complete standalone user question>` |
| `expand_graph` | `GET /agent/knowledge/graph/expand?fileId=...` |

## Identifier Flow

The backend should preserve the same identifiers that Focowiki returns:

| Identifier | Source | Later use |
| --- | --- | --- |
| `knowledgeBaseId` | Admin UI, `listKnowledgeBases`, or backend configuration | Scope all Focowiki calls. |
| `sourceFileId` | Upload responses and source-file processing rows | Read processing status and source Markdown, run supported mutations, and identify the corresponding readable source page after `generatedOutputStatus` becomes `current_available`. |
| `fileId` | Tree entries, search results, file detail, related files, or graph expansion | Read file metadata and content. Source-backed pages use the same stable value as `sourceFileId`. |
| `generatedPath` or `path` | Source-file detail, tree entries, search results, file detail, or returned links | Read current content by its portable logical path. |
| `activeContentRevision` | Tree, file, search, related-file, and graph responses | Keep a multi-call read on one current readable knowledge-base revision. Restart pagination when the revision changes. |
| `graphRef` | Search results and relationship responses | Read the referenced `_graph/by-file/**` JSON file without constructing its path. |
| `cursor` | List responses | Continue pagination. |

This makes the Agent workflow continuous. The value returned by one call can be used by the next call.

When a workflow starts from a source-file row, call the source-file detail endpoint first. After `generatedOutputStatus` becomes `current_available`, follow the exact non-null `links.generatedContent` or `open_generated_file` action returned by that response. Source-backed pages use the same `sourceFileId` as their readable `fileId`.

Do not flatten away continuity fields. Return the OpenAPI `{ file, content }` shape for content reads and preserve all returned `readActions`. If your product intentionally presents a flatter tool response, document that mapping as an adapter contract and retain `frontmatter`, `okfSignals`, `activeContentRevision`, `fileId`, and `path`.

## Security Rules

- Keep the Focowiki OpenAPI key only in the backend.
- Authenticate the Agent or product user before calling the backend adapter.
- Authorize each request against the selected knowledge base.
- Reject storage paths and accept only `fileId` or logical `path` values returned by Focowiki.
- Apply pagination and per-request limits.
- Reuse `nextCursor` only with the same endpoint parameters and `activeContentRevision`.
- Preserve the structured `{ error, requestId }` envelope. Honor `retryAfterSeconds` for `RATE_LIMITED` and distinguish `SEARCH_TIMEOUT` or `SEARCH_UNAVAILABLE` from `no_candidates`.
- Log request IDs and stable error codes for troubleshooting.

## Implementation Shape

Keep the adapter split into small modules:

| Module | Purpose |
| --- | --- |
| `config` | Load Focowiki origin and credentials. |
| `focowikiClient` | Call Developer OpenAPI and normalize errors. |
| `knowledgeAccess` | Select knowledge bases and enforce authorization. |
| `agentRoutes` | Expose the minimal Agent-facing interface. |

This keeps the Agent integration easy to review and easy to replace when your product adds a richer search layer.
