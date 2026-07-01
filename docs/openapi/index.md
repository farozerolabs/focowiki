---
title: Developer OpenAPI
---

# Developer OpenAPI

Developer OpenAPI lets applications operate Focowiki without the Admin UI. Use it to create knowledge bases, upload Markdown files, observe source-file processing, read generated files, delete source-backed pages, manage webhooks, and inspect webhook delivery state.

## Base URL

Use the public OpenAPI origin configured for your deployment.

```text
https://openapi.example.com
```

Local development commonly uses:

```text
http://127.0.0.1:43200
```

All Developer OpenAPI paths start with `/openapi/v1`.

## Authentication

Every Developer OpenAPI request uses a bearer API key.

```http
Authorization: Bearer <openapi-key>
```

Create and copy API keys from the Admin UI. API key creation is an Admin workflow and is not exposed through Developer OpenAPI.

## Contract Source

Use the runtime contract for the deployed service your client calls:

```bash
curl -X GET "https://openapi.example.com/openapi/v1/openapi.json" \
  -H "Authorization: Bearer <openapi-key>"
```

The documentation site also publishes a static snapshot for the documented release:

```text
https://docs.example.com/openapi/focowiki-openapi.json
```

API client generators, Postman imports, Swagger UI, and integration tests should prefer the runtime contract from the target deployment.
When importing the static snapshot, set the generated client's server or base URL to your deployment's OpenAPI origin.

## Response Shape

Successful responses return JSON. List endpoints return:

| Field | Meaning |
| --- | --- |
| `items` | Current page of records. |
| `nextCursor` | Cursor for the next page. The value is `null` when no next page exists. |

Error responses use:

| Field | Meaning |
| --- | --- |
| `error.code` | Stable error code for client handling. |
| `error.message` | Safe explanation. |
| `error.httpStatus` | HTTP status number. |
| `error.details` | Optional safe details. |
| `requestId` | Request identifier for troubleshooting. |

## Rate Limits

All Developer OpenAPI endpoints share one deployment-level rate limit. When a client receives `RATE_LIMITED`, it should wait briefly and retry the next request. The response includes a safe `Retry-After` header and optional `error.details.retryAfterSeconds`, `error.details.retryHint`, and `error.details.retryGuidance` fields. These values are coarse retry guidance for Agent planning and do not expose the deployment's exact rate-limit configuration.

## Source-File Status Fields

Upload APIs return source-file records. Source-file records use two status fields:

| Field | Values | Meaning |
| --- | --- | --- |
| `processingState` | `queued`, `running`, `completed`, `failed` | Source-file processing lifecycle. |
| `generatedOutputStatus` | `pending`, `visible`, `unavailable` | Generated output visibility in the active knowledge-base tree. |

`processingState` values:

| Value | Meaning |
| --- | --- |
| `queued` | The file was accepted and is waiting for processing. |
| `running` | Storage, metadata, model, graph, bundle, validation, or publication work is in progress. |
| `completed` | Source-file processing finished. |
| `failed` | Processing stopped for this source file. The file can be retried with the source-file retry API. |

`generatedOutputStatus` values:

| Value | Meaning |
| --- | --- |
| `pending` | Generated output has not been published into the active tree yet. |
| `visible` | The generated page is published in the active tree and can be read by generated file APIs. |
| `unavailable` | Generated output is not currently available for this source file. |

Treat a source file as fully complete and readable when both conditions are true:

- `processingState` is `completed`.
- `generatedOutputStatus` is `visible`.

`processingState=completed` alone means processing finished. The generated file tree and content APIs become reliable after `generatedOutputStatus=visible`.

`currentStage` shows the latest processing stage. Values include `upload_storage`, `metadata_resolution`, `llm_suggestion`, `graph_generation`, `bundle_generation`, `okf_validation`, `index_publication`, and `release_activation`.

## Workflow

