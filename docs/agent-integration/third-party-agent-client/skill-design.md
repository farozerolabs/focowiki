---
title: Skill Design
---

# Skill Design

Use this page when developers want a Skill that runs inside a third-party Agent client. In this mode, the Agent client cannot register the developer's built-in tools. The Skill uses HTTP requests to read from a developer-provided read-only knowledge endpoint.

## Why This Mode Exists

Some Agent clients support instructions and HTTP access, but do not support custom tool registration. A read-only HTTP endpoint lets the Skill query the configured knowledge base without requiring the third-party Agent client to integrate a private tool API.

The endpoint should expose only the read operations needed by the Skill. Do not place service credentials in the Skill. If the endpoint requires authentication, use the third-party Agent client's secret-management mechanism.

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
| Read content by ID | `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"` |
| Read content by path | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"` |
| Search files | `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"` |

These URLs are the developer-provided read interface for the Agent.

The `/search` endpoint is part of that developer-provided interface. Focowiki Developer OpenAPI does not expose `/search` directly. Implement it in your backend when Agent search is needed, commonly by reading the generated `_index/search.json` file or by using your own search layer.

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

## Curl Commands

- List files: `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"`
- Read metadata: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}"`
- Read content by ID: `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`
- Read content by path: `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`
- Search files: `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"`

## Process

1. Request `/files/content?path=index.md` for broad context.
2. Request `/files/content?path=schema.md` when metadata fields are unclear.
3. Request `/search?query=...` for direct questions when search is available.
4. Request `/tree` when search is unavailable or incomplete.
5. Read one file at a time.
6. Follow Markdown links when related context is needed.
7. Cite file titles or paths in the final answer.

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
6. Follow Markdown links only when they help answer the user request.

## Direct Questions

1. Run `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..." --data-urlencode "limit=10"` when search is available.
2. Read the top candidate file with `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"`.
3. Request another candidate with `curl` only when the first file does not contain enough evidence.
4. Follow links from the selected file when related context is needed.

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
User: What does the knowledge endpoint say about the upload lifecycle?

Terminal command:
curl -sS -G "https://knowledge.example.com/files/content" --data-urlencode "path=index.md"

Terminal command:
curl -sS -G "https://knowledge.example.com/search" --data-urlencode "query=upload lifecycle" --data-urlencode "limit=10"

Terminal command:
curl -sS "https://knowledge.example.com/files/file_upload_lifecycle/content"

Agent answer:
The upload lifecycle starts with Markdown submission, then runs parsing, knowledge package generation, validation, index publishing, and activation. Evidence: `index.md`, `pages/upload-lifecycle.md`.
```
