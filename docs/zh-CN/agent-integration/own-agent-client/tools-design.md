---
title: Tools 设计
---

# Tools 设计

当开发者控制自己的 Agent client 或 runtime 时，使用这个页面。这种模式下，Agent 调用开发者注册的内置工具。

Skill 应该从 Agent 用户视角描述工具，只说明可见工具行为和知识证据规则。

## 推荐工具

| 工具 | 用途 | 必要输入 | 主要输出 |
| --- | --- | --- | --- |
| `list_tree` | 发现已配置知识库中的文件。 | 无 | `items`、`nextCursor` |
| `get_file` | 读取单个文件的安全元数据。 | `fileId` | 文件元数据 |
| `read_file` | 读取一个 Markdown 文件。 | `fileId` 或 `path` | Markdown 内容和 metadata |
| `read_related` | 读取一个生成页面的有界相关文件。 | `fileId` | 相关文件记录 |
| `expand_graph` | 从文件或查询词探索相关文件。 | `fileId` 或 `query` | 关系路径和文件读取动作 |
| `search_files` | 返回 Agent 生成的短查询短语对应的候选文件。 | `query` | `items`、`searchStatus`、`nextActions` |

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

按 `fileId` 调用 `read_file` 时，使用文件树、搜索、文件详情或可见 `generatedFileId` 字段返回的可读文件 ID。读取 `index.md`、`schema.md`、`log.md`、`_graph/index.md`、`_index/catalog.json`、返回的 `graphRef`、可见 `generatedFilePath` 或从链接发现的页面时，使用逻辑路径。

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

这个工具是可选项。Agent 也可以把返回的 `graphRef` 传给 `read_file`。不要通过生成文件 `fileId` 自行拼接该路径。

## `expand_graph`

这个工具是可选项。Agent 需要直接使用 Developer OpenAPI 图扩展能力时实现。每次调用只接收一个 seed。

按 file 输入：

```json
{
  "fileId": "file_123",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

按 query 输入：

```json
{
  "query": "renewal notice",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

输出：

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

当 Agent 已经拿到有价值的文件、搜索结果、相关文件、图文件或图候选时使用这个工具。返回的 Markdown 文件需要先读取正文，再作为回答证据。

## `search_files`

这个工具是可选项。Agent 需要候选查找时实现 `search_files`。后端可以调用 Focowiki Developer OpenAPI `searchGeneratedFiles`，读取生成索引文件，或接入自己的读取层。

第一次请求发送用户的完整独立问题，并使用默认 `hybrid` 检索。Agent 最多再执行两轮后续搜索，每轮问题都必须从已读取的来源 Markdown 中派生。工具只返回来源文件候选，不返回回答证据。

输入：

```json
{
  "query": "renewal notice",
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
      "description": "Short summary.",
      "score": 12,
      "matchedFields": ["content"],
      "evidenceTypes": ["content", "entity"],
      "sourceExcerpt": "Bounded source-grounded excerpt.",
      "readActions": {
        "fileContentById": "/openapi/v2/knowledge-bases/kb/files/file_123/content"
      }
    }
  ],
  "searchStatus": "ok",
  "message": null,
  "nextActions": [],
  "nextCursor": null
}
```

回答前必须读取选中的 Markdown 文件，并记录 `fileId` 和 `path` 以避免重复读取。搜索摘要、实体或关系描述、社区报告和 Reranker 输出都只是发现线索。

## 错误结构

```json
{
  "code": "file_not_found",
  "message": "The requested file was not found.",
  "requestId": "req_123"
}
```

知识库没有足够证据时，Agent 应该如实说明。
