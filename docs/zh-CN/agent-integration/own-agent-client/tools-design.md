---
title: Tools 设计
---

# Tools 设计

当开发者控制自己的 Agent 客户端或运行环境时，使用本页。这种模式下，Agent 调用开发者注册的内置工具。

工具接口应保持精简，并保留 Developer OpenAPI 返回的连续性字段。不要在 Agent 运行环境中重复实现搜索、图关系或文档状态逻辑。

## 推荐工具

| 工具 | 用途 | 必要输入 | 主要输出 |
| --- | --- | --- | --- |
| `search_files` | 查找当前可读的来源候选。 | `query` | 搜索状态、候选和读取动作 |
| `read_file` | 读取一个当前文件。 | `fileId` 或 `path` 二选一 | `{ file, content }` |
| `list_tree` | 发现当前文件和目录。 | 可选 `parentPath` | 修订号、`items`、`nextCursor` |
| `get_file` | 读取一个文件的当前元数据。 | `fileId` | 文件元数据和读取动作 |
| `read_related` | 读取一个当前来源文件的有界相关文件。 | `fileId` | 相关文件记录 |
| `expand_graph` | 从一个可读文件探索相关文件。 | `fileId` | 关系路径和文件读取动作 |

`search_files` 与 `read_file` 构成问答主循环，`list_tree` 是发现兜底。只有需要元数据或关系探索时才调用其余工具。

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

`nextCursor` 只能和相同的 `parentPath`、`limit`、`activeContentRevision` 一起使用。API 拒绝过期游标时，不带游标重新开始。

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

Agent 需要先查看文件元数据，再决定是否读取全文时使用这个工具。

## `read_file`

按 ID 输入：

```json
{
  "fileId": "file_123"
}
```

按路径输入：

```json
{
  "path": "pages/example.md"
}
```

输出：

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

原样返回 OpenAPI 的 `{ file, content }`。使用文件树、搜索、文件详情、相关文件、图扩展或 Markdown 链接返回的 `fileId` 或 `path`。来源页面在 `generatedOutputStatus` 变为 `current_available` 后，使用稳定的 `sourceFileId` 作为 `fileId`。

`pages/**` 下来源 Markdown 可以作为回答证据；`index.md`、目录索引、`_index/**` 和 `_graph/**` 只用于发现与导航。

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

这个工具是可选项。Agent 也可以把返回的 `graphRef` 传给 `read_file`。不要根据任何 ID 自行拼接 `_graph` 路径。

## `expand_graph`

这个工具是可选项。Agent 需要直接使用 Developer OpenAPI 图扩展能力时实现。当前接口要求一个 `fileId` 作为起点。

按文件 ID 输入：

```json
{
  "fileId": "file_123",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

输出：

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

当 Agent 已经拿到有价值的文件、搜索结果、相关文件、图文件或图候选时使用这个工具。返回的 Markdown 文件需要先读取正文，再作为回答证据。

## `search_files`

在线 Agent 接入应把 `search_files` 实现为 `searchGeneratedFiles` 的轻量适配。静态导出的知识库可以使用 `_index/**` 做有界导航，但这些文件不能替代在线全文与混合搜索。

第一次请求发送用户的完整独立问题，并使用默认 `hybrid` 检索。Agent 最多再执行两轮后续搜索，每轮问题都必须从已读取的来源 Markdown 中派生。工具只返回来源文件候选，不返回回答证据。

输入：

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

输出：

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

回答前必须读取选中的 Markdown，并按 `fileId` 和 `path` 去重。搜索摘要、机器索引记录、关系描述和重排模型输出都只是发现线索。`searchStatus=no_candidates` 是成功的空结果；`SEARCH_TIMEOUT` 和 `SEARCH_UNAVAILABLE` 是错误，不能混为一谈。

## 错误结构

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

保留 `requestId`。`RATE_LIMITED` 遵循 `retryAfterSeconds`；游标被拒绝时不带游标重试；传输或依赖错误不能转换成空结果。
