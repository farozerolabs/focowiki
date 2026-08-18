---
title: Webhook 推送
---

# Webhook 推送

Focowiki 会把 Webhook 事件主动推送到 `POST /openapi/v2/webhooks` 注册的 HTTPS URL。外部系统需要已上传文件的处理进度、内容更新、文件删除或知识库删除事件时，可以使用 Webhook。

## 注册 Webhook

创建 Webhook 订阅，并指定接收的事件类型：

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

`url` 必须是公网 HTTPS 接收地址。回环、私网、链路本地、保留地址、包含凭据或片段的地址以及重定向目标都会被拒绝。`events` 必须包含至少一个受支持且不重复的事件类型。只有重试完全相同的创建请求时才复用同一个 `Idempotency-Key`。同一次逻辑创建会返回同一个订阅和 `signingSecret`；开发者需要把密钥保存在应用后端的密钥管理服务中，用于校验推送签名。后续列表响应不会返回密钥或完整端点 URL。

## 推送请求

Focowiki 每次投递都会发送 HTTP `POST` 请求。

| 项目 | 值 |
| --- | --- |
| Method | `POST` |
| Content-Type | `application/json` |
| 成功确认 | 任意 `2xx` 响应状态。 |
| 投递超时 | 由部署配置决定。 |
| 自动重试 | 非 `2xx` 响应和投递失败会按照部署中的尝试次数和延迟配置自动重试。 |
| 手动重投递 | 使用 `POST /openapi/v2/webhook-deliveries/{deliveryId}/redeliver` 创建一次新尝试。 |

## 请求头

| 请求头 | 说明 |
| --- | --- |
| `x-focowiki-event` | 事件类型，例如 `document.available`。 |
| `x-focowiki-delivery-id` | 投递标识。用于幂等处理。 |
| `x-focowiki-timestamp` | 参与签名的 ISO 时间戳。 |
| `x-focowiki-signature` | HMAC SHA-256 签名，格式为 `sha256=<hex>`。 |

## 请求体

每次 Webhook 投递都使用下面的 JSON 结构：

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

## 校验签名

参与签名的内容是：

```text
{x-focowiki-timestamp}.{raw-request-body}
```

然后使用 Webhook `signingSecret` 计算 HMAC SHA-256。期望的请求头格式是 `sha256=<hex-digest>`。

Node.js 校验示例：

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

签名校验需要使用服务端收到的原始请求体字节或完全一致的原始字符串。解析 JSON 后重新序列化会改变空格和换行，导致签名校验失败。

## 事件类型

| 事件类型 | 触发时机 | 数据字段 |
| --- | --- | --- |
| `document.waiting` | 上传或变更的 Markdown 文档已受理，或重试后重新进入等待队列。 | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.processing` | 文档开始处理。 | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.available` | 当前文档版本已经可以读取和搜索。 | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.error` | 文档处理进入终止错误状态。 | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `document.deleting` | 文档删除已受理并正在执行。 | `knowledgeBaseId`, `operationId`, `sourceFileId`, `state`, `errorCode`, `occurredAt` |
| `file.deleted` | 已上传文件或上传目录完成删除。 | `knowledgeBaseId`、`operationId`、`occurredAt`，以及 `sourceFileId` 或 `sourceDirectoryId` |
| `knowledge_base.deleted` | 知识库被删除。 | `knowledgeBaseId`, `operationId`, `occurredAt` |

## 投递记录和重投递

Focowiki 会保存每次投递记录。读取投递记录：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries?webhookId=webhook-11111111-1111-4111-8111-111111111111&limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

自动尝试结束后投递仍为失败时，使用投递列表返回的 `deliveryId` 手动重投递：

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries/delivery-11111111-1111-4111-8111-111111111111/redeliver" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

只有终态失败的投递可以重投递。重投递会使用原始 `eventId`、`eventType` 和 `payload` 创建新的投递记录；已经成功或仍在等待的投递会返回冲突错误。

删除 Webhook 后，它会立即从订阅列表消失，排队中或等待重试的投递不再发送；已有投递记录会保留到其保存期限结束。已经发出的请求仍可能完成。删除后再手动重投递会返回冲突错误。

## 接收端检查清单

- 接收 `POST` 请求和 `application/json`。
- 把 `signingSecret` 保存在服务端。
- 处理事件前先校验 `x-focowiki-signature`。
- 使用 `x-focowiki-delivery-id` 做幂等处理。
- 事件接收成功后返回 `2xx` 状态。
- 长耗时业务放到接收方自己的异步任务中处理。