1. Create or list knowledge bases and keep `knowledgeBaseId`.
2. Upload one or more `.md` files to the knowledge base and keep returned source-file `fileId` values.
3. Poll source-file detail or source-file events until each file reaches `processingState=failed`, or reaches `processingState=completed` with `generatedOutputStatus=visible`.
4. Read the generated tree and keep `path` or `fileId` values.
5. Read file content by `path` or `fileId`.
6. Read `_graph/by-file/{fileId}.json` or the related-file endpoint when the application needs relationship exploration.
7. Delete source-backed generated pages when needed.
8. Register webhooks when an external system needs event delivery.

## Quick Start

Set placeholders before running the examples. The examples use `jq` to pass returned identifiers between requests.

```bash
OPENAPI_BASE_URL="https://openapi.example.com"
OPENAPI_KEY="<openapi-key>"
```

Check the API version:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/version" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Create a knowledge base and store `knowledgeBaseId`:

```bash
knowledge_base_response=$(curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "Product Docs",
  "description": "Product documentation"
}')

KNOWLEDGE_BASE_ID=$(printf "%s" "$knowledge_base_response" | jq -r ".knowledgeBase.knowledgeBaseId")
```

Upload one or more Markdown files and store a returned source-file identifier. Replace `guide.md` and `faq.md` with local `.md` file paths.

```bash
upload_response=$(curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/uploads" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -F "files=@guide.md;type=text/markdown" \
  -F "files=@faq.md;type=text/markdown")

FIRST_SOURCE_FILE_ID=$(printf "%s" "$upload_response" | jq -r ".files[0].sourceFileId")
```

Poll source-file processing until the file is fully complete or failed:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

The file is fully complete when the response contains:

```json
{
  "file": {
    "processingState": "completed",
    "generatedOutputStatus": "visible"
  }
}
```

If the response contains `processingState=failed`, read `processingErrorCode`, `processingErrorMessage`, and source-file events before retrying.

Read detailed processing events when you need stage history:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID/events?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Filter source-file task records when a knowledge base contains many uploads. Filters are applied before pagination, and the returned `nextCursor` belongs to the same filter set:

Task filters are query parameters on the [List source files](./operations/list-knowledge-base-source-files.md) operation.

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "processingStatus=completed" \
  --data-urlencode "generatedOutputStatus=visible" \
  --data-urlencode "fileNameQuery=guide" \
  --data-urlencode "limit=50"
```

Delete source-file task rows when an integration needs to clear obsolete upload records. `deleted` means an unpublished source-file task was removed. `hidden` means the source-file task row was hidden and the generated file remains readable through `generatedFileId` or `generatedFilePath`. `skipped` means the row stayed unchanged; read `reason`, then poll detail or events again when the reason is a temporary state such as `running`.

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/task-deletions" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data "{
  \"sourceFileIds\": [\"$FIRST_SOURCE_FILE_ID\"]
}"
```

Task deletion only affects source-file task visibility. Generated file deletion uses the generated file delete endpoints and the `generatedFileId` or logical `generatedFilePath` values.

Deleted knowledge bases and deleted source-backed generated pages are removed from Admin UI and Developer OpenAPI read results immediately. Focowiki then cleans stored generated data automatically after the delete request succeeds.

List the generated file tree and store the first logical `path` plus generated file identifier:

```bash
tree_response=$(curl -sS -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/tree?parentPath=pages&limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY")

FIRST_PATH=$(printf "%s" "$tree_response" | jq -r ".items[0].path")
FIRST_TREE_FILE_ID=$(printf "%s" "$tree_response" | jq -r ".items[0].fileId")
```

Search generated files when the integration has a short phrase and needs candidate files before reading evidence. Search returns file-level candidates only. Use the returned `fileId` or `generatedFileId` with file detail, content, and related-file endpoints. Use `path` or `generatedFilePath` with path-based content reads. Use `sourceFileId` with source-file status, events, retry, or task-deletion endpoints when source processing context is needed:

