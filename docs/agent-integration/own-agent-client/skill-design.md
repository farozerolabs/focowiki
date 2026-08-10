---
title: Skill Design
---

# Skill Design

Use this page when developers control their own Agent client and can register knowledge-base tools. This Skill guides the Agent to use those tools when it needs knowledge-base evidence.

The Skill should stay focused on knowledge exploration, evidence tracking, and citation behavior.

## Why Use A Loop

Knowledge-base questions often need more than one file. A loop lets the Agent inspect the overview, discover candidate files, read selected files, extract new leads from the content, and continue exploration through search, tree entries, Markdown links, related files, or graph records.

This pattern gives the Skill four practical benefits:

- It reduces one-file answers when the question needs context from related files.
- It lets the Agent follow the knowledge base structure through Markdown links, tree entries, search candidates, and graph files.
- It keeps context bounded because the Agent reads useful files incrementally.
- It gives the final answer clearer evidence, since the Agent tracks what it read, what new leads appeared, and what evidence gap remains.

## File Design

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
- `expand_graph`: explore related files from a file or query when the host runtime provides relationship exploration.
- `search_files`: find candidate files for an Agent-generated search phrase when the host runtime provides search.

## Process

Use an exploration loop before answering:

1. Read all files listed in Required Reading in full.
2. Restate the user's request as one standalone natural-language question.
3. Run one initial `search_files` request with that complete question and default `hybrid` retrieval unless an explicit mode is required.
4. Treat results as candidates and read the top useful source Markdown files through returned file IDs, paths, or read actions.
5. Track visited `fileId` and `path` values and deduplicate every later file read.
6. If the source evidence remains incomplete, optionally use `read_related`, `expand_graph`, Markdown links, or a returned `graphRef`.
7. Run at most two follow-up search rounds, using only questions derived from terms, paths, links, headings, comparisons, or gaps found in source Markdown already read.
8. If initial retrieval is empty or scope remains unclear, read `index.md`, inspect the tree, or use `_index/*` before a bounded follow-up.
9. Record the source files read and the remaining evidence gap after each round.
10. Stop when source reads cover the requested scope, no new relevant source remains, or two follow-up rounds are complete.
11. Never use search snippets, entity or relationship descriptions, community reports, or reranker output as answer evidence.
12. Cite the source Markdown titles or paths used in the final answer.

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

`search_files` is optional. The Agent sends the complete standalone user question first. After reading useful source files, it may derive at most two bounded follow-up questions from those files and the remaining evidence gap. When `searchStatus` is `no_candidates`, follow `nextActions`, read `index.md`, use `list_tree`, try one source-derived follow-up, or inspect graph context. Handle 503 and 504 through the documented error envelope instead of treating them as empty search results.

## expand_graph

Input by file:

```json
{
  "fileId": "file_123",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

Input by query:

```json
{
  "query": "workspace preparation",
  "depth": 1,
  "fanout": 10,
  "cursor": null
}
```

Output: seed details, bounded relationship records, file paths, read actions, and `nextCursor`.

`expand_graph` is optional. Use it after a useful file, related record, graph record, or search candidate appears. Read returned Markdown files before using them as answer evidence.
````

## `references/exploration-workflow.md`

```md
# Exploration Workflow

## Query Planning

Send the complete standalone user question as the initial `hybrid` search. Treat results as candidates, read source Markdown to confirm evidence, and derive no more than two follow-up searches from those source reads. When search returns no candidates or an unavailable index, continue with `index.md`, the tree, graph exploration, or one bounded source-derived follow-up. Deduplicate every file read, and never use snippets or model-generated semantic text as final evidence.

## Exploration Plan

Before starting the loop, create a short plan in working notes:

- `evidence target`: what the answer must prove or summarize.
- `initial question`: the complete standalone natural-language question for the first hybrid search.
- `known paths`: paths discovered from `index.md`, `schema.md`, links, or previous reads.
- `expansion strategy`: how to alternate broad discovery and deep reading when new leads or gaps appear.
- `stop condition`: what evidence is enough to answer.

Record the initial question before the first search request. Track the source-derived follow-up questions and paths after each useful read.

## Evidence Loop

Use this loop before answering any substantive question.

1. Restate the user question as a short evidence target.
2. Start with `index.md` when the knowledge base scope is unclear.
3. Run the complete standalone question as the one initial hybrid search.
4. Write the exploration plan.
5. Start with a broad discovery action unless an exact path is already known.
6. Use a discovery action to build a candidate set from search, tree, `_index/*`, links, related files, graph expansion, or graph records.
7. Read useful candidates that can close the current gap, using logical `path` when present or `fileId` when no path is available.
8. Extract new leads from the content, including titles, headings, terms, paths, links, graph records, and unresolved gaps.
9. Record `discovery`, `read`, `new leads`, `evidence`, and `remaining gap` for the round.
10. Continue only when a source-derived lead can close a remaining gap and fewer than two follow-up rounds have run.
11. Keep a visited list of `fileId` and `path` values.
12. Answer after the stop conditions are satisfied.

## Exploration Loop

Use explicit breadth-depth rounds. Continue or stop based on evidence quality, new leads, and remaining gaps.

- Breadth: use search, tree, graph, related files, or links to find candidate files.
- Depth: read selected files and extract useful evidence.
- Expansion: turn the read content into new search phrases, paths, related files, or comparison targets.
- Repeat breadth and depth for no more than two source-derived follow-up rounds.

Simple definition or title lookup questions can stop after one file when the file directly answers it.

Before writing the final answer, confirm that the loop ended because a stop condition is satisfied. Do not stop only because one search request or one file read succeeded.

## Discovery Actions

- Use `index.md` for scope, available groups, and obvious paths.
- Use `schema.md` when metadata fields or file types are unclear.
- Use `_index/*` when generated index, link, tree, or manifest hints can narrow the next file read.
- Use `search_files` for concepts, titles, named entities, and terms from already-read files.
- Use `list_tree` when search is weak, unavailable, or folder exploration is useful.
- Use `expand_graph`, graph files, related files, and Markdown links when they can close a remaining evidence gap.

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

## Agent Session Example

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
