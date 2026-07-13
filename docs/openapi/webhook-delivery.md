---
title: Webhook Delivery
---

# Webhook Delivery

Focowiki sends webhook events to the HTTPS URL registered through `POST /openapi/v2/webhooks`. Use webhooks when another system needs source-file progress, content updates, file deletion, or knowledge-base deletion events.

## Register A Webhook

Create a webhook subscription with the event types your endpoint should receive:

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v2/webhooks" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "Source file updates",
  "url": "https://hooks.example.com/focowiki",
  "events": ["source_file.completed", "source_file.failed", "release.published"]
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
| Redelivery | Use `POST /openapi/v2/webhook-deliveries/{deliveryId}/redeliver` for manual redelivery. |

## Request Headers

| Header | Description |
| --- | --- |
| `x-focowiki-event` | Event type, such as `source_file.completed`. |
| `x-focowiki-delivery-id` | Delivery identifier. Use it for idempotency. |
| `x-focowiki-timestamp` | ISO timestamp used in the signature payload. |
| `x-focowiki-signature` | HMAC SHA-256 signature in the format `sha256=<hex>`. |

## Request Body

Every webhook delivery uses this JSON envelope:

```json
{
  "eventId": "event_123",
  "eventType": "source_file.completed",
  "deliveryId": "delivery_123",
  "payload": {
    "knowledgeBaseId": "kb_123",
    "sourceFileId": "file_source_123"
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
| `source_file.accepted` | A Markdown file is accepted and persisted. | `knowledgeBaseId`, `sourceFileId` |
| `source_file.progress` | A source file starts or continues processing. | `knowledgeBaseId`, `sourceFileId` |
| `source_file.completed` | A source file completes processing. | `knowledgeBaseId`, `sourceFileId` |
| `source_file.failed` | A source file fails processing. | `knowledgeBaseId`, `sourceFileId`, `errorCode` |
| `release.published` | Updated knowledge-base content becomes readable. | `knowledgeBaseId`, `sourceFileId`, `releaseId` when available |
| `file.deleted` | A source file and its readable page are deleted. | `knowledgeBaseId`, `fileId`, `sourceFileId`, `path`, `releaseId` |
| `knowledge_base.deleted` | A knowledge base is deleted. | `knowledgeBaseId` |

## Delivery Records And Redelivery

Focowiki stores each delivery record. Read records with:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

When a delivery fails, call redelivery with the `deliveryId` returned by the delivery list:

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries/delivery_123/redeliver" \
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
