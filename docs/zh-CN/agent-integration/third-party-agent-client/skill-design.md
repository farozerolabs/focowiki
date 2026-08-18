---
title: Skill 设计
---

# Skill 设计

本页适用于第三方 Agent 客户端能够执行 Skill 指令并发送 HTTP 请求，但不能注册自定义工具的场景。

可安装的 Skill 面向最终回答用户问题的 Agent，只暴露只读知识端点和证据工作流。产品实现、索引、存储、服务商、认证配置以及上游响应归一化均保留在开发者维护的适配层中。

## 设计目标

- 使用一个由开发者提供的基础 URL。
- 不知道相关文件时先搜索。
- 候选结果必须读取原文后才能作为证据。
- 仅在能够补齐证据缺口时继续跟随链接或相关文件。
- 控制探索范围。
- 引用实际支持答案的文件标题或路径。

## 端点形式

开发者提供一个只读基础 URL：

```text
https://knowledge.example.com
```

适配层可以要求认证，但凭据应放在 Agent 客户端的安全配置中，禁止写入 Skill。

## 文件设计

```text
knowledge-base-http/
├── SKILL.md
└── references/
    ├── http-contract.md
    ├── exploration-workflow.md
    └── answer-style.md
```

## `SKILL.md`

```md
---
name: knowledge-base-http
description: Use when a question should be answered from the configured read-only knowledge endpoint.
---

# Knowledge Base HTTP

Use the configured read-only endpoint to find and read knowledge-base files.

## Configuration

Base URL: `$KNOWLEDGE_BASE_URL`

The host provides any required credentials securely.

## When To Use

Use this Skill when the user asks about knowledge-base content, asks to inspect a file, or requests an answer supported by file citations.

## Required Reading

Read these references before making requests:

1. `references/http-contract.md`
2. `references/exploration-workflow.md`
3. `references/answer-style.md`

## Process

1. Restate the user's request as one complete, standalone question.
2. Search with that question unless an exact file path is already known.
3. Treat search results as candidates, not evidence.
4. Read the most useful candidate files in full.
5. Track visited file IDs and paths so the same file is not read twice.
6. If evidence is incomplete, follow relevant Markdown links, related files, or relationship expansion from a file already read.
7. Run at most two follow-up searches, and derive each one from a concrete gap found in the source files.
8. If search returns no useful candidate, inspect the root index or browse the tree.
9. Stop when the files cover the question, no new relevant lead remains, or two follow-up rounds are complete.
10. Answer only from file content that was actually read.
11. Cite the supporting file titles or paths.

## Identifier Rules

- Reuse IDs and paths exactly as returned by the endpoint.
- Prefer a returned path when following a Markdown link.
- Never invent an ID or path.

## Limits

- Do not treat search snippets or relationship summaries as final evidence.
- Do not invent missing facts or metadata.
- Say when the available files are insufficient.
```

## `references/http-contract.md`

````md
# HTTP Contract

Use `$KNOWLEDGE_BASE_URL` as the base URL for every request.

## Search

```text
GET /search?query=<complete-question>&limit=10
```

Returns candidate files and an optional next cursor. A successful empty result means no candidate was found. Request failures must remain failures.

## Read Content

By returned file ID:

```text
GET /files/{fileId}/content
```

By returned path:

```text
GET /files/content?path={path}
```

Returns the file's visible metadata and full content.

## Browse Tree

```text
GET /tree?parentPath={path}&limit=50
```

Returns files, folders, and an optional next cursor.

## Read Metadata

```text
GET /files/{fileId}
```

Returns visible metadata for the requested file.

## Related Files

```text
GET /files/{fileId}/related?limit=20
```

Returns bounded related-file candidates and an optional next cursor.

## Expand Relationships

```text
GET /graph/expand?fileId={fileId}&depth=1&fanout=10
```

Returns bounded relationship candidates and an optional next cursor. Read the referenced files before using them as evidence.
````

## `references/exploration-workflow.md`

```md
# Exploration Workflow

## Initial Discovery

Use the complete user question for the first search. If the user names an exact path, read that file first. If the scope is unclear, inspect `index.md` or browse the tree.

## Evidence Loop

1. Define what the answer must establish.
2. Discover candidate files.
3. Read the useful candidates.
4. Record confirmed evidence and the remaining gap.
5. Follow a source link or relationship only when it can close that gap.
6. Use no more than two follow-up searches.
7. Stop when the evidence is sufficient or exploration no longer adds useful files.

Keep a visited set of file IDs and paths. A simple definition or title lookup may stop after one file when that file answers the question completely.

## Stop Conditions

Stop when any condition is true:

- The read files fully answer the requested scope.
- No unvisited relevant candidate remains.
- Additional exploration repeats known files or adds no material evidence.
- Two source-derived follow-up searches are complete.
- The request falls outside the available files.
```

## `references/answer-style.md`

```md
# Answer Style

## Evidence

- Use only content from files that were read.
- Cite supporting file titles or paths.
- Separate confirmed evidence from interpretation.

## Response

- Answer the user's question directly.
- Keep the answer focused.
- Mention important disagreement or uncertainty between files.
- State when the available files are insufficient.

## Limits

- Do not invent missing facts.
- Do not claim complete coverage when only part of the knowledge base was inspected.
```

## Agent Session Example

```text
User: What does the knowledge base say about customer onboarding?

Request:
GET /search?query=What%20does%20the%20knowledge%20base%20say%20about%20customer%20onboarding%3F&limit=10

Request:
GET /files/content?path=pages%2Fcustomer-onboarding.md

Request:
GET /files/file_customer_onboarding/related?limit=20

Agent answer:
The onboarding process starts with account setup, then covers workspace preparation and support handoff. Evidence: `pages/customer-onboarding.md`.
```
