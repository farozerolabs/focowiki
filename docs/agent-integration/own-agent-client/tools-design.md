---
title: Tools Design
---

# Tools Design

Use this page when developers control their own Agent client or runtime. In this mode, the Agent calls built-in tools registered by the developer.

The Skill should describe only user-visible tool behavior and knowledge evidence rules.

## Recommended Tools

| Tool | Purpose | Required input | Main output |
| --- | --- | --- | --- |
| `list_tree` | Discover files in the configured knowledge base. | none | `items`, `nextCursor` |
| `get_file` | Read safe metadata for one file. | `fileId` | file metadata |
| `read_file` | Read one Markdown file. | `fileId` or `path` | Markdown content and metadata |
| `read_related` | Read bounded related files for one generated page. | `fileId` | related file records |
| `expand_graph` | Explore related files from a file or query. | `fileId` or `query` | relationship paths and file read actions |
| `search_files` | Return candidate files for an Agent-generated search phrase. | `query` | `items`, `searchStatus`, `nextActions` |

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
  "items": [
    {
      "fileId": "file_123",
      "path": "pages/example.md",
      "title": "Example",
      "type": "page",
      "description": "Short summary."
    }
  ],
  "nextCursor": null
}
```

Use `nextCursor` to continue pagination. Keep each request bounded by `limit`.

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
  "fileId": "file_123",
  "path": "pages/example.md",
  "title": "Example",
  "type": "page",
  "description": "Short summary.",
  "metadata": {
    "tags": ["example"]
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
  "fileId": "file_123",
  "path": "pages/example.md",
  "title": "Example",
  "content": "# Example\n\nMarkdown content.",
  "metadata": {
    "tags": ["example"]
  }
}
```

Use readable file IDs returned by tree, search, file detail, or a visible `generatedFileId` field when calling `read_file` by `fileId`. Use logical paths for known generated files such as `index.md`, `schema.md`, `log.md`, `_graph/index.md`, `_index/catalog.json`, a returned `graphRef`, a visible `generatedFilePath`, or pages discovered from links.

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

This tool is optional. The Agent can also pass a returned `graphRef` to `read_file`. It should not construct that path from a generated `fileId`.

## `expand_graph`

This tool is optional. Implement it when the Agent should use Developer OpenAPI graph expansion directly. It should accept exactly one seed.

Input by file:

```json
{
  "fileId": "file_123",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

Input by query:

```json
{
  "query": "renewal notice",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

Output:

```json
{
  "seed": {
    "type": "file",
    "fileId": "file_123",
    "path": "pages/example.md"
  },
  "relationships": [
    {
      "fileId": "file_456",
      "path": "pages/related.md",
      "title": "Related",
      "relationType": "same_specific_subject",
      "confidence": 0.86,
      "readActions": {
        "contentByPath": "/files/content?path=pages/related.md",
        "graphExpansionByFileId": "/graph/expand?fileId=file_456"
      }
    }
  ],
  "nextCursor": null
}
```

Use this tool after a promising file, search result, related-file entry, graph file, or graph candidate appears. Read returned Markdown files before using them as answer evidence.

## `search_files`

This tool is optional. Implement `search_files` when the Agent needs candidate lookup. A backend can call Focowiki Developer OpenAPI `searchGeneratedFiles`, read generated index files, or use its own read layer.

The Agent owns query planning. It should derive short phrases from the user question, the knowledge-base overview, schema hints, already-read files, and remaining evidence gaps. The tool should return candidates for one phrase at a time.

Input:

```json
{
  "query": "renewal notice",
  "cursor": null,
  "limit": 10
}
```

Output:

```json
{
  "items": [
    {
      "fileId": "file_123",
      "path": "pages/example.md",
      "title": "Example",
      "description": "Short summary.",
      "score": 12,
      "matchedFields": ["title", "description"]
    }
  ],
  "searchStatus": "ok",
  "message": null,
  "nextActions": [],
  "nextCursor": null
}
```

For direct questions, the Agent derives concise phrases from the user question, visible knowledge-base context, already-read files, and remaining evidence gaps. After reading useful files, it can derive new phrases and continue with `search_files`, `nextActions`, `list_tree`, links, graph files, `expand_graph`, and related files.

## Error Shape

```json
{
  "code": "file_not_found",
  "message": "The requested file was not found.",
  "requestId": "req_123"
}
```

The Agent should report a useful answer when the knowledge base does not contain enough evidence.
