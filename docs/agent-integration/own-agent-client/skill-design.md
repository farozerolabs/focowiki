---
title: Skill Design
---

# Skill Design

Use this page when developers control their own Agent client or runtime and can register knowledge-base tools. This Skill guides the Agent to call registered tools when it needs knowledge-base evidence.

HTTP requests, OpenAPI keys, Focowiki service URLs, and backend adapter logic belong in the developer-owned runtime. The Skill exposes only the tool usage pattern to the Agent.

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

## Available Tools

- `list_tree`: discover files and folders in the configured knowledge base.
- `get_file`: read safe metadata for one file.
- `read_file`: read Markdown content by `fileId` or logical `path`.
- `read_related`: read bounded related files for a file.
- `search_files`: find candidate files for a question when the host runtime provides search.

## Process

1. Call `read_file` with `path: "index.md"` for broad questions.
2. Call `read_file` with `path: "schema.md"` when metadata fields are unclear.
3. Call `search_files` for direct questions when the tool is available.
4. Call `list_tree` when search is unavailable or incomplete.
5. Read one relevant file at a time with `read_file`.
6. Call `read_related` or read `_graph/by-file/{fileId}.json` when related context is needed.
7. Follow Markdown links and graph relationships when they add evidence.
8. Cite file titles or paths in the final answer.

## Boundaries

- Use only the registered read-only tools described in this Skill.
- Do not expose credentials, tokens, storage paths, service URLs, or internal service details.
- Do not use write, delete, admin, or key-management tools unless the host runtime explicitly registers separate tools for those workflows.

## References

- `references/tool-contract.md`
- `references/exploration-workflow.md`
- `references/answer-style.md`
```

## `references/tool-contract.md`

````md
# Tool Contract

The host Agent client registers these read-only tools. Tool implementations may call a backend, cache results, enforce credentials, or read Focowiki OpenAPI. The Agent only sees the tool names, inputs, and outputs.

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
  "query": "upload lifecycle",
  "cursor": null,
  "limit": 10
}
```

Output: candidate file entries and `nextCursor`.

`search_files` is optional. Use `list_tree` and graph exploration when search is unavailable.
````

## `references/exploration-workflow.md`

```md
# Exploration Workflow

## Broad Questions

1. Call `read_file` with `path: "index.md"`.
2. Read the returned title, summary, and links.
3. Call `read_file` with `path: "schema.md"` when metadata fields are unclear.
4. Call `list_tree` with `parentPath: ""` and `limit: 50` to inspect available pages.
5. Read one relevant candidate file with `read_file`.
6. Call `read_related` or read `_graph/by-file/{fileId}.json` when relationship context is useful.
7. Follow Markdown links only when they help answer the user request.

## Direct Questions

1. Call `search_files` with the user question when search is available.
2. Read the top candidate with `read_file`.
3. Read another candidate only when the first file does not contain enough evidence.
4. Call `read_related` when related context is needed.
5. Follow related page paths returned by graph data.

## File Inspection

1. Call `get_file` when only metadata is needed.
2. Call `read_file` when Markdown content is needed.
3. Call `list_tree` with `parentPath: "pages"` for folder exploration.

## Stop Conditions

- Stop when enough file evidence answers the user request.
- Stop when search or tree results return no relevant candidates.
- Stop when repeated files or links do not add new evidence.
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
- Do not expose endpoint credentials, hidden headers, storage paths, or internal service details.

## Limits

- Do not invent missing metadata.
- Do not claim full coverage when only part of the tree was inspected.
- Ask for a narrower question when the request needs more files than the current context can support.
```

## Agent Session Example

```text
User: What does the knowledge base say about the upload lifecycle?

Tool call:
read_file({ "path": "index.md" })

Tool call:
search_files({ "query": "upload lifecycle", "limit": 10 })

Tool call:
read_file({ "fileId": "file_upload_lifecycle" })

Tool call:
read_related({ "fileId": "file_upload_lifecycle", "limit": 20 })

Agent answer:
The upload lifecycle starts with Markdown submission, then runs parsing, knowledge package generation, validation, index publishing, and activation. Evidence: `index.md`, `pages/upload-lifecycle.md`.
```
