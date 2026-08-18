---
title: Skill 设计
---

# Skill 设计

本页适用于开发者能够控制自己的 Agent 客户端，并可注册只读知识库工具的场景。

可安装的 Skill 面向最终回答用户问题的 Agent，因此不包含产品实现、存储结构、索引生命周期、服务商配置、认证细节或后端响应字段。这些内容由宿主适配层负责，并向 Agent 提供下方的小型工具契约。

## 设计目标

- 不知道相关文件时先搜索。
- 候选结果必须读取原文后才能作为证据。
- 仅在能够补齐证据缺口时继续跟随链接或相关文件。
- 控制探索范围，避免读取整个知识库。
- 引用实际支持答案的文件标题或路径。
- 现有文件证据不足时明确说明。

## 文件设计

```text
knowledge-base-tools/
├── SKILL.md
└── references/
    ├── tool-contract.md
    ├── exploration-workflow.md
    └── answer-style.md
```

## `SKILL.md`

```md
---
name: knowledge-base-tools
description: Use when a question should be answered from the configured knowledge base.
---

# Knowledge Base Tools

Use the registered read-only tools to find and read knowledge-base files.

## When To Use

Use this Skill when the user asks about knowledge-base content, asks to inspect a file, or requests an answer supported by file citations.

## Required Reading

Read these references before using the tools:

1. `references/tool-contract.md`
2. `references/exploration-workflow.md`
3. `references/answer-style.md`

## Available Tools

- `search_files`: find candidate files for a complete question.
- `read_file`: read the full content of a file by returned ID or path.
- `list_tree`: browse files and folders.
- `get_file`: inspect one file's visible metadata.
- `read_related`: find files related to a file already read.
- `expand_graph`: explore bounded relationships from a file already read.

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

- Reuse IDs and paths exactly as returned by the tools.
- Prefer a returned path when following a Markdown link.
- Never invent an ID or path.

## Limits

- Do not treat search snippets or relationship summaries as final evidence.
- Do not invent missing facts or metadata.
- Say when the available files are insufficient.
```

## `references/tool-contract.md`

````md
# Tool Contract

The host registers read-only tools with the following Agent-facing behavior.

## search_files

Input:

```json
{
  "query": "How is a new workspace prepared?",
  "cursor": null,
  "limit": 10
}
```

Returns candidate files and an optional next cursor. A successful empty result means no candidate was found. Tool errors must remain errors.

## read_file

Input by ID:

```json
{
  "fileId": "file_123"
}
```

Input by path:

```json
{
  "path": "index.md"
}
```

Returns the file's visible metadata and full content.

## list_tree

Input:

```json
{
  "parentPath": "",
  "cursor": null,
  "limit": 50
}
```

Returns files, folders, and an optional next cursor.

## get_file

Input:

```json
{
  "fileId": "file_123"
}
```

Returns visible metadata for the requested file.

## read_related

Input:

```json
{
  "fileId": "file_123",
  "cursor": null,
  "limit": 20
}
```

Returns bounded related-file candidates and an optional next cursor.

## expand_graph

Input:

```json
{
  "fileId": "file_123",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
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

Tool call:
search_files({ "query": "What does the knowledge base say about customer onboarding?", "limit": 10 })

Tool call:
read_file({ "path": "pages/customer-onboarding.md" })

Tool call:
read_related({ "fileId": "file_customer_onboarding", "limit": 20 })

Agent answer:
The onboarding process starts with account setup, then covers workspace preparation and support handoff. Evidence: `pages/customer-onboarding.md`.
```
