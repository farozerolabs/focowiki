---
title: Developer OpenAPI
---

# Developer OpenAPI

Developer OpenAPI gives applications programmatic access to Focowiki. A product can create knowledge bases, upload Markdown files and folders, observe processing, read files, explore relationships, manage uploaded content, and receive Webhook events.

## Connection

Use the Developer OpenAPI origin configured for your deployment. All API paths start with `/openapi/v2`.

```text
https://openapi.example.com
```

Local development commonly uses `http://127.0.0.1:43200`.

Every request requires an OpenAPI key created in Admin UI:

```http
Authorization: Bearer <openapi-key>
```

The running service publishes its machine-readable contract at:

```text
GET /openapi/v2/openapi.json
```

The documentation site also provides a [contract snapshot](/openapi/focowiki-openapi.json) for the documented release. Use the runtime contract when generating a client for a specific deployment.

Use the [API Explorer](./explorer.md) to filter operations, inspect examples, and review schemas from the same release contract in a read-only interface.

## Response Conventions

Successful list responses contain `items` and `nextCursor`. Pass `nextCursor` back to the same endpoint with the same filters to read the next page.

Errors use the same JSON structure:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request failed validation.",
    "httpStatus": 422
  },
  "requestId": "req-11111111-1111-4111-8111-111111111111"
}
```

All operations can return `401 UNAUTHORIZED`, `429 RATE_LIMITED`, `500 INTERNAL_ERROR`, or `503 DATABASE_REPOSITORY_UNAVAILABLE`. A rate-limited response includes retry guidance. Clients should wait for the suggested interval and retry the current operation.

## Resource Identifiers

Identifiers have distinct purposes and remain stable across related calls.

A source file is the original Markdown file accepted by an upload or replacement request. The API uses `sourceFileId` for this uploaded file. A source directory is a folder preserved from the uploaded file path. A generated file is a readable, published knowledge-base file produced from uploaded content or navigation data. A generation is one published version of the knowledge base; fields such as `generationId` identify the exact version used by a response.

| Identifier | Obtained from | Used for |
| --- | --- | --- |
| `knowledgeBaseId` | Knowledge-base create or list responses | Scope every knowledge-base operation. |
| `uploadSessionId` | Upload-session create response | Resume, inspect, cancel, or complete an upload. |
| `sourceFileId` | Upload and uploaded-file responses | Read upload and processing status or content, retry, move, replace, and delete. |
| `directoryId` | Uploaded-directory and tree responses | Read, move, or delete an uploaded directory. |
| `operationId` | Move, replace, and delete responses | Check the progress and result of a file or directory change. |
| `fileId` | Tree, search, related-file, and file responses | Read published file metadata, content, and relationships. |
| `path` | Tree, search, links, and file responses | Read a published file by its knowledge-base path. |

Storage paths and local filesystem paths are not accepted.

## Upload Workflow

Uploads preserve relative folder paths. Every uploaded item must be a Markdown file.

1. Create a knowledge base and keep its `knowledgeBaseId`.
2. Create an upload session with the declared file and byte counts.
3. Add each file's relative path and size to the upload file list. This list is named the upload manifest in API paths and schema names. A SHA-256 checksum can be included to verify the uploaded content.
4. Confirm that the upload file list is complete.
5. Upload content for entries whose disposition is `upload_required`.
6. Complete the upload session.
7. Use the `sourceFileId` returned for each uploaded file to check its status until it is readable.

Upload registration has no product-level file-count or byte quota. The session response states how many file records can be added in one request. Upload each required Markdown body through the entry ID returned by the session. Reusing an existing folder path adds new files. Existing files at the same relative path are skipped. Use the uploaded-file replacement operation when content at an existing path must change.

### Minimal Example

The example uploads `guide.md` as `handbook/onboarding/guide.md`. It uses `jq`, `wc`, and `shasum` to pass values between requests.

```bash
OPENAPI_BASE_URL="https://openapi.example.com"
OPENAPI_KEY="<openapi-key>"
FILE_PATH="guide.md"
RELATIVE_PATH="handbook/onboarding/guide.md"

kb=$(curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data '{"name":"Product Docs","description":"Product documentation"}')
KNOWLEDGE_BASE_ID=$(printf '%s' "$kb" | jq -r '.knowledgeBase.knowledgeBaseId')

FILE_SIZE=$(wc -c < "$FILE_PATH" | tr -d ' ')
FILE_SHA256=$(shasum -a 256 "$FILE_PATH" | awk '{print $1}')

