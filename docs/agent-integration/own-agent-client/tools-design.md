---
title: Tools Design
---

# Tools Design

Use this page when developers control their own Agent client or runtime. In this mode, the Agent calls built-in tools registered by the developer.

The Skill should describe the tools from the Agent user's perspective. It should not expose service credentials, storage paths, or internal implementation details.

## Recommended Tools

| Tool | Purpose | Required input | Main output |
| --- | --- | --- | --- |
| `list_tree` | Discover files in the configured knowledge base. | none | `items`, `nextCursor` |
| `get_file` | Read safe metadata for one file. | `fileId` | file metadata |
| `read_file` | Read one Markdown file. | `fileId` or `path` | Markdown content and metadata |
| `search_files` | Find candidate files for a question. | `query` | matching file entries |

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

Prefer `fileId` when the Agent already has it. Use `path` for known generated files such as `index.md`, `schema.md`, `log.md`, or pages discovered from links.

## `search_files`

This tool is optional. Focowiki Developer OpenAPI does not expose a direct search route. Implement `search_files` in your backend when the Agent needs search, commonly by reading the generated `_index/search.json` file or by using your own search layer.

Input:

```json
{
  "query": "contract renewal",
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
      "description": "Short summary."
    }
  ],
  "nextCursor": null
}
```

Use search as a shortcut for direct questions. If search is unavailable or insufficient, use `list_tree`.

## Error Shape

```json
{
  "code": "file_not_found",
  "message": "The requested file was not found.",
  "requestId": "req_123"
}
```

The Agent should report a useful answer when the knowledge base does not contain enough evidence.
