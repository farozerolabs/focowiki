---
title: Tools Design
---

# Tools Design

Use this page when developers control their own Agent client or runtime. In this mode, the Agent calls built-in tools registered by the developer.

Keep the tool surface small and preserve the continuity fields returned by Developer OpenAPI. Do not reproduce search, graph, or document-state logic in the Agent runtime.

## Recommended Tools

| Tool | Purpose | Required input | Main output |
| --- | --- | --- | --- |
| `search_files` | Find current readable source candidates. | `query` | search state, candidates, read actions |
| `read_file` | Read one current file. | exactly one of `fileId` or `path` | `{ file, content }` |
| `list_tree` | Discover current files and folders. | optional `parentPath` | revision, `items`, `nextCursor` |
| `get_file` | Read current metadata for one file. | `fileId` | file metadata and read actions |
| `read_related` | Read bounded related files for one current source file. | `fileId` | related file records |
| `expand_graph` | Explore related files from one readable file. | `fileId` | relationship paths and file read actions |

`search_files` and `read_file` form the core question-answering loop. `list_tree` is the discovery fallback. The remaining tools are useful when the product needs metadata or relationship exploration.

## `list_tree`

Input:

```json
{
  "parentPath": "",
  "cursor": null,
  "limit": 50
}
```

Output:

```json
{
  "activeContentRevision": 42,
  "items": [
    {
      "fileId": "source-file-11111111-1111-4111-8111-111111111111",
      "sourceFileId": "source-file-11111111-1111-4111-8111-111111111111",
      "path": "pages/example.md",
      "title": "Example",
      "entryType": "file",
      "fileKind": "page",
      "contentAvailable": true,
      "readActions": {
        "fileContentByPath": "/openapi/v2/knowledge-bases/knowledge-base-11111111-1111-4111-8111-111111111111/files/content?path=pages%2Fexample.md"
      }
    }
  ],
  "nextCursor": null
}
```

Use `nextCursor` only with the same `parentPath`, `limit`, and `activeContentRevision`. Restart without a cursor if the API rejects a stale cursor.

## `get_file`

Input:

```json
{
  "fileId": "file_123"
}
```

Output:

```json
{
  "activeContentRevision": 42,
  "fileId": "source-file-11111111-1111-4111-8111-111111111111",
  "sourceFileId": "source-file-11111111-1111-4111-8111-111111111111",
  "path": "pages/example.md",
  "title": "Example",
  "fileKind": "page",
  "description": "Short summary.",
  "frontmatter": {
    "tags": ["example"]
  },
  "contentAvailable": true,
  "readActions": {
    "fileContentByPath": "/openapi/v2/knowledge-bases/knowledge-base-11111111-1111-4111-8111-111111111111/files/content?path=pages%2Fexample.md"
  }
}
```

Use this tool when the Agent needs metadata before reading full content.

## `read_file`

Input by ID:

```json
{
  "fileId": "file_123"
}
```

Input by path:

```json
{
  "path": "pages/example.md"
}
```

Output:

```json
{
  "file": {
    "activeContentRevision": 42,
    "fileId": "source-file-11111111-1111-4111-8111-111111111111",
    "sourceFileId": "source-file-11111111-1111-4111-8111-111111111111",
    "path": "pages/example.md",
    "title": "Example",
    "frontmatter": {
      "tags": ["example"]
    },
    "readActions": {
      "relatedFilesById": "/openapi/v2/knowledge-bases/knowledge-base-11111111-1111-4111-8111-111111111111/files/source-file-11111111-1111-4111-8111-111111111111/related"
    }
  },
  "content": "# Example\n\nMarkdown content."
}
```

Return the OpenAPI `{ file, content }` shape unchanged. Use readable `fileId` or `path` values returned by tree, search, file detail, related files, graph expansion, or Markdown links. A source-backed page uses its stable `sourceFileId` as `fileId` after `generatedOutputStatus` becomes `current_available`.

Use `pages/**` source-backed Markdown as answer evidence. `index.md`, directory indexes, `_index/**`, and `_graph/**` support discovery and traversal.

## `read_related`

Input:

```json
{
  "fileId": "file_123",
  "cursor": null,
  "limit": 20
}
```

Output:

