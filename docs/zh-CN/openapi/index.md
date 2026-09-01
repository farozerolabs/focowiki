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

每个请求都需要 Admin UI 创建的 OpenAPI 密钥：

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

来源文件是上传或替换接口接收的原始 Markdown 文件，接口使用 `sourceFileId` 标识这类已上传文件。来源目录是根据上传路径保留下来的文件夹。生成文件是系统根据已上传内容或导航信息生成的当前可读取知识库文件。`activeContentRevision` 是当前可读取知识库内容的数字修订号；知识库没有可读取内容时返回 `0`，允许为空的读取响应返回 `null`。

| 标识 | 获取位置 | 用途 |
| --- | --- | --- |
| `knowledgeBaseId` | 创建或列出知识库的响应 | 限定所有知识库操作的范围。 |
| `uploadSessionId` | 创建上传会话的响应 | 继续、查看、取消或完成上传。 |
| `sourceFileId` | 上传和已上传文件响应 | 读取上传与处理状态或正文，以及重试、移动、替换和删除。 |
| `directoryId` | 上传目录和文件树响应 | 读取、移动或删除上传目录。 |
| `operationId` | 上传会话和资源变更响应 | 查看上传逐文档入库进度或资源变更结果。 |
| `fileId` | 文件树、搜索、相关文件和文件响应 | 读取当前文件的元数据、正文和关联关系。 |
| `path` | 文件树、搜索、链接和文件响应 | 通过知识库内路径读取当前文件。 |

接口不接受存储路径和本地文件系统路径。

## 上传流程

上传会保留文件的相对目录结构。每个上传项都必须是 Markdown 文件。

完成上传会话前，需要先在 Admin 中配置一个生效的生成模型和一个已验证且生效的嵌入模型。知识库缺少这些配置时，完成接口会在创建文档任务前拒绝请求；已上传的传输数据会保留，修正配置后可以再次完成会话。

1. 创建知识库并保存 `knowledgeBaseId`。
2. 使用声明的文件数量和总字节数创建上传会话。
3. 将每个文件的相对路径和大小加入上传文件列表。API 路径和数据结构将这份列表命名为上传清单（manifest）。可以提供 SHA-256 校验值来校验上传内容。
4. 确认上传文件列表已经完整。
5. 上传状态为 `upload_required` 的文件正文。
6. 完成上传会话，并保留响应中的 `operationId` 或 `actions.operation` 链接。
7. 轮询操作状态，查看逐文档进度；状态为 `available` 的文档会立即可读、可搜索，不等待同一次上传中的其他文档。
8. 使用每个文件的 `sourceFileId` 读取当前状态和正文。

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
| `state` | `waiting`、`processing`、`available`、`error`、`deleting` | 上传文件的整体文档入库状态。 |
| `workProgress` | 对象 | 文档所需工作的进度。`activeKinds` 列出正在执行的工作；`blockingKind` 和 `retryingKind` 表示正在等待或将要重试的工作。 |
| `failure` | 对象或 `null` | 错误详情和可用的重试类型。 |
| `generatedOutputStatus` | `unavailable`、`previous_available`、`current_available` | 当前无生成内容、上一可读取修订仍可用，或当前修订可用。 |
| `actions` | 数组 | 当前可以继续调用的接口。 |

当 `state` 为 `available` 时，文件已经可以读取和搜索。客户端应以 `state` 判断可用性；文件可用后，`workProgress` 仍可能显示最后的清理工作。当 `state` 为 `error` 时，读取 `failure.workKind` 并继续调用响应返回的 `actions`。替换失败时可以继续读取上一个可用正文；首次上传失败的文件不会出现在正文、文件树、图或搜索读取中。

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

