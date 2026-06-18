---
title: Tools 设计
---

# Tools 设计

当开发者控制自己的 Agent client 或 runtime 时，使用这个页面。这种模式下，Agent 调用开发者注册的内置工具。

Skill 应该从 Agent 用户视角描述工具。不在 Skill 中暴露服务凭据、存储路径或内部实现细节。

## 推荐工具

| 工具 | 用途 | 必要输入 | 主要输出 |
| --- | --- | --- | --- |
| `list_tree` | 发现已配置知识库中的文件。 | 无 | `items`、`nextCursor` |
| `get_file` | 读取单个文件的安全元数据。 | `fileId` | 文件元数据 |
| `read_file` | 读取一个 Markdown 文件。 | `fileId` 或 `path` | Markdown 内容和 metadata |
| `read_related` | 读取一个 source-backed page 的有界相关文件。 | `fileId` | 相关文件记录 |
| `search_files` | 为问题查找候选文件。 | `query` | 匹配文件条目 |

## `list_tree`

输入：

```json
{
  "parentPath": "",
  "cursor": null,
  "limit": 50
}
```

输出：

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

使用 `nextCursor` 继续分页。每次请求都用 `limit` 控制范围。

## `get_file`

输入：

```json
{
  "fileId": "file_123"
}
```

输出：

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

Agent 需要先查看文件元数据，再决定是否读取全文时使用这个工具。

## `read_file`

按 ID 输入：

```json
{
  "fileId": "file_123"
}
```

按 path 输入：

```json
{
  "path": "pages/example.md"
}
```

输出：

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

Agent 已经拿到 `fileId` 时优先使用 `fileId`。读取 `index.md`、`schema.md`、`log.md`、`_graph/index.md`、`_graph/manifest.json`、`_graph/by-file/{fileId}.json` 或从链接发现的页面时可以使用 `path`。

## `read_related`

输入：

```json
{
  "fileId": "file_123",
  "cursor": null,
  "limit": 20
}
```

输出：

```json
{
  "fileId": "file_123",
  "sourceFileId": "source_123",
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

这个工具是可选项。Agent 也可以通过 `read_file` 按逻辑路径读取 `_graph/by-file/{fileId}.json`。

## `search_files`

这个工具是可选项。Focowiki Developer OpenAPI 不直接提供搜索路由。Agent 需要搜索时，在你的后端实现 `search_files`，常见方式是读取生成的 `_index/search.json` 文件，或接入你自己的搜索层。

输入：

```json
{
  "query": "contract renewal",
  "cursor": null,
  "limit": 10
}
```

输出：

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

直接问题可以先用搜索。搜索不可用或结果不足时使用 `list_tree`。

## 错误结构

```json
{
  "code": "file_not_found",
  "message": "The requested file was not found.",
  "requestId": "req_123"
}
```

知识库没有足够证据时，Agent 应该如实说明。
