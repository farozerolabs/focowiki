---
title: Developer OpenAPI
---

# Developer OpenAPI

Developer OpenAPI gives applications programmatic access to Focowiki. A product can create knowledge bases, upload Markdown files and folders, observe processing, read files, explore relationships, maintain source content, and receive Webhook events.

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

## Response Conventions

Successful list responses contain `items` and `nextCursor`. Pass `nextCursor` back to the same endpoint with the same filters to read the next page.

Errors use a stable envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request failed validation.",
    "httpStatus": 422
  },
  "requestId": "req_123"
}
```

All operations can return `401 UNAUTHORIZED`, `429 RATE_LIMITED`, or `500 INTERNAL_ERROR`. A rate-limited response includes coarse retry guidance. Clients should wait for the suggested interval and retry the current operation.

## Resource Identifiers

Identifiers have distinct purposes and remain stable across related calls.

| Identifier | Obtained from | Used for |
| --- | --- | --- |
| `knowledgeBaseId` | Knowledge-base create or list responses | Scope every knowledge-base operation. |
| `uploadSessionId` | Upload-session create response | Resume, inspect, cancel, or complete an upload. |
| `sourceFileId` | Upload and source-file responses | Read source state or content, retry, move, replace, and delete. |
| `directoryId` | Source-directory and tree responses | Read, move, or delete a source directory. |
| `operationId` | Move, replace, and delete responses | Observe an asynchronous resource change. |
| `fileId` | Tree, search, related-file, and file responses | Read generated metadata, content, and relationships. |
| `path` | Tree, search, links, and file responses | Read generated content by logical path. |

Storage paths and local filesystem paths are not accepted.

## Upload Workflow

Uploads preserve relative folder paths. Every uploaded item must be a Markdown file.

1. Create a knowledge base and keep its `knowledgeBaseId`.
2. Create an upload session with the declared file and byte counts.
3. Add manifest entries containing each file's relative path, size, and SHA-256 checksum.
4. Confirm the manifest.
5. Upload content for entries whose disposition is `upload_required`.
6. Complete the upload session.
7. Observe each uploaded entry's `sourceFileId` until the file is readable.

Upload registration has no product-level file-count or byte quota. The session response provides a bounded manifest page size for transport. Upload each required Markdown body through its server-issued entry ID. Reusing an existing folder path adds new files. Existing files at the same relative path are skipped. Use the source-file replacement operation when content at an existing path must change.

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

Use the source-file detail operation to determine when content is ready.

| Field | Values | Meaning |
| --- | --- | --- |
| `state` | `queued`, `running`, `pending_publication`, `visible`, `failed` | Backend-derived source-file lifecycle. |
| `currentStage` | `upload_storage` through `generation_activation` | Current or terminal lifecycle stage. |
| `failure` | object or `null` | Safe terminal failure details and retry kind. |
| `generatedOutputStatus` | `pending`, `visible`, `unavailable` | Availability in generated file APIs. |
| `actions` | array | Followable operations authorized for the current lifecycle state. |

A file is ready when `state` is `visible`. When `state` is `failed`, read `failure` and follow one of the returned `actions`. A publication retry has knowledge-base publication scope and preserves completed source processing.

```bash
curl -sS "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

## File Reading And Exploration

Start with `index.md`, inspect the tree, and read candidate files before using them as evidence.

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=index.md"
```

Nested source paths are published under `pages/`. The uploaded example can be read at `pages/handbook/onboarding/guide.md` after it becomes visible:

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=pages/handbook/onboarding/guide.md"
```

The tree endpoint supports parent-path navigation, fuzzy lookup, type filtering, and cursor pagination. Search returns candidate files with `fileId`, `path`, match information, and read actions. Relationship exploration accepts a file or query and returns paths that can be opened through the file-content operations.

Search and relationship results guide navigation. Applications should read the returned Markdown files before presenting an answer.

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/search" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "query=installation" \
  --data-urlencode "mode=hybrid" \
  --data-urlencode "limit=10"
```

Search can return `ok`, `no_candidates`, or `index_unavailable`. `no_candidates` describes the current query result and does not prove that the knowledge base lacks relevant content. Clients can try a shorter phrase, inspect `index.md`, browse the tree, or follow file relationships.

## Source Maintenance

Source files support content reads, moves, full-content replacement, retry, and deletion. Source directories support listing, moves, and recursive deletion. Move, replace, and delete requests return an `operationId`; use resource-operation endpoints to observe completion.

Deleting a source file removes its generated page and relationships. Deleting a source directory removes all source files below it. Deleting a knowledge base accepts one knowledge-base-level deletion and makes that knowledge base unavailable to later reads.

## Webhooks

Webhook subscriptions deliver source-file and knowledge-base update events to an HTTPS endpoint. See [Webhook Delivery](./webhook-delivery.md) for event names, signature verification, payloads, retries, and redelivery.

## Agent Integration

Keep the OpenAPI key in an application backend. Give the Agent a small read interface that can list the tree, read files, search candidates, and follow relationships. See [Agent Integration](../agent-integration/index.md) for integration patterns and Skill guidance.

## Interface Reference

The [Operation Index](./operations/index.md) contains one generated page for every `operationId`, including parameters, request bodies, examples, responses, and operation-specific errors.
