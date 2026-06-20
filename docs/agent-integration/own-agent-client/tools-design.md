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

Use readable file IDs returned by tree, search, file detail, or a visible `generatedFileId` field when calling `read_file` by `fileId`. Use logical paths for known generated files such as `index.md`, `schema.md`, `log.md`, `_graph/index.md`, `_graph/manifest.json`, `_graph/by-file/{fileId}.json`, visible `generatedFilePath`, or pages discovered from links.

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

This tool is optional. The Agent can also read `_graph/by-file/{fileId}.json` through `read_file` by logical path.

## `search_files`

This tool is optional. Implement `search_files` when the Agent needs candidate lookup, commonly by reading the generated `_index/search.json` file or by using your own search layer.

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
      "matchedTerms": ["renewal", "notice"],
      "matchedFields": ["title", "description"]
    }
  ],
  "searchStatus": "ok",
  "message": null,
  "nextActions": [],
  "nextCursor": null
}
```

For direct questions, the Agent derives concise phrases from the user question, visible knowledge-base context, already-read files, and remaining evidence gaps. After reading useful files, it can derive new phrases and continue with `search_files`, `nextActions`, `list_tree`, links, graph files, and related files.

## Error Shape

```json
{
  "code": "file_not_found",
  "message": "The requested file was not found.",
  "requestId": "req_123"
}
```

The Agent should report a useful answer when the knowledge base does not contain enough evidence.