```json
{
  "fileId": "file_123",
  "items": [
    {
      "fileId": "file_456",
      "path": "pages/related.md",
      "title": "Related",
      "relationType": "shared_tag",
      "direction": "outgoing",
      "weight": 0.8,
      "reason": "Both files share tags.",
      "contentAvailable": true
    }
  ],
  "nextCursor": null
}
```

This tool is optional. The Agent can also pass a returned `graphRef` to `read_file`. It must not construct `_graph` paths from IDs.

## `expand_graph`

This tool is optional. Implement it when the Agent should use Developer OpenAPI graph expansion directly. The current operation accepts one required `fileId` seed.

Input by file:

```json
{
  "fileId": "file_123",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

Output:

```json
{
  "activeContentRevision": 42,
  "seedFile": {
    "fileId": "source-file-11111111-1111-4111-8111-111111111111",
    "path": "pages/example.md"
  },
  "relationships": [
    {
      "fileId": "source-file-22222222-2222-4222-8222-222222222222",
      "path": "pages/related.md",
      "title": "Related",
      "relationType": "same_specific_subject",
      "direction": "outgoing",
      "weight": 0.86,
      "readActions": {
        "fileContentByPath": "/openapi/v2/knowledge-bases/knowledge-base-11111111-1111-4111-8111-111111111111/files/content?path=pages%2Frelated.md",
        "graphExpansionByFileId": "/openapi/v2/knowledge-bases/knowledge-base-11111111-1111-4111-8111-111111111111/graph/expand?fileId=source-file-22222222-2222-4222-8222-222222222222"
      }
    }
  ],
  "graphPaths": ["_graph/by-file/example.json"],
  "nextCursor": null
}
```

Use this tool after a promising file, search result, related-file entry, graph file, or graph candidate appears. Read returned Markdown files before using them as answer evidence.

## `search_files`

Implement `search_files` as a thin adapter over `searchGeneratedFiles` for online Agent access. Static exported bundles can use `_index/**` for bounded navigation, but those files are not a replacement for online full-text and hybrid search.

The first request should contain the complete standalone user question and use default `hybrid` retrieval. The Agent may run at most two later searches, each derived from source Markdown already read. The tool returns source-file candidates, not answer evidence.

Input:

```json
{
  "query": "What does the knowledge base say about renewal notices?",
  "mode": "hybrid",
  "graphDepth": 1,
  "graphFanout": 10,
  "rerank": false,
  "cursor": null,
  "limit": 10
}
```

Output:

```json
{
  "activeContentRevision": 42,
  "items": [
    {
      "fileId": "source-file-11111111-1111-4111-8111-111111111111",
      "sourceFileId": "source-file-11111111-1111-4111-8111-111111111111",
      "path": "pages/example.md",
      "title": "Example",
      "description": "Short summary.",
      "score": 12,
      "matchedFields": ["content"],
      "evidenceTypes": ["content"],
      "sourceExcerpt": "Bounded source-grounded excerpt.",
      "contentAvailable": true,
      "readActions": {
        "fileContentById": "/openapi/v2/knowledge-bases/knowledge-base-11111111-1111-4111-8111-111111111111/files/source-file-11111111-1111-4111-8111-111111111111/content"
      }
    }
  ],
  "searchStatus": "ok",
  "searchMode": "hybrid",
  "semanticStatus": { "state": "ready", "safeCode": null },
  "rerankerStatus": { "state": "skipped", "safeCode": "RERANKER_DISABLED" },
  "message": null,
  "nextActions": [],
  "nextCursor": null
}
```

Read the selected Markdown files before answering. Track `fileId` and `path` to avoid duplicate reads. Search snippets, machine-readable index records, relationship descriptions, and reranker output are discovery hints only. `searchStatus=no_candidates` is a successful empty result; `SEARCH_TIMEOUT` and `SEARCH_UNAVAILABLE` are errors and must remain distinguishable.

## Error Shape

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "The requested file was not found.",
    "httpStatus": 404
  },
  "requestId": "req-11111111-1111-4111-8111-111111111111"
}
```

Preserve `requestId`. Honor `retryAfterSeconds` for `RATE_LIMITED`, restart a rejected cursor without the cursor, and never convert transport or dependency errors into empty results.
