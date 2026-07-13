---
title: Skill Design
---

# Skill Design

Use this page when developers want a Skill that runs inside a third-party Agent client. In this mode, the Agent client cannot register the developer's built-in tools. The Skill uses HTTP requests to read from a developer-provided read-only knowledge endpoint.

## Why This Mode Exists

Some Agent clients support instructions and HTTP access, but do not support custom tool registration. A read-only HTTP endpoint lets the Skill query the configured knowledge base without requiring the third-party Agent client to integrate a private tool API.

The endpoint should expose the read operations used by the Skill.

## Why Use A Loop

Knowledge-base questions often need more than one file. A loop lets the Agent inspect the overview, discover candidate files, read selected files, extract new leads from the content, and continue exploration through search, tree entries, Markdown links, related files, or graph records.

This pattern gives the Skill four practical benefits:

- It reduces one-file answers when the question needs context from related files.
- It lets the Agent follow the knowledge base structure through Markdown links, tree entries, search candidates, and graph files.
- It keeps context bounded because the Agent reads useful files incrementally.
- It gives the final answer clearer evidence, since the Agent tracks what it read, what new leads appeared, and what evidence gap remains.

## Endpoint Shape

Use one base URL for the read-only knowledge endpoint:

```text
https://knowledge.example.com
```

Recommended terminal commands:

| Action | Curl command |
| --- | --- |
| List files | `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"` |
| Read metadata | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}"` |
| Read content by generated file ID | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"` |
| Read content by path | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"` |
| Read graph by path | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path={graphRef}"` |
| Read related files | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"` |
| Expand graph | `curl -sS -G "$KNOWLEDGE_BASE_URL/graph/expand" --data-urlencode "fileId={fileId}" --data-urlencode "depth=1" --data-urlencode "fanout=10"` |
| Search candidates | `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=<agent-generated phrase>" --data-urlencode "limit=10"` |

These URLs are the developer-provided read interface for the Agent.

The `/search` endpoint returns ranked file-level candidates for short phrases chosen by the Agent. Query planning stays inside the Agent loop. The endpoint can return `searchStatus`, `message`, and `nextActions` when the generated search index has no useful candidate or is unavailable.

## File Design

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
- Read graph by path: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path={graphRef}"`
- Read related files: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"`
- Expand graph: `curl -sS -G "$KNOWLEDGE_BASE_URL/graph/expand" --data-urlencode "fileId={fileId}" --data-urlencode "depth=1" --data-urlencode "fanout=10"`
- Search candidates: `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=<agent-generated phrase>" --data-urlencode "limit=10"`

## Process

Use an exploration loop before answering:

1. Read all files listed in Required Reading in full.
2. Request `/files/content?path=index.md` for broad context.
3. Request `/files/content?path=schema.md` when metadata fields are unclear.
4. Inspect `_index/*` or the file tree when the question needs generated index, link, or directory context.
5. Derive an initial set of concise search phrases from the user question and visible knowledge-base context.
6. Keep a short evidence plan with the evidence target, initial search phrases, known paths, expansion strategy, and stop condition.
7. Alternate breadth and depth: discover candidates, read useful files, extract new terms or paths from what was read, then discover again.
8. Use `/search`, `/tree`, Markdown links, `/files/{fileId}/related`, `/graph/expand`, or a returned `graphRef` as the next discovery action.
9. Read useful candidates that can close the current evidence gap.
10. Track visited `fileId` and `path` values to avoid repeated reads.
11. After each file read, record `discovery`, `read`, `new leads`, `evidence`, and `remaining gap`.
12. When `/search` returns `no_candidates`, `index_unavailable`, or an empty candidate list, follow `nextActions`, shorten or broaden the phrase, inspect `index.md`, list the tree, or read graph context.
13. Continue while new leads or remaining gaps can expand scope, add depth, identify comparison targets, find source evidence, surface exceptions, or clarify context.
14. Stop only when the stop conditions in `references/exploration-workflow.md` are met.
15. Cite file titles or paths in the final answer.

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

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path={graphRef}"`

Use the `graphRef` returned by page metadata or search. Do not construct this path from a generated `fileId`.

Response: related file records with `path`, `title`, `relationType`, `direction`, `weight`, and `reason`

## Graph expansion

Command by file: `curl -sS -G "$KNOWLEDGE_BASE_URL/graph/expand" --data-urlencode "fileId={fileId}" --data-urlencode "depth=1" --data-urlencode "fanout=10"`

Command by query: `curl -sS -G "$KNOWLEDGE_BASE_URL/graph/expand" --data-urlencode "query=<agent-generated phrase>" --data-urlencode "depth=1" --data-urlencode "fanout=10"`

Response: seed details, bounded relationship records, file paths, read actions, and `nextCursor`.

Use graph expansion after a useful file, related record, graph record, or search candidate appears. Read returned Markdown files before using them as answer evidence.

## Related files

Command: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/related?limit=20"`

Response: bounded related file entries and `nextCursor`

## Search

Command: `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=<agent-generated phrase>" --data-urlencode "limit=10"`

Response: `items`, `nextCursor`, `searchStatus`, optional `message`, optional `nextActions`

Candidate entries can include `score`, `matchedFields`, `fileId`, and `path`. The Agent creates the search phrase from the user question, visible knowledge-base context, already-read files, and remaining evidence gaps. After reading useful files, the Agent updates its phrase list, path list, related candidates, and remaining gap. When `searchStatus` is `no_candidates` or `index_unavailable`, follow `nextActions`, read `index.md`, list the tree, try another phrase, or inspect graph context.
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
6. Use a discovery action to build a candidate set from search, tree, `_index/*`, links, related files, graph expansion, or graph records.
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
- Use `_index/*` when generated index, link, tree, or manifest hints can narrow the next file read.
- Use `/search` for concepts, titles, named entities, and terms from already-read files.
- Use `/tree` when search is weak, unavailable, or folder exploration is useful.
- Use `/graph/expand`, graph files, related files, and Markdown links when they can close a remaining evidence gap.

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

## Response Examples

Tree response:

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

Content response:

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

## Agent Session Example

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
