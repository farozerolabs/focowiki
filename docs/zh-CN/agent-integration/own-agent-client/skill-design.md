---
title: Skill 设计
---

# Skill 设计

开发者控制自己的 Agent client 时，可以把知识库读取能力注册成内置 tools。这个 Skill 面向 Agent 用户问题本身，指导 Agent 在需要查询知识库时调用已注册的 tools。

Skill 内容聚焦知识探索、证据记录和引用方式。

## 为什么使用 loop

知识库问题经常需要读取多个文件。loop 会让 Agent 先查看概览，发现候选文件，读取有价值的文件，再从正文、标题、链接、metadata 和图关系里提取新的线索，继续通过搜索、文件树、Markdown links、相关文件或图关系探索。

这种设计有四个直接收益：

- 减少只读一个文件就回答的问题，尤其适合需要相关文件补充上下文的提问。
- 让 Agent 能沿着 Markdown links、文件树、搜索候选和图关系继续探索。
- 控制上下文规模，因为 Agent 会增量读取有价值的文件。
- 让最终回答有更清晰的证据，因为 Agent 会记录已读取内容、新线索和剩余证据缺口。

## 文件设计

```text
focowiki-knowledge-tools/
├── SKILL.md
└── references/
    ├── tool-contract.md
    ├── exploration-workflow.md
    └── answer-style.md
```

## `SKILL.md`

```md
---
name: focowiki-knowledge-tools
description: Use when the user asks questions that should be answered from the configured knowledge base.
---

# Focowiki Knowledge Tools

Use the registered knowledge-base tools to inspect files, read Markdown content, follow file links, and explore graph relationships.

## When To Use

Use this Skill when the user asks about knowledge-base content, asks to inspect files, or asks for answers with file citations.

## Required Reading

At the start of every Skill run, read these reference files in full before calling tools:

1. `references/tool-contract.md`
2. `references/exploration-workflow.md`
3. `references/answer-style.md`

Use them for tool inputs, exploration rounds, stop conditions, citation style, and answer style.

## Available Tools

- `list_tree`: discover files and folders in the configured knowledge base.
- `get_file`: read safe metadata for one file.
- `read_file`: read Markdown content by `fileId` or logical `path`.
- `read_related`: read bounded related files for a file.
- `search_files`: find candidate files for an Agent-generated search phrase when the host runtime provides search.

## Process

Use an exploration loop before answering:

1. Read all files listed in Required Reading in full.
2. Call `read_file` with `path: "index.md"` for broad context.
3. Call `read_file` with `path: "schema.md"` when metadata fields are unclear.
4. Derive an initial set of concise search phrases from the user question and visible knowledge-base context.
5. Keep a short evidence plan with the evidence target, initial search phrases, known paths, expansion strategy, and stop condition.
6. Alternate breadth and depth: discover candidates, read useful files, extract new terms or paths from what was read, then discover again.
7. Use `search_files`, `list_tree`, Markdown links, `read_related`, or `read_file` with `path: "_graph/by-file/{fileId}.json"` as the next discovery action.
8. Read useful candidates that can close the current evidence gap.
9. Track visited `fileId` and `path` values to avoid repeated reads.
10. After each file read, record `discovery`, `read`, `new leads`, `evidence`, and `remaining gap`.
11. When `search_files` returns `no_candidates`, `index_unavailable`, or an empty candidate list, follow `nextActions` when present, shorten or broaden the phrase, inspect `index.md`, list the tree, or read graph context.
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

## `references/tool-contract.md`

````md
# Tool Contract

The host Agent client registers these read-only tools. The Agent sees the tool names, inputs, and outputs.

## list_tree

Input:

```json
{
  "parentPath": "",
  "cursor": null,
  "limit": 50
}
```

Output: `items`, `nextCursor`

## get_file

Input:

```json
{
  "fileId": "file_123"
}
```

Output: file metadata with `fileId`, `path`, `title`, `type`, `description`, and `metadata`.

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

Output: `fileId`, `path`, `title`, `content`, and `metadata`.

Use logical paths for root files, linked pages, graph files, and visible generated file paths. Use readable file IDs for metadata, related files, graph lookup, or content reads only when no path is available.

## read_related

Input:

```json
{
  "fileId": "file_123",
  "cursor": null,
  "limit": 20
}
```

Output: bounded related file entries and `nextCursor`.

## search_files

Input:

```json
{
  "query": "workspace preparation",
  "cursor": null,
  "limit": 10
}
```

Output: candidate file entries, `searchStatus`, optional `message`, optional `nextActions`, and `nextCursor`.

Candidate entries can include `fileId`, `path`, `title`, `description`, `score`, and `matchedFields`.

`search_files` is optional. The Agent chooses search phrases from the user question, visible knowledge-base context, already-read files, and remaining evidence gaps. After reading useful files, the Agent updates its phrase list, path list, related candidates, and remaining gap. When `searchStatus` is `no_candidates` or `index_unavailable`, follow `nextActions`, read `index.md`, use `list_tree`, try another phrase, or inspect graph context.
````

## `references/exploration-workflow.md`

```md
# Exploration Workflow

## Query Planning

The Agent owns query planning. Before using `search_files`, derive an initial set of concise phrases from the user question and visible knowledge-base context. Prefer terms that are explicit in the user request or already visible in the knowledge base.

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
- Use `search_files` for concepts, titles, named entities, and terms from already-read files.
- Use `list_tree` when search is weak, unavailable, or folder exploration is useful.
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

- Use only content returned by the registered tools.
- Cite file titles or paths used as evidence.
- Mention when the available files do not answer the question.

## Response

- Answer the user request directly.
- Keep the answer concise.
- Separate confirmed file evidence from interpretation.
- Use only visible knowledge-base content in the final answer.

## Limits

- Do not invent missing metadata.
- Do not claim full coverage when only part of the tree was inspected.
- Ask for a narrower question when the request needs more files than the current context can support.
```

## Agent 会话示例

```text
User: What does the knowledge base say about customer onboarding?

Tool call:
read_file({ "path": "index.md" })

Agent note:
Derived search phrases: `customer onboarding`, `workspace preparation`, `support handoff`.

Tool call:
search_files({ "query": "customer onboarding", "limit": 10 })

Tool call:
read_file({ "fileId": "file_customer_onboarding" })

Tool call:
search_files({ "query": "workspace preparation", "limit": 10 })

Tool call:
read_related({ "fileId": "file_customer_onboarding", "limit": 20 })

Agent answer:
The customer onboarding process starts with account setup, then moves through profile completion, workspace preparation, first-task guidance, and support handoff. Evidence: `index.md`, `pages/customer-onboarding.md`.
```
