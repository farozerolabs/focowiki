---
title: Skill Design
---

# Skill Design

Use this page when developers want a Skill for their own Agent client. The default design uses terminal `curl` commands against a developer-provided read-only knowledge endpoint. It does not require Node.js, npm packages, or local helper scripts.

## File Design

```text
focowiki-knowledge/
├── SKILL.md
└── references/
    ├── curl-contract.md
    ├── exploration-workflow.md
    └── answer-style.md
```

The Skill is pure Markdown. The Agent reads the instructions and uses terminal `curl` commands to query the knowledge endpoint.

The `/search` examples refer to a developer-provided read-only endpoint. Focowiki Developer OpenAPI does not expose `/search` directly. Implement this endpoint in your backend when Agent search is needed, commonly by reading the generated `_index/search.json` file or by using your own search layer.

## `SKILL.md`

```md
---
name: focowiki-knowledge
description: Use when the user asks questions that should be answered from the configured knowledge base.
---

# Focowiki Knowledge

Use terminal `curl` commands to query the configured read-only knowledge endpoint.

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

1. Read `index.md` for broad questions.
2. Read `schema.md` when metadata fields are unclear.
3. Use `/search` for direct questions when search is available.
4. Use `/tree` when search is unavailable or incomplete.
5. Read one file at a time.
6. Read the page `graph` reference or `_graph/by-file/{fileId}.json` when related context is needed.
7. Follow Markdown links and graph relationships when they add evidence.
8. Cite file titles or paths in the final answer.

## Boundaries

- Use only read-only `curl` requests described in this Skill.
- Do not expose credentials, tokens, storage paths, or internal service details.
- Do not use write, delete, admin, or key-management endpoints.

## References

- `references/curl-contract.md`
- `references/exploration-workflow.md`
- `references/answer-style.md`
```

## `references/curl-contract.md`

````md
# Curl Contract

Set the endpoint before running commands:

```bash
KNOWLEDGE_BASE_URL="https://knowledge.example.com"
```

## Tree

```bash
curl -sS -G "$KNOWLEDGE_BASE_URL/tree" \
  --data-urlencode "parentPath=" \
  --data-urlencode "limit=50"
```

Response: `items`, `nextCursor`

## Content by path

```bash
curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" \
  --data-urlencode "path=index.md"
```

Response: `fileId`, `path`, `title`, `content`, `metadata`

## Content by ID

```bash
curl -sS "$KNOWLEDGE_BASE_URL/files/file_123/content"
```

Response: `fileId`, `path`, `title`, `content`, `metadata`

## Metadata

```bash
curl -sS "$KNOWLEDGE_BASE_URL/files/file_123"
```

Response: file metadata

## Graph by file

```bash
curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" \
  --data-urlencode "path=_graph/by-file/file_123.json"
```

Response: related file records with `path`, `title`, `relationType`, `direction`, `weight`, and `reason`

## Related files

```bash
curl -sS "$KNOWLEDGE_BASE_URL/files/file_123/related?limit=20"
```

Response: bounded related file entries and `nextCursor`

## Search

```bash
curl -sS -G "$KNOWLEDGE_BASE_URL/search" \
  --data-urlencode "query=upload lifecycle" \
  --data-urlencode "limit=10"
```

Response: candidate file entries and `nextCursor`
````

## `references/exploration-workflow.md`

```md
# Exploration Workflow

## Broad Questions

1. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`.
2. Read the returned title, summary, and links.
3. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=schema.md"` when metadata fields are unclear.
4. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"` to inspect available pages.
5. Read one relevant candidate file with content by ID or content by path.
6. Read the page `graph` reference or `_graph/by-file/{fileId}.json` when relationship context is useful.
7. Follow Markdown links only when they help answer the user request.

## Direct Questions

1. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"` when search is available.
2. Read the top candidate with `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`.
3. Read another candidate only when the first file does not contain enough evidence.
4. Read `_graph/by-file/{fileId}.json` or `/files/{fileId}/related` when related context is needed.
5. Follow related page paths returned by the graph file.

## File Inspection

1. Run `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}"` when the Agent only needs metadata.
2. Run `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"` when the Agent needs Markdown content.
3. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=pages" --data-urlencode "limit=50"` for folder exploration.

## Stop Conditions

- Stop when enough file evidence answers the user request.
- Stop when search or tree results return no relevant candidates.
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
- Do not expose endpoint credentials, hidden headers, storage paths, or internal service details.

## Limits

- Do not invent missing metadata.
- Do not claim full coverage when only part of the tree was inspected.
- Ask for a narrower question when the request needs more files than the current context can support.
```

## Agent Session Example

```text
User: What does the knowledge base say about the upload lifecycle?

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
