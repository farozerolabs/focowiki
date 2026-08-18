---
title: Webhook Delivery
---

# Webhook Delivery

Focowiki sends webhook events to the HTTPS URL registered through `POST /openapi/v2/webhooks`. Use webhooks when another system needs uploaded-file progress, content updates, file deletion, or knowledge-base deletion events.

## Register A Webhook

Create a webhook subscription with the event types your endpoint should receive:

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v2/webhooks" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Idempotency-Key: webhook-source-updates-001" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "Source file updates",
  "url": "https://hooks.example.com/focowiki",
  "events": ["document.available", "document.error", "file.deleted"]
}'
```

The `url` must be a public HTTPS receiver. Loopback, private, link-local, reserved, credential-bearing, fragment-bearing, and redirect targets are rejected. `events` must contain one or more supported event types and cannot contain duplicates. Reuse the same `Idempotency-Key` only when retrying the identical create request. The response returns the same subscription and `signingSecret` for that logical create; store the secret in your backend secret manager and use it to verify delivery signatures. A later list response never returns the secret or full endpoint URL.

## Delivery Request

Focowiki sends each delivery as an HTTP `POST` request.

| Part | Value |
| --- | --- |
| Method | `POST` |
| Content-Type | `application/json` |
| Success acknowledgement | Any `2xx` response status. |
| Delivery timeout | Configured by the deployment. |
| Automatic retry | Non-`2xx` responses and delivery failures are retried according to the deployment's attempt and delay settings. |
| Manual redelivery | Use `POST /openapi/v2/webhook-deliveries/{deliveryId}/redeliver` to create a new attempt. |

## Request Headers

| Header | Description |
| --- | --- |
| `x-focowiki-event` | Event type, such as `document.available`. |
| `x-focowiki-delivery-id` | Delivery identifier. Use it for idempotency. |
| `x-focowiki-timestamp` | ISO timestamp used in the signature payload. |
| `x-focowiki-signature` | HMAC SHA-256 signature in the format `sha256=<hex>`. |

## Request Body

Every webhook delivery uses this JSON envelope:

```json
{
  "eventId": "event-11111111-1111-4111-8111-111111111111",
  "eventType": "document.available",
  "deliveryId": "delivery-11111111-1111-4111-8111-111111111111",
  "payload": {
    "knowledgeBaseId": "knowledge-base-11111111-1111-4111-8111-111111111111",
    "operationId": "upload-operation-11111111-1111-4111-8111-111111111111",
    "sourceFileId": "source-file-11111111-1111-4111-8111-111111111111",
    "state": "available",
    "errorCode": null,
    "occurredAt": "2026-08-14T01:00:00.000Z"
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
| `document.waiting` | An uploaded or changed Markdown document is accepted, or a retry returns it to the waiting queue. | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.processing` | Document processing starts. | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.available` | The current document revision becomes readable and searchable. | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.error` | Processing reaches a terminal error. | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.deleting` | Document deletion is accepted and in progress. | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `file.deleted` | An uploaded file or directory finishes deletion. | `knowledgeBaseId`, `operationId`, `occurredAt`, and either `sourceFileId` or `sourceDirectoryId` |
| `knowledge_base.deleted` | A knowledge base is deleted. | `knowledgeBaseId`, `operationId`, `occurredAt` |

## Delivery Records And Redelivery

Focowiki stores each delivery record. Read records with:

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries?webhookId=webhook-11111111-1111-4111-8111-111111111111&limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

When a delivery remains failed after its automatic attempts, call redelivery with the `deliveryId` returned by the delivery list:

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries/delivery-11111111-1111-4111-8111-111111111111/redeliver" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

Only a terminal failed delivery can be redelivered. Redelivery creates a new delivery record with the original `eventId`, `eventType`, and `payload`; an already successful or still pending delivery returns a conflict response.

Deleting a webhook immediately removes it from the subscription list and prevents queued or retrying deliveries from being sent. Existing delivery records remain readable for their retention period. A delivery already in flight can finish. After deletion, manual redelivery returns a conflict response.

## Receiver Checklist

- Accept `POST` requests with `application/json`.
- Keep the `signingSecret` server-side.
- Verify `x-focowiki-signature` before processing the event.
- Use `x-focowiki-delivery-id` for idempotency.
- Return a `2xx` status after the event is accepted.
- Process long-running work asynchronously in your own system.
