---
title: Developer OpenAPI
---

# Developer OpenAPI

Developer OpenAPI 为应用提供 Focowiki 的程序化访问能力。产品可以创建知识库、上传 Markdown 文件和文件夹、查看处理进度、读取文件、探索关联关系、管理已上传内容，并接收 Webhook 事件。

## 连接方式

使用部署时配置的 Developer OpenAPI 地址。所有接口路径都以 `/openapi/v2` 开头。

```text
https://openapi.example.com
```

本地开发通常使用 `http://127.0.0.1:43200`。

每个请求都需要 Admin UI 创建的 OpenAPI key：

```http
Authorization: Bearer <openapi-key>
```

运行中的服务会在以下路径提供机器可读的契约：

```text
GET /openapi/v2/openapi.json
```

文档站还提供当前文档版本的[契约快照](/openapi/focowiki-openapi.json)。为特定部署生成客户端时，应读取该部署的运行时契约。

你可以在只读的 [API 交互文档](./explorer.md)中筛选接口、查看示例，并检查同一版本契约中的数据结构。

## 响应约定

列表接口的成功响应包含 `items` 和 `nextCursor`。读取下一页时，将 `nextCursor` 传回同一个接口，并保持相同的筛选条件。

错误响应使用统一结构：

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

所有接口都可能返回 `401 UNAUTHORIZED`、`429 RATE_LIMITED`、`500 INTERNAL_ERROR` 或 `503 DATABASE_REPOSITORY_UNAVAILABLE`。限流响应会提供重试建议。客户端可以等待建议的时间，再重试当前操作。

## 资源标识

不同标识用于不同资源，并可在相关接口之间连续使用。

来源文件是上传或替换接口接收的原始 Markdown 文件，接口使用 `sourceFileId` 标识这类已上传文件。来源目录是根据上传路径保留下来的文件夹。生成文件是系统根据已上传内容或导航信息生成并发布的可读取知识库文件。一个知识库版本（generation）表示一次已经发布的内容，`generationId` 用于标明响应读取的是哪个具体版本。

| 标识 | 获取位置 | 用途 |
| --- | --- | --- |
| `knowledgeBaseId` | 创建或列出知识库的响应 | 限定所有知识库操作的范围。 |
| `uploadSessionId` | 创建上传会话的响应 | 继续、查看、取消或完成上传。 |
| `sourceFileId` | 上传和已上传文件响应 | 读取上传与处理状态或正文，以及重试、移动、替换和删除。 |
| `directoryId` | 上传目录和文件树响应 | 读取、移动或删除上传目录。 |
| `operationId` | 移动、替换和删除响应 | 查看文件或目录变更的进度和结果。 |
| `fileId` | 文件树、搜索、相关文件和文件响应 | 读取已发布文件的元数据、正文和关联关系。 |
| `path` | 文件树、搜索、链接和文件响应 | 通过知识库内路径读取已发布文件。 |

接口不接受存储路径和本地文件系统路径。

## 上传流程

上传会保留文件的相对目录结构。每个上传项都必须是 Markdown 文件。

1. 创建知识库并保存 `knowledgeBaseId`。
2. 使用声明的文件数量和总字节数创建上传会话。
3. 将每个文件的相对路径和大小加入上传文件列表。API 路径和数据结构将这份列表命名为上传清单（manifest）。可以提供 SHA-256 校验值来校验上传内容。
4. 确认上传文件列表已经完整。
5. 上传状态为 `upload_required` 的文件正文。
6. 完成上传会话。
7. 使用每个已上传文件返回的 `sourceFileId` 查询状态，直到文件可以读取。

上传登记不设置产品级文件数量或字节配额。上传会话响应会说明一次请求最多可以登记多少个文件。每个待上传 Markdown 正文通过服务端分配的文件记录 ID 单独提交。再次使用已有文件夹路径上传时，会添加新文件，并跳过相对路径相同的已有文件。已有路径需要更新正文时，使用已上传文件替换接口。

### 最小示例

下面将 `guide.md` 上传为 `handbook/onboarding/guide.md`。示例使用 `jq`、`wc` 和 `shasum` 在请求之间传递数据。

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

## 处理状态

通过已上传文件详情判断内容是否可以读取。

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `state` | `queued`、`running`、`pending_publication`、`visible`、`failed` | 上传文件的整体处理状态。 |
| `currentStage` | 从 `upload_storage` 到 `generation_activation` | 当前正在执行的处理步骤，或处理停止时所在的步骤。 |
| `failure` | 对象或 `null` | 错误详情和可用的重试类型。 |
| `generatedOutputStatus` | `pending`、`visible`、`unavailable` | 是否可以通过文件接口读取已发布文件。 |
| `actions` | 数组 | 当前可以继续调用的接口。 |

当 `state` 为 `visible` 时，文件已经可以读取。当 `state` 为 `failed` 时，读取 `failure` 并继续调用 `actions` 中的操作。如果返回的操作要求重新让文件可读取，Focowiki 会复用已经完成的处理结果。

```bash
curl -sS "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

## 文件读取与探索

读取时可以从 `index.md` 开始，随后查看文件树，并在使用搜索结果前读取对应文件。

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=index.md"
```

上传文件的嵌套路径会发布到 `pages/` 下。前面上传的示例在可见后，可以通过 `pages/handbook/onboarding/guide.md` 读取：

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=pages/handbook/onboarding/guide.md"
```

文件树接口支持按父路径浏览、模糊查找、类型筛选和分页。搜索接口返回带有 `fileId`、`path`、匹配信息和读取链接的文件。关系探索接口可以从文件或查询词继续查找相关文件，并返回可以通过文件正文接口读取的路径。

搜索和关系结果用于导航。应用在输出答案前应继续读取返回的 Markdown 文件。

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/search" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "query=installation" \
  --data-urlencode "mode=hybrid" \
  --data-urlencode "limit=10"
```

搜索状态包括 `ok`、`no_candidates` 和 `index_unavailable`。`no_candidates` 只表示当前查询没有匹配结果，不能据此判断知识库中不存在相关内容。客户端可以缩短查询词、读取 `index.md`、浏览文件树或继续探索文件关系。

## 管理已上传内容

已上传文件支持正文读取、移动、完整正文替换、重试和删除。上传目录支持列表、移动和递归删除。移动、替换和删除请求会返回 `operationId`，可以通过文件和目录变更接口查看处理进度和结果。

删除已上传文件会移除对应的已发布页面和关联关系。删除上传目录会移除其中的全部已上传文件。删除知识库会开始删除整个知识库，并使该知识库停止提供后续读取。

## Webhook

Webhook 订阅会将已上传文件和知识库更新事件推送到 HTTPS 地址。事件名称、签名校验、请求内容、投递记录和手动重新投递见 [Webhook 推送](./webhook-delivery.md)。

## Agent 接入

OpenAPI key 应保存在应用后端。应用可以为 Agent 提供精简的只读接口，用于列出文件树、读取文件、搜索匹配文件和探索关联关系。接入方式和 Skill 设计见 [Agent 接入](../agent-integration/index.md)。

## 接口参考

[接口索引](./operations/index.md)为每个 `operationId` 提供独立页面，包含参数、请求体、示例、响应和该接口特有的错误码。