上传文件的嵌套路径会生成到 `pages/` 下。前面上传的示例变为可用后，可以通过 `pages/handbook/onboarding/guide.md` 读取：

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=pages/handbook/onboarding/guide.md"
```

文件树接口支持按父路径浏览、模糊查找、类型筛选和分页。搜索接口接受一个完整独立的自然语言问题；规范化后长度为 2 到 512 个字素簇，最多 2048 个 UTF-8 字节，并且不能包含不安全控制字符。请原样提交完整问题，不要在本地拆分。省略 `mode` 时使用推荐的 `hybrid`。`file` 搜索文件路径、标题、元数据、正文和语义相似内容；`graph` 沿文件关系和图语义信号查找；`hybrid` 合并两者。使用 `scope=path` 只搜索路径和标题，`scope=metadata` 只搜索元数据，`scope=all` 搜索全部范围。

搜索只返回由上传文件生成且当前生效的 Markdown 页面。`fileKind=page` 是默认值；`fileKind=all` 会移除显式类型条件，但当前返回相同的页面集合。OKF 筛选是可选项，并且会排除没有相应有效 OKF 信号的文件；不需要限制结果时应省略这些筛选。`graphDepth=0` 只返回起点图引用，`1` 包含直接关系，`2` 可以在请求的 `graphFanout` 范围内包含第二层关系。搜索结果包含 `fileId`、`path`、实际匹配字段、安全证据类型、可用时的短来源摘要、状态和读取链接。

搜索和关系结果用于导航。应用在输出答案前应继续读取返回的 Markdown 文件。

```bash
curl -sS -G "$OPENAPI_BASE_URL/openapi/v2/knowledge-bases/$KNOWLEDGE_BASE_ID/files/search" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "query=如何安装、配置并验证这个知识库？" \
  --data-urlencode "mode=hybrid" \
  --data-urlencode "limit=10"
```

搜索只返回 `searchStatus=ok` 或 `searchStatus=no_candidates`。`no_candidates` 只表示当前查询没有匹配结果，不能据此判断知识库中不存在相关内容；依赖服务失败时使用文档中的 503 或 504 错误结构。响应会返回稳定的语义检索和重排原因码，以及已完成、已降级证据类型的枚举。422 响应的顶层错误码为 `VALIDATION_ERROR`，`details.code` 来自该操作机器可读的 `x-validation-detail-codes`，例如 `FILE_SEARCH_QUERY_TOO_LONG`、`INVALID_FILE_SEARCH_KIND` 或 `INVALID_FILE_SEARCH_RERANK_CONTROLS`。

重排默认关闭。单次请求设置 `rerank=true` 后使用 Admin 中当前生效的重排模型；`rerankTopK` 只控制非精确候选窗口，`rerankScoreThreshold` 只筛选有效的非精确重排分数。阈值默认为 `0`，此时重排只改变顺序。显式设置正阈值后，如果全部非精确候选都被过滤，响应会返回 `RERANKER_ALL_BELOW_THRESHOLD`。重排模型缺失或失败时会回退到确定性的混合排序，并返回安全的 `rerankerStatus`。搜索摘要、实体或关系标签、社区摘要和重排输出都只是发现线索；回答前必须通过 `readActions` 读取返回的来源 Markdown 正文。

## 管理已上传内容

已上传文件支持正文读取、移动、完整正文替换、重试和删除。上传目录支持列表、移动和递归删除。上传会话和资源变更会返回 `operationId`，可以通过操作查询接口查看逐文档入库进度、资源变更进度和结果。

删除已上传文件会移除对应的当前生成页面和关联关系。删除上传目录会移除其中的全部已上传文件。删除知识库会开始删除整个知识库，并使该知识库停止提供后续读取。

## Webhook

Webhook 订阅会将已上传文件和知识库更新事件推送到 HTTPS 地址。事件名称、签名校验、请求内容、投递记录和手动重新投递见 [Webhook 推送](./webhook-delivery.md)。

## Agent 接入

OpenAPI 密钥应保存在应用后端。应用可以为 Agent 提供精简的只读接口，用于列出文件树、读取文件、搜索匹配文件和探索关联关系。接入方式和 Skill 设计见 [Agent 接入](../agent-integration/index.md)。

## 接口参考

[接口索引](./operations/index.md)为每个 `operationId` 提供独立页面，包含参数、请求体、示例、响应和该接口特有的错误码。
