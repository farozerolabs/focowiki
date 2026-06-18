---
title: Skill 设计
---

# Skill 设计

开发者要把 Skill 用在第三方 Agent 客户端里时，参考这个页面。这种模式下，Agent 客户端无法注册开发者自己的内置工具。Skill 通过 HTTP 请求读取开发者提供的只读知识库端点。

## 为什么需要这种模式

有些 Agent 客户端支持 instructions 和 HTTP access，但不支持注册自定义工具。只读 HTTP 端点可以让 Skill 查询已配置知识库，同时不要求第三方 Agent 客户端接入私有工具 API。

端点只应该暴露 Skill 需要的读取操作。不要把服务凭据写进 Skill。如果端点需要鉴权，使用第三方 Agent 客户端提供的 secret management 机制。

## Endpoint 形态

只读知识库端点使用一个 base URL：

```text
https://knowledge.example.com
```

推荐终端命令：

| 动作 | Curl command |
| --- | --- |
| 列出文件 | `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"` |
| 读取元数据 | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}"` |
| 按 ID 读取内容 | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"` |
| 按 path 读取内容 | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"` |
| 按 path 读取图关系 | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=_graph/by-file/{fileId}.json"` |
| 读取相关文件 | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"` |
| 搜索文件 | `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"` |

这些 URL 是开发者提供给 Agent 的读取接口。

`/search` endpoint 属于开发者提供的只读接口。Focowiki Developer OpenAPI 不直接提供 `/search` 路由。需要 Agent 搜索时，在你的后端实现这个端点，常见方式是读取生成的 `_index/search.json` 文件，或接入你自己的搜索层。

## 文件设计

```text
focowiki-knowledge-http/
├── SKILL.md
└── references/
    ├── http-contract.md
    ├── exploration-workflow.md
    └── answer-style.md
```

## `SKILL.md`

```md
---
name: focowiki-knowledge-http
description: Use when the user asks questions that should be answered from the configured knowledge endpoint.
---

# Focowiki Knowledge HTTP

Use HTTP requests to query the configured knowledge endpoint.

## Knowledge Endpoint

Base URL: `https://knowledge.example.com`

## When To Use

Use this Skill when the user asks about knowledge-base content, asks to inspect files, or asks for answers with file citations.

## Curl Commands

- List files: `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"`
- Read metadata: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}"`
- Read content by ID: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`
- Read content by path: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`
- Read graph by path: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=_graph/by-file/{fileId}.json"`
- Read related files: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"`
- Search files: `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"`

## Process

1. Request `/files/content?path=index.md` for broad context.
2. Request `/files/content?path=schema.md` when metadata fields are unclear.
3. Request `/search?query=...` for direct questions when search is available.
4. Request `/tree` when search is unavailable or incomplete.
5. Read one file at a time.
6. Read the page `graph` reference or `_graph/by-file/{fileId}.json` when related context is needed.
7. Follow Markdown links and graph relationships when they add evidence.
8. Cite file titles or paths in the final answer.

## Boundaries

- Use only read-only `curl` requests described in this Skill.
- Do not expose credentials, tokens, storage paths, or internal service details.
- Do not use write, delete, admin, or key-management endpoints.
```

## `references/http-contract.md`

```md
# HTTP Contract

## Tree

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"`

Response: `items`, `nextCursor`

## Content by path

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`

Response: `fileId`, `path`, `title`, `content`, `metadata`

## Content by ID

Command: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`

Response: `fileId`, `path`, `title`, `content`, `metadata`

## Graph by file

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=_graph/by-file/{fileId}.json"`

Response: related file records with `path`, `title`, `relationType`, `direction`, `weight`, and `reason`

## Related files

Command: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"`

Response: bounded related file entries and `nextCursor`

## Search

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"`

Response: `items`, `nextCursor`
```

## `references/exploration-workflow.md`

```md
# Exploration Workflow

## Broad Questions

1. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`.
2. Read the returned title, content summary, and links.
3. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=schema.md"` when metadata fields are unclear.
4. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"` to inspect available pages.
5. Request one relevant file content endpoint with `curl`.
6. Read the page `graph` reference or `_graph/by-file/{fileId}.json` when relationship context is useful.
7. Follow Markdown links only when they help answer the user request.

## Direct Questions

1. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"` when search is available.
2. Read the top candidate file with `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`.
3. Request another candidate with `curl` only when the first file does not contain enough evidence.
4. Read `_graph/by-file/{fileId}.json` or `/files/{fileId}/related` when related context is needed.
5. Follow related page paths returned by the graph file.

## Stop Conditions

- Stop when enough file evidence answers the user request.
- Stop when the endpoint returns no relevant candidates.
- Stop when repeated files or links do not add new evidence.
```

## `references/answer-style.md`

```md
# Answer Style

## Evidence

- Use only content returned by the knowledge endpoint.
- Cite file titles or paths used as evidence.
- Mention when the available files do not answer the question.

## Response

- Answer the user request directly.
- Keep the answer concise.
- Separate confirmed file evidence from interpretation.
- Do not expose endpoint credentials, hidden headers, or internal service details.
```

## 响应示例

Tree response：

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

Content response：

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

## Agent 会话示例

```text
User: What does the knowledge endpoint say about the upload lifecycle?

Terminal command:
curl -sS -G "https://knowledge.example.com/files/content" --data-urlencode "path=index.md"

Terminal command:
curl -sS -G "https://knowledge.example.com/search" --data-urlencode "query=upload lifecycle" --data-urlencode "limit=10"

Terminal command:
curl -sS "https://knowledge.example.com/files/file_upload_lifecycle/content"

Terminal command:
curl -sS -G "https://knowledge.example.com/files/content" --data-urlencode "path=_graph/by-file/file_upload_lifecycle.json"

Agent answer:
The upload lifecycle starts with Markdown submission, then runs parsing, knowledge package generation, validation, index publishing, and activation. Evidence: `index.md`, `pages/upload-lifecycle.md`.
```
