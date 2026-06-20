---
title: Backend Adapter
---

# Backend Adapter

The backend adapter is the application code that connects your product to Focowiki Developer OpenAPI. It keeps Focowiki credentials server-side, supports product workflows such as upload and source-file processing observation, and provides a smaller read interface for Agent access.

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
| Knowledge-base management | `listKnowledgeBases`, `createKnowledgeBase`, `deleteKnowledgeBase` |
| Markdown ingestion | `uploadMarkdownFiles`, `listKnowledgeBaseSourceFiles`, `getKnowledgeBaseSourceFile`, `listKnowledgeBaseSourceFileEvents`, `retryKnowledgeBaseSourceFile` |
| Generated file maintenance | `listKnowledgeBaseTree`, `getFileById`, `getFileContentById`, `getFileContentByPath`, `deleteFileById`, `deleteFileByPath` |
| Webhooks | `listWebhooks`, `createWebhook`, `deleteWebhook`, `listWebhookDeliveries`, `redeliverWebhook` |

These operations belong to the developer backend. The Agent-facing layer should expose only the read operations needed for exploration unless the product intentionally supports Agent-driven maintenance.

## Minimal Backend Interface

The exact routes belong to your product. This example shows a small shape that works well for Agent access:

| Backend route or tool | Calls Focowiki | Returns |
| --- | --- | --- |
| `GET /agent/knowledge/tree` | `listKnowledgeBaseTree` | Page of file entries and `nextCursor`. |
| `GET /agent/knowledge/files/{fileId}` | `getFileById` | Safe file metadata. |
| `GET /agent/knowledge/files/{fileId}/content` | `getFileContentById` | Markdown content. |
| `GET /agent/knowledge/files/content?path=...` | `getFileContentByPath` | Markdown content by logical path. |
| `GET /agent/knowledge/files/{fileId}/related` | `listRelatedFiles` | Bounded related file records. |
| `GET /agent/knowledge/search?query=<agent-generated phrase>` | Your search layer or generated index files | Candidate files for the Agent to read. |

The `search` route is optional. The Agent should create the query phrase, and the route should return ranked file-level candidates for that phrase. Empty search responses should include safe continuation guidance so the Agent can continue with `index.md`, tree listing, shorter phrases, links, graph files, or related-file reads. A simple first version can start with tree listing and file reads.

For third-party Agent clients, you can publish the read-only base URL as `https://knowledge.example.com` and route it internally to the same `/agent/knowledge` adapter. The Skill then sees shorter paths such as `/tree`, `/files/{fileId}`, and `/files/content?path=index.md`, while your backend still controls authentication, authorization, and Focowiki OpenAPI access.

For own Agent clients, register tools with the same contract:

| Tool | Backend route |
| --- | --- |
| `list_tree` | `GET /agent/knowledge/tree` |
| `get_file` | `GET /agent/knowledge/files/{fileId}` |
| `read_file` | `GET /agent/knowledge/files/{fileId}/content` or `GET /agent/knowledge/files/content?path=...` |
| `read_related` | `GET /agent/knowledge/files/{fileId}/related` or `GET /agent/knowledge/files/content?path=_graph/by-file/{fileId}.json` |
| `search_files` | `GET /agent/knowledge/search?query=<agent-generated phrase>` |

## Identifier Flow

The backend should preserve the same identifiers that Focowiki returns:

| Identifier | Source | Later use |
| --- | --- | --- |
| `knowledgeBaseId` | Admin UI, `listKnowledgeBases`, or backend configuration | Scope all Focowiki calls. |
| `sourceFileId` | Upload responses and source-file processing rows | Read processing status, read events, retry failed processing, and resolve generated output fields. |
| `generatedFileId` or generated `fileId` | Tree entries, search results, generated file detail responses, or `generatedFileId` from source-file detail | Read generated file metadata and Markdown content. |
| `generatedFilePath` or `path` | Tree entries, search results, links, or `generatedFilePath` from source-file detail | Read generated file content by logical path. |
| `graphRef` | Page frontmatter or `_index/search.json` | Read `_graph/by-file/{fileId}.json` for related files. |
| `cursor` | List responses | Continue pagination. |

This makes the Agent workflow continuous. The value returned by one call can be used by the next call.

When a workflow starts from a source-file row, call the source-file detail endpoint first. Use `generatedFileId` with `/files/{fileId}/content` or `generatedFilePath` with `/files/content?path=...` after `generatedFileAvailable` is true.

## Security Rules

- Keep the Focowiki OpenAPI key only in the backend.
- Authenticate the Agent or product user before calling the backend adapter.
- Authorize each request against the selected knowledge base.
- Reject storage paths and accept only `fileId` or logical `path` values returned by Focowiki.
- Apply pagination and per-request limits.
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