```bash
search_response=$(curl -sS -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/search" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "query=guide" \
  --data-urlencode "scope=all" \
  --data-urlencode "fileKind=page" \
  --data-urlencode "limit=10")

SEARCH_STATUS=$(printf "%s" "$search_response" | jq -r ".searchStatus")
FIRST_SEARCH_FILE_ID=$(printf "%s" "$search_response" | jq -r ".items[0].fileId")
FIRST_SEARCH_GENERATED_FILE_ID=$(printf "%s" "$search_response" | jq -r ".items[0].generatedFileId")
FIRST_SEARCH_PATH=$(printf "%s" "$search_response" | jq -r ".items[0].path")
FIRST_SEARCH_GENERATED_FILE_PATH=$(printf "%s" "$search_response" | jq -r ".items[0].generatedFilePath")
FIRST_SEARCH_SOURCE_FILE_ID=$(printf "%s" "$search_response" | jq -r ".items[0].sourceFileId")
SEARCH_RESULT_COUNT=$(printf "%s" "$search_response" | jq -r ".resultSummary.resultCount")
SEARCH_SORT=$(printf "%s" "$search_response" | jq -r ".resultSummary.sort | join(\", \")")
SEARCH_NEXT_CONTENT_TEMPLATE=$(printf "%s" "$search_response" | jq -r ".nextRequestTemplates.fileContentByPath")
```

`searchStatus` can be `ok`, `no_candidates`, or `index_unavailable`. `ok` means candidate files are returned. `no_candidates` means search documents exist and this phrase matched no generated files. Relevant data may still exist under different titles, paths, or metadata terms. `index_unavailable` means the active release has no generated-file search documents yet, usually because the release was created before this search read model existed.

Search responses include `query`, `resultSummary`, and `nextRequestTemplates`. `query` echoes the normalized phrase and applied filters. `resultSummary.sort` describes result ordering, currently `score desc`, `path asc`, and `fileId asc`. `nextRequestTemplates` gives the next read routes for generated file detail, generated file content, path-based content, related files, source-file status, and source-file events. When `no_candidates` or `index_unavailable` is returned, follow `nextActions`, read `index.md`, list the tree, try shorter or adjacent phrases, or inspect related files and graph files.

Read generated file content by logical path:

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=$FIRST_PATH"
```

Unicode page paths are supported when they belong to the generated public tree. Use `--data-urlencode` so filenames such as `pages/遵义市城镇燃气安全管理条例.md` are encoded safely:

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=pages/遵义市城镇燃气安全管理条例.md"
```

Read generated file content by file identifier:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/$FIRST_TREE_FILE_ID/content" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Read the file-first graph entry for a source-backed page. The same graph path appears in page frontmatter and `_index/search.json` as `graphRef`.

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=_graph/by-file/$FIRST_SOURCE_FILE_ID.json"
```

Read a bounded related-file list when your backend wants JSON relationship records directly:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/$FIRST_TREE_FILE_ID/related?limit=20" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Graph files are logical generated files. Use tree listing, content by path, content by ID, or the related-file endpoint. Published relationships come from accepted content-evidenced graph edges. The API returns logical paths and safe reasons, not S3 object keys or runtime internals.

Read source file metadata returned by the upload response:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Create a webhook when another system needs source-file or release events:

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v1/webhooks" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "Source file updates",
  "url": "https://hooks.example.com/focowiki",
  "events": ["source_file.completed", "source_file.failed", "release.published"]
}'
```

See [Webhook Delivery](./webhook-delivery.md) for delivery headers, payload format, signature verification, event types, and redelivery behavior.

## Agent Integration

When an Agent needs to read a knowledge base, place a developer backend between the Agent and Focowiki. The backend keeps the Focowiki OpenAPI key, selects the target knowledge base, and exposes a small read-focused interface to the Agent. Agents can follow generated Markdown links and `_graph/by-file/{fileId}.json` files for deeper exploration.

See [Agent Integration](../agent-integration/index.md) for backend adapter and Skill design guidance.

## Operation Pages

Each operation page documents one OpenAPI `operationId`. Pages are generated from the backend OpenAPI contract during documentation build, so the method, path, parameters, request body, responses, and error codes stay aligned with runtime behavior.

Run this command locally to generate the operation pages:

```bash
pnpm docs:generate-api
```

Then browse the operation pages from the navigation.
