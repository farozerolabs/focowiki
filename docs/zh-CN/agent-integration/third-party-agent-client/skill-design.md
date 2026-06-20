---
title: Skill 设计
---

# Skill 设计

开发者要把 Skill 用在第三方 Agent 客户端里时，参考这个页面。这种模式下，Agent 客户端无法注册开发者自己的内置工具。Skill 通过 HTTP 请求读取开发者提供的只读知识库端点。

## 为什么需要这种模式

有些 Agent 客户端支持 instructions 和 HTTP access，但不支持注册自定义工具。只读 HTTP 端点可以让 Skill 查询已配置知识库，同时不要求第三方 Agent 客户端接入私有工具 API。

端点只暴露 Skill 使用的读取操作。

## 为什么使用 loop

知识库问题经常需要读取多个文件。loop 会让 Agent 先查看概览，发现候选文件，读取有价值的文件，再从正文、标题、链接、metadata 和图关系里提取新的线索，继续通过搜索、文件树、Markdown links、相关文件或图关系探索。

这种设计有四个直接收益：

- 减少只读一个文件就回答的问题，尤其适合需要相关文件补充上下文的提问。
- 让 Agent 能沿着 Markdown links、文件树、搜索候选和图关系继续探索。
- 控制上下文规模，因为 Agent 会增量读取有价值的文件。
- 让最终回答有更清晰的证据，因为 Agent 会记录已读取内容、新线索和剩余证据缺口。

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
| 按生成文件 ID 读取内容 | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"` |
| 按 path 读取内容 | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"` |
| 按 path 读取图关系 | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=_graph/by-file/{fileId}.json"` |
| 读取相关文件 | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"` |
| 搜索候选文件 | `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=<agent-generated phrase>" --data-urlencode "limit=10"` |

这些 URL 是开发者提供给 Agent 的读取接口。

`/search` endpoint 返回 Agent 短查询短语对应的文件级排序候选。查询规划由 Agent 在 loop 中完成。生成 search index 没有可用候选或不可用时，endpoint 可以返回 `searchStatus`、`message` 和 `nextActions`。

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

## Required Reading

At the start of every Skill run, read these reference files in full before making HTTP requests:

1. `references/http-contract.md`
2. `references/exploration-workflow.md`
3. `references/answer-style.md`

Use them for request shapes, exploration rounds, stop conditions, citation style, and answer style.

## Curl Commands

- List files: `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"`
- Read metadata: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}"`
- Read content by generated file ID: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`
- Read content by path: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`
- Read graph by path: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=_graph/by-file/{fileId}.json"`
- Read related files: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"`
- Search candidates: `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=<agent-generated phrase>" --data-urlencode "limit=10"`

## Process

Use an exploration loop before answering:

1. Read all files listed in Required Reading in full.
2. Request `/files/content?path=index.md` for broad context.
3. Request `/files/content?path=schema.md` when metadata fields are unclear.
4. Derive an initial set of concise search phrases from the user question and visible knowledge-base context.
5. Keep a short evidence plan with the evidence target, initial search phrases, known paths, expansion strategy, and stop condition.
6. Alternate breadth and depth: discover candidates, read useful files, extract new terms or paths from what was read, then discover again.
7. Use `/search`, `/tree`, Markdown links, `/files/{fileId}/related`, or `_graph/by-file/{fileId}.json` as the next discovery action.
8. Read useful candidates that can close the current evidence gap.
9. Track visited `fileId` and `path` values to avoid repeated reads.
10. After each file read, record `discovery`, `read`, `new leads`, `evidence`, and `remaining gap`.
11. When `/search` returns `no_candidates`, `index_unavailable`, or an empty candidate list, follow `nextActions`, shorten or broaden the phrase, inspect `index.md`, list the tree, or read graph context.
12. Continue while new leads or remaining gaps can expand scope, add depth, identify comparison targets, find source evidence, surface exceptions, or clarify context.
13. Stop only when the stop conditions in `references/exploration-workflow.md` are met.
14. Cite file titles or paths in the final answer.

## Identifier Rules

- Prefer logical `path` for Markdown content reads.
- Use `fileId` for metadata, related files, graph lookup, or content reads only when no path is available.
- When a result includes both `fileId` and `path`, read Markdown content by path first.

## Scope

- Use knowledge-base files as the evidence source.
- Answer with citations from file titles or paths.
- Say when the available knowledge-base files do not contain enough evidence.
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

## Content by generated file ID

Command: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`

Response: `fileId`, `path`, `title`, `content`, `metadata`

## Graph by file

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=_graph/by-file/{fileId}.json"`

Response: related file records with `path`, `title`, `relationType`, `direction`, `weight`, and `reason`

## Related files

Command: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"`

Response: bounded related file entries and `nextCursor`

## Search

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=<agent-generated phrase>" --data-urlencode "limit=10"`

Response: `items`, `nextCursor`, `searchStatus`，可选 `message`，可选 `nextActions`

