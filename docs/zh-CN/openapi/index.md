---
title: Developer OpenAPI
---

# Developer OpenAPI

Developer OpenAPI 为应用提供 Focowiki 的程序化访问能力。产品可以创建知识库、上传 Markdown 文件和文件夹、查看处理进度、读取文件、探索关联关系、维护来源内容，并接收 Webhook 事件。

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

## 响应约定

列表接口的成功响应包含 `items` 和 `nextCursor`。读取下一页时，将 `nextCursor` 传回同一个接口，并保持相同的筛选条件。

错误响应使用稳定结构：

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

所有接口都可能返回 `401 UNAUTHORIZED`、`429 RATE_LIMITED` 或 `500 INTERNAL_ERROR`。限流响应会提供概略的重试建议。客户端可以等待建议的时间，再重试当前操作。

## 资源标识

不同标识用于不同资源，并可在相关接口之间连续使用。

| 标识 | 获取位置 | 用途 |
| --- | --- | --- |
| `knowledgeBaseId` | 创建或列出知识库的响应 | 限定所有知识库操作的范围。 |
| `uploadSessionId` | 创建上传会话的响应 | 继续、查看、取消或完成上传。 |
| `sourceFileId` | 上传和来源文件响应 | 读取来源状态或正文，以及重试、移动、替换和删除。 |
| `directoryId` | 来源目录和文件树响应 | 读取、移动或删除来源目录。 |
| `operationId` | 移动、替换和删除响应 | 查看异步资源变更的进度。 |
| `fileId` | 文件树、搜索、相关文件和文件响应 | 读取生成文件的元数据、正文和关联关系。 |
| `path` | 文件树、搜索、链接和文件响应 | 通过逻辑路径读取生成内容。 |

接口不接受存储路径和本地文件系统路径。

## 上传流程

上传会保留文件的相对目录结构。每个上传项都必须是 Markdown 文件。

1. 创建知识库并保存 `knowledgeBaseId`。
2. 使用声明的文件数量和总字节数创建上传会话。
3. 添加上传清单，登记每个文件的相对路径、大小和 SHA-256 校验值。
4. 确认上传清单。
5. 上传状态为 `upload_required` 的文件正文。
6. 完成上传会话。
7. 查看返回的 `sourceFileId`，直到文件可以读取。

上传会话响应会给出本次上传可使用的限制。大型文件夹应在这些限制内分批发送清单和正文。再次使用已有文件夹路径上传时，会添加新文件，并跳过相对路径相同的已有文件。已有路径需要更新正文时，使用来源文件替换接口。

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

uploaded=$(curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions/$UPLOAD_SESSION_ID/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -F "$UPLOAD_ENTRY_ID=@$FILE_PATH;type=text/markdown")
SOURCE_FILE_ID=$(printf '%s' "$uploaded" | jq -r '.entries[0].sourceFileId')

curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/upload-sessions/$UPLOAD_SESSION_ID/finalize" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

## 处理状态

通过来源文件详情判断内容是否可以读取。

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `processingState` | `queued`、`running`、`completed`、`failed` | 文件处理进度。 |
| `generatedOutputStatus` | `pending`、`visible`、`unavailable` | 生成文件接口中的可用状态。 |

当 `processingState` 为 `completed`，并且 `generatedOutputStatus` 为 `visible` 时，文件已经可以读取。`failed` 文件可以通过事件列表检查原因，再提交重试。

```bash
curl -sS "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

## 文件读取与探索

读取时可以从 `index.md` 开始，随后查看文件树，并在使用候选内容前读取对应文件。

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=index.md"
```

来源文件的嵌套路径会发布到 `pages/` 下。前面上传的示例在可见后，可以通过 `pages/handbook/onboarding/guide.md` 读取：

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=pages/handbook/onboarding/guide.md"
```

文件树接口支持按父路径浏览、模糊查找、类型筛选和游标分页。搜索接口返回带有 `fileId`、`path`、匹配信息和读取动作的候选文件。关系探索接口可以从文件或查询词继续查找相关文件，并返回可以通过文件正文接口读取的路径。

搜索和关系结果用于导航。应用在输出答案前应继续读取返回的 Markdown 文件。

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/search" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "query=installation" \
  --data-urlencode "mode=hybrid" \
  --data-urlencode "limit=10"
```

搜索状态包括 `ok`、`no_candidates` 和 `index_unavailable`。`no_candidates` 只表示当前查询没有匹配结果，不能据此判断知识库中不存在相关内容。客户端可以缩短查询词、读取 `index.md`、浏览文件树或继续探索文件关系。

## 来源内容维护

来源文件支持正文读取、移动、完整正文替换、重试和删除。来源目录支持列表、移动和递归删除。移动、替换和删除请求会返回 `operationId`，可以通过资源操作接口查看完成状态。

删除来源文件会移除对应的生成页面和关联关系。删除来源目录会移除其下的全部来源文件。删除知识库会提交一项知识库级删除，并使该知识库停止提供后续读取。

## Webhook

Webhook 订阅会将来源文件和知识库更新事件推送到 HTTPS 地址。事件名称、签名校验、载荷、重试和重新投递见 [Webhook 推送](./webhook-delivery.md)。

## Agent 接入

OpenAPI key 应保存在应用后端。应用可以为 Agent 提供精简的只读接口，用于列出文件树、读取文件、搜索候选文件和探索关联关系。接入方式和 Skill 设计见 [Agent 接入](../agent-integration/index.md)。

## 接口参考

[接口索引](./operations/index.md)为每个 `operationId` 提供独立页面，包含参数、请求体、示例、响应和该接口特有的错误码。
