---
title: Webhook Delivery
---

# Webhook Delivery

Focowiki sends webhook events to the HTTPS URL registered through `POST /openapi/v1/webhooks`. Use webhooks when another system needs task, release, file-deletion, or knowledge-base-deletion events without polling.

## Register A Webhook

Create a webhook subscription with the event types your endpoint should receive:

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v1/webhooks" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "Task updates",
  "url": "https://hooks.example.com/focowiki",
  "events": ["task.started", "task.progress", "task.ended", "release.published"]
}'
```

The `url` must use HTTPS. The response returns `signingSecret` once. Store it in your backend secret manager and use it to verify delivery signatures.

## Delivery Request

Focowiki sends each delivery as an HTTP `POST` request.

| Part | Value |
| --- | --- |
| Method | `POST` |
| Content-Type | `application/json` |
| Success acknowledgement | Any `2xx` response status. |
| Delivery timeout | 10 seconds. |
| Automatic retry | No automatic retry is currently scheduled. Use `POST /openapi/v1/webhook-deliveries/{deliveryId}/redeliver` for manual redelivery. |

## Request Headers

| Header | Description |
| --- | --- |
| `x-focowiki-event` | Event type, such as `task.ended`. |
| `x-focowiki-delivery-id` | Delivery identifier. Use it for idempotency. |
| `x-focowiki-timestamp` | ISO timestamp used in the signature payload. |
| `x-focowiki-signature` | HMAC SHA-256 signature in the format `sha256=<hex>`. |

## Request Body

Every webhook delivery uses this JSON envelope:

```json
{
  "eventId": "event_123",
  "eventType": "task.ended",
  "deliveryId": "delivery_123",
  "payload": {
    "knowledgeBaseId": "kb_123",
    "taskId": "task_123",
    "operation": "upload",
    "resultReleaseId": "release_123",
    "errorCode": null
  }
}
```

## Verify The Signature

Build the signed content as:

```text
{x-focowiki-timestamp}.{raw-request-body}
```

Then compute HMAC SHA-256 with the webhook `signingSecret`. The expected header is `sha256=<hex-digest>`.

Example Node.js verifier:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyFocowikiWebhook({ rawBody, timestamp, signatureHeader, signingSecret }) {
  if (!timestamp || !signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const actual = signatureHeader.slice("sha256=".length);

  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");

  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
```

Use the raw request body bytes or exact raw body string received by the server. Parsing and re-stringifying JSON changes whitespace and breaks signature verification.

## Event Types

| Event type | When it is sent | Payload fields |
| --- | --- | --- |
| `task.started` | An upload or deletion task starts. | `knowledgeBaseId`, `taskId`, `operation`, `sourceCount` |
| `task.progress` | A source file processing stage changes during upload. | `knowledgeBaseId`, `taskId`, `operation`, `sourceFileIds`, `status`, `stage`, `startedAt`, `endedAt`, `errorCode` |
| `task.ended` | An upload or deletion task ends. | `knowledgeBaseId`, `taskId`, `operation`, `resultReleaseId`, `errorCode` |
| `release.published` | A task publishes a new release. | `knowledgeBaseId`, `taskId`, `releaseId` |
| `file.deleted` | A source-backed generated file is deleted. | `knowledgeBaseId`, `taskId`, `fileId`, `sourceFileId`, `path` |
| `knowledge_base.deleted` | A knowledge base is deleted. | `knowledgeBaseId` |

## Payload Examples

### `task.started`

```json
{
  "eventId": "event_123",
  "eventType": "task.started",
  "deliveryId": "delivery_123",
  "payload": {
    "knowledgeBaseId": "kb_123",
    "taskId": "task_123",
    "operation": "upload",
    "sourceCount": 2
  }
}
```

### `task.progress`

```json
{
  "eventId": "event_123",
  "eventType": "task.progress",
  "deliveryId": "delivery_123",
  "payload": {
    "knowledgeBaseId": "kb_123",
    "taskId": "task_123",
    "operation": "upload",
    "sourceFileIds": ["file_source_123"],
    "status": "completed",
    "stage": "okf_validation",
    "startedAt": "2026-06-17T00:00:00.000Z",
    "endedAt": "2026-06-17T00:00:10.000Z",
    "errorCode": null
  }
}
```

### `release.published`

```json
{
  "eventId": "event_123",
  "eventType": "release.published",
  "deliveryId": "delivery_123",
  "payload": {
    "knowledgeBaseId": "kb_123",
    "taskId": "task_123",
    "releaseId": "release_123"
  }
}
```

## Delivery Records And Redelivery

Focowiki stores each delivery record. Read records with:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/webhook-deliveries?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

When a delivery fails, call redelivery with the `deliveryId` returned by the delivery list:

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v1/webhook-deliveries/delivery_123/redeliver" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Redelivery creates a new delivery record with the original `eventId`, `eventType`, and `payload`.

## Receiver Checklist

- Accept `POST` requests with `application/json`.
- Keep the `signingSecret` server-side.
- Verify `x-focowiki-signature` before processing the event.
- Use `x-focowiki-delivery-id` for idempotency.
- Return a `2xx` status after the event is accepted.
- Process long-running work asynchronously in your own system.