Candidate entries can include `score`, `matchedTerms`, `matchedFields`, `fileId`, and `path`. The Agent creates the search phrase from the user question, visible knowledge-base context, already-read files, and remaining evidence gaps. After reading useful files, the Agent updates its phrase list, path list, related candidates, and remaining gap. When `searchStatus` is `no_candidates` or `index_unavailable`, follow `nextActions`, read `index.md`, list the tree, try another phrase, or inspect graph context.
```

## `references/exploration-workflow.md`

```md
# Exploration Workflow

## Query Planning

The Agent owns query planning. Before using `/search`, derive an initial set of concise phrases from the user question and visible knowledge-base context. Prefer terms that are explicit in the user request or already visible in the knowledge base.

Search one phrase at a time. Treat results as candidates, then read files to confirm evidence. After reading, extract new phrases, paths, links, titles, headings, metadata terms, graph relations, and remaining gaps from the content. Use those leads to continue exploration.

Do not send the full user question as the only search query. When search returns no candidates or an unavailable index, continue with index, tree, shorter phrases, graph, or related-file exploration.

## Exploration Plan

Before starting the loop, create a short plan in working notes:

- `evidence target`: what the answer must prove or summarize.
- `initial search phrases`: Agent-derived phrases to try one at a time.
- `known paths`: paths discovered from `index.md`, `schema.md`, links, or previous reads.
- `expansion strategy`: how to alternate broad discovery and deep reading when new leads or gaps appear.
- `stop condition`: what evidence is enough to answer.

Record the initial search phrases before the first search request. Update the phrase list and path list after each useful read.

## Evidence Loop

Use this loop before answering any substantive question.

1. Restate the user question as a short evidence target.
2. Start with `index.md` when the knowledge base scope is unclear.
3. Derive initial search phrases when the question contains a concrete concept, title, product, date, status, version, owner, or named entity.
4. Write the exploration plan.
5. Start with a broad discovery action unless an exact path is already known.
6. Use a discovery action to build a candidate set from search, tree, links, related files, or graph records.
7. Read useful candidates that can close the current gap, using logical `path` when present or `fileId` when no path is available.
8. Extract new leads from the content, including titles, headings, terms, paths, links, graph records, and unresolved gaps.
9. Record `discovery`, `read`, `new leads`, `evidence`, and `remaining gap` for the round.
10. Continue when new leads or remaining gaps can expand breadth, add depth, identify comparison targets, find source evidence, surface exceptions, or clarify scope.
11. Keep a visited list of `fileId` and `path` values.
12. Answer after the stop conditions are satisfied.

## Exploration Loop

Use explicit breadth-depth rounds. Continue or stop based on evidence quality, new leads, and remaining gaps.

- Breadth: use search, tree, graph, related files, or links to find candidate files.
- Depth: read selected files and extract useful evidence.
- Expansion: turn the read content into new search phrases, paths, related files, or comparison targets.
- Repeat breadth and depth while new evidence changes the answer, adds missing scope, reveals important exceptions, or points to related files.

Simple definition or title lookup questions can stop after one file when the file directly answers it.

Before writing the final answer, confirm that the loop ended because a stop condition is satisfied. Do not stop only because one search request or one file read succeeded.

## Discovery Actions

- Use `index.md` for scope, available groups, and obvious paths.
- Use `schema.md` when metadata fields or file types are unclear.
- Use `/search` for concepts, titles, named entities, and terms from already-read files.
- Use `/tree` when search is weak, unavailable, or folder exploration is useful.
- Use graph files, related files, and Markdown links when they can close a remaining evidence gap.

## Search and Read

1. Run one search request per phrase.
2. Compare candidates against the current evidence gap.
3. Read useful candidates by logical `path` when present, or by `fileId` when no path is available.
4. After reading, update the phrase list, path list, related candidates, and remaining gap.
5. Continue through candidates while they add material evidence for comparison, obligation, risk, or cross-file questions.

## Stop Conditions

Stop only when one condition is true:

- The question is a simple title or definition lookup and one file fully answers it.
- The collected evidence covers the user's requested scope, comparison, exceptions, and source support.
- Search, tree, graph, links, and related reads return no additional relevant candidates for the remaining gap.
- Additional rounds repeat already-visited files or add no material evidence.
- The request asks for an action or information outside the available knowledge-base files.
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
- Use only visible knowledge-base content in the final answer.
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
User: What does the knowledge endpoint say about customer onboarding?

Terminal command:
curl -sS -G "https://knowledge.example.com/files/content" --data-urlencode "path=index.md"

Agent note:
Derived search phrases: `customer onboarding`, `workspace preparation`, `support handoff`.

Terminal command:
curl -sS -G "https://knowledge.example.com/search" --data-urlencode "query=workspace preparation" --data-urlencode "limit=10"

Terminal command:
curl -sS "https://knowledge.example.com/files/file_customer_onboarding/content"

Terminal command:
curl -sS -G "https://knowledge.example.com/search" --data-urlencode "query=support handoff" --data-urlencode "limit=10"

Terminal command:
curl -sS -G "https://knowledge.example.com/files/content" --data-urlencode "path=_graph/by-file/file_customer_onboarding.json"

Agent answer:
The customer onboarding process starts with account setup, then moves through profile completion, workspace preparation, first-task guidance, and support handoff. Evidence: `index.md`, `pages/customer-onboarding.md`.
```
