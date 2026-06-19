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

## Workflow

1. Create or list knowledge bases and keep `knowledgeBaseId`.
2. Upload one or more `.md` files to the knowledge base and keep returned source-file `fileId` values.
3. Poll source-file detail or source-file events until each file reaches `completed` or `failed`.
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

FIRST_SOURCE_FILE_ID=$(printf "%s" "$upload_response" | jq -r ".files[0].fileId")
```

Poll source-file processing until the file reaches a terminal state:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Read detailed processing events when you need stage history:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID/events?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

List the generated file tree and store the first logical `path` plus generated file identifier:

```bash
tree_response=$(curl -sS -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/tree?parentPath=pages&limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY")

FIRST_PATH=$(printf "%s" "$tree_response" | jq -r ".items[0].path")
FIRST_TREE_FILE_ID=$(printf "%s" "$tree_response" | jq -r ".items[0].fileId")
```

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
