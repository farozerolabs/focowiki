---
title: Webhook 推送
---

# Webhook 推送

Focowiki 会把 webhook 事件主动推送到 `POST /openapi/v2/webhooks` 注册的 HTTPS URL。外部系统需要来源文件进度、内容更新、文件删除或知识库删除事件时，可以使用 webhook。

## 注册 Webhook

创建 webhook 订阅，并指定接收的事件类型：

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v2/webhooks" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "Source file updates",
  "url": "https://hooks.example.com/focowiki",
  "events": ["source_file.completed", "source_file.failed", "generation.activated"]
}'
```

`url` 必须使用 HTTPS。创建响应只返回一次 `signingSecret`。开发者需要把它保存到后端密钥管理或运行时密钥配置中，用于校验推送签名。

## 推送请求

Focowiki 每次投递都会发送 HTTP `POST` 请求。

| 项目 | 值 |
| --- | --- |
| Method | `POST` |
| Content-Type | `application/json` |
| 成功确认 | 任意 `2xx` 响应状态。 |
| 投递超时 | 10 秒。 |
| 重投递 | 失败后可用 `POST /openapi/v2/webhook-deliveries/{deliveryId}/redeliver` 手动重投递。 |

## 请求头

| Header | 说明 |
| --- | --- |
| `x-focowiki-event` | 事件类型，例如 `source_file.completed`。 |
| `x-focowiki-delivery-id` | 投递标识。用于幂等处理。 |
| `x-focowiki-timestamp` | 参与签名的 ISO 时间戳。 |
| `x-focowiki-signature` | HMAC SHA-256 签名，格式为 `sha256=<hex>`。 |

## 请求体

每次 webhook 投递都使用下面的 JSON envelope：

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

## 校验签名

参与签名的内容是：

```text
{x-focowiki-timestamp}.{raw-request-body}
```

然后使用 webhook `signingSecret` 计算 HMAC SHA-256。期望的请求头格式是 `sha256=<hex-digest>`。

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

签名校验需要使用服务端收到的原始请求体字节或完全一致的原始字符串。解析 JSON 后重新 stringify 会改变空格和换行，导致签名校验失败。

## 事件类型

| 事件类型 | 触发时机 | Payload 字段 |
| --- | --- | --- |
| `source_file.accepted` | Markdown 文件已接收并持久化。 | `knowledgeBaseId`, `sourceFileId` |
| `source_file.progress` | 来源文件开始处理或继续处理。 | `knowledgeBaseId`, `sourceFileId` |
| `source_file.completed` | 来源文件处理完成。 | `knowledgeBaseId`, `sourceFileId` |
| `source_file.failed` | 来源文件处理失败。 | `knowledgeBaseId`, `sourceFileId`, `errorCode` |
| `generation.activated` | 更新后的知识库内容可以读取。 | `knowledgeBaseId`, `sourceFileId`, 可用时包含 `generationId` |
| `file.deleted` | 来源文件及其可读取页面已经删除。 | `knowledgeBaseId`, `fileId`, `sourceFileId`, `path`, `generationId` |
| `knowledge_base.deleted` | 知识库被删除。 | `knowledgeBaseId` |

## 投递记录和重投递

Focowiki 会保存每次投递记录。读取投递记录：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

当投递失败时，使用投递列表返回的 `deliveryId` 手动重投递：

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v2/webhook-deliveries/delivery_123/redeliver" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

重投递会使用原始 `eventId`、`eventType` 和 `payload` 创建新的投递记录。

## 接收端检查清单

- 接收 `POST` 请求和 `application/json`。
- 把 `signingSecret` 保存在服务端。
- 处理事件前先校验 `x-focowiki-signature`。
- 使用 `x-focowiki-delivery-id` 做幂等处理。
- 事件接收成功后返回 `2xx` 状态。
- 长耗时业务放到接收方自己的异步任务中处理。