session=$(curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Idempotency-Key: product-docs-upload-001" \
  -H "Content-Type: application/json" \
  --data "{\"declaredFileCount\":1,\"declaredByteCount\":$FILE_SIZE}")
UPLOAD_SESSION_ID=$(printf '%s' "$session" | jq -r '.session.id')

manifest=$(jq -n --arg path "$RELATIVE_PATH" --arg checksum "$FILE_SHA256" \
  --argjson size "$FILE_SIZE" \
  '{entries:[{relativePath:$path,declaredSize:$size,checksumSha256:$checksum}]}')

curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions/$UPLOAD_SESSION_ID/entries" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data "$manifest"

curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions/$UPLOAD_SESSION_ID/seal" \
  -H "Authorization: Bearer $OPENAPI_KEY"

status=$(curl -sS "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions/$UPLOAD_SESSION_ID?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY")
UPLOAD_ENTRY_ID=$(printf '%s' "$status" | jq -r '.entries.items[] | select(.disposition == "upload_required") | .id' | head -n 1)

uploaded=$(curl -sS -X PUT "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions/$UPLOAD_SESSION_ID/entries/$UPLOAD_ENTRY_ID/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: text/markdown" \
  --data-binary "@$FILE_PATH")
SOURCE_FILE_ID=$(printf '%s' "$uploaded" | jq -r '.entry.sourceFileId')

curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions/$UPLOAD_SESSION_ID/finalize" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

## Processing State

Use the uploaded-file detail operation to determine when content is ready.

| Field | Values | Meaning |
| --- | --- | --- |
| `state` | `queued`, `running`, `pending_publication`, `visible`, `failed` | Overall processing status of the uploaded file. |
| `currentStage` | `upload_storage` through `generation_activation` | Processing step currently running or where processing stopped. |
| `failure` | object or `null` | Error details and the available retry type. |
| `generatedOutputStatus` | `pending`, `visible`, `unavailable` | Whether the published file can be read through the file APIs. |
| `actions` | array | API calls currently available for this file. |

A file is ready when `state` is `visible`. When `state` is `failed`, read `failure` and follow one of the returned `actions`. If an action retries making the file readable, Focowiki reuses the processing that already completed.

```bash
curl -sS "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

## File Reading And Exploration

Start with `index.md`, inspect the tree, and read matching files before using them as evidence.

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=index.md"
```

Nested upload paths are published under `pages/`. The uploaded example can be read at `pages/handbook/onboarding/guide.md` after it becomes visible:

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=pages/handbook/onboarding/guide.md"
```

The tree endpoint supports parent-path navigation, fuzzy lookup, type filtering, and cursor pagination. Search accepts one standalone natural-language question from 2 through 512 grapheme clusters and at most 2048 UTF-8 bytes after normalization. Unsafe control characters are rejected. Omit `mode` to use the recommended `hybrid` retrieval. With `scope=all`, `file` uses exact path, grounded title, lexical, Jieba, and content-vector evidence; `graph` uses exact path, grounded title, file relationships, and entity, relationship, and community vectors; `hybrid` uses both plans. `scope=path` keeps exact path and title evidence, while `scope=metadata` keeps lexical metadata evidence.

Search returns active Markdown pages created from uploaded files. `fileKind=page` is the default; `fileKind=all` removes the explicit type predicate but currently returns the same page set. OKF filters are optional and exclude files without matching valid OKF signals, so omit them for unrestricted search. `graphDepth=0` returns only the seed graph reference, `1` includes direct relationships, and `2` may include second-level relationships within the requested `graphFanout`. Search results include `fileId`, `path`, actual matched fields, safe evidence types, a short source excerpt when available, status, and read actions.

Search and relationship results guide navigation. Applications should read the returned Markdown files before presenting an answer.

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/search" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "query=How do I install, configure, and verify this knowledge base?" \
  --data-urlencode "mode=hybrid" \
  --data-urlencode "limit=10"
```

Search returns `searchStatus=ok` or `searchStatus=no_candidates`. `no_candidates` describes only the current query result and does not prove that the knowledge base lacks relevant content. Dependency failures use the documented 503 or 504 error envelope. The response exposes stable semantic and reranker reason codes plus the completed and degraded evidence-family enums. A 422 response uses top-level `VALIDATION_ERROR`; its `details.code` is one of the operation's machine-readable `x-validation-detail-codes`, such as `FILE_SEARCH_QUERY_TOO_LONG`, `INVALID_FILE_SEARCH_KIND`, or `INVALID_FILE_SEARCH_RERANK_CONTROLS`.

Reranking is disabled by default. Set `rerank=true` per request to use the active Admin-configured reranker; `rerankTopK` controls its non-exact candidate window and `rerankScoreThreshold` filters only valid non-exact reranker scores. These fields do not change the embedding model's server-owned cosine relevance threshold. Missing or failed reranking falls back to deterministic hybrid order and reports a safe `rerankerStatus`. Search excerpts, entity or relationship labels, community summaries, and reranker output are discovery hints. Read the returned source Markdown through `readActions` before using its content in an answer.

## Manage Uploaded Content

Uploaded files support content reads, moves, full-content replacement, retry, and deletion. Uploaded directories support listing, moves, and recursive deletion. Move, replace, and delete requests return an `operationId`; use the file and directory change endpoints to check progress and results.

Deleting an uploaded file removes its published page and relationships. Deleting an uploaded directory removes all uploaded files below it. Deleting a knowledge base starts deletion for the complete knowledge base and makes it unavailable to later reads.

## Webhooks

Webhook subscriptions deliver uploaded-file and knowledge-base update events to an HTTPS endpoint. See [Webhook Delivery](./webhook-delivery.md) for event names, signature verification, payloads, delivery records, and manual redelivery.

## Agent Integration

Keep the OpenAPI key in an application backend. Give the Agent a small read interface that can list the tree, read files, search for matching files, and follow relationships. See [Agent Integration](../agent-integration/index.md) for integration patterns and Skill guidance.

## Interface Reference

The [Operation Index](./operations/index.md) contains one generated page for every `operationId`, including parameters, request bodies, examples, responses, and operation-specific errors.
