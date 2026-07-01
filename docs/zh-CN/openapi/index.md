---
title: Developer OpenAPI
---

# Developer OpenAPI

Developer OpenAPI 让应用可以在不打开 Admin UI 的情况下操作 Focowiki。你可以用它创建知识库、上传 Markdown 文件、观察来源文件处理、读取生成文件、删除源文件关联页面、管理 webhooks，并查看 webhook 投递状态。

## Base URL

使用部署时配置的 public OpenAPI origin。

```text
https://openapi.example.com
```

本地开发常用：

```text
http://127.0.0.1:43200
```

所有 Developer OpenAPI 路径都以 `/openapi/v1` 开头。

## 鉴权

每个 Developer OpenAPI 请求都使用 bearer API key。

```http
Authorization: Bearer <openapi-key>
```

API keys 需要从 Admin UI 创建和复制。API key 创建属于 Admin 工作流，不通过 Developer OpenAPI 暴露。

## Contract 来源

调用目标部署时，优先读取运行时 contract：

```bash
curl -X GET "https://openapi.example.com/openapi/v1/openapi.json" \
  -H "Authorization: Bearer <openapi-key>"
```

文档站也会发布当前文档版本对应的静态快照：

```text
https://docs.example.com/openapi/focowiki-openapi.json
```

API client generator、Postman import、Swagger UI 和集成测试建议使用目标部署的运行时 contract。
导入静态快照时，需要把生成客户端的 server 或 base URL 设置为当前部署的 OpenAPI 访问域名。

## 响应结构

成功响应返回 JSON。列表接口返回：

| 字段 | 含义 |
| --- | --- |
| `items` | 当前页记录。 |
| `nextCursor` | 下一页游标。没有下一页时值为 `null`。 |

错误响应结构：

| 字段 | 含义 |
| --- | --- |
| `error.code` | 用于客户端处理的稳定错误码。 |
| `error.message` | 安全的错误说明。 |
| `error.httpStatus` | HTTP 状态码。 |
| `error.details` | 可选的安全详情。 |
| `requestId` | 排查问题时使用的请求标识。 |

## 限流

所有 Developer OpenAPI 接口共用一套部署级限流。客户端收到 `RATE_LIMITED` 后，应短暂等待再重试下一个请求。响应会包含安全的 `Retry-After` header，也可能包含 `error.details.retryAfterSeconds`、`error.details.retryHint` 和 `error.details.retryGuidance` 字段。这些值用于 Agent 规划等待和重试，不暴露部署的真实限流配置。

## 来源文件状态字段

上传接口返回来源文件记录。来源文件记录使用两个状态字段：

| 字段 | 状态值 | 含义 |
| --- | --- | --- |
| `processingState` | `queued`、`running`、`completed`、`failed` | 来源文件处理生命周期。 |
| `generatedOutputStatus` | `pending`、`visible`、`unavailable` | 生成结果在当前知识库文件树中的可见状态。 |

`processingState` 状态值：

| 状态值 | 含义 |
| --- | --- |
| `queued` | 文件已接收，等待处理。 |
| `running` | 正在执行存储、元数据、模型、图关系、知识库生成、校验或发布。 |
| `completed` | 来源文件处理已完成。 |
| `failed` | 该来源文件处理停止。可以通过来源文件重试接口重新处理。 |

`generatedOutputStatus` 状态值：

| 状态值 | 含义 |
| --- | --- |
| `pending` | 生成结果还没有发布到当前文件树。 |
| `visible` | 生成页面已经发布到当前文件树，可以通过生成文件接口读取。 |
| `unavailable` | 该来源文件当前没有可用生成结果。 |

判断一个来源文件完全完成并且可读，需要同时满足两个条件：

- `processingState` 为 `completed`。
- `generatedOutputStatus` 为 `visible`。

`processingState=completed` 表示处理流程结束。文件树和内容读取接口在 `generatedOutputStatus=visible` 后可稳定使用。

`currentStage` 表示最新处理阶段。常见值包括 `upload_storage`、`metadata_resolution`、`llm_suggestion`、`graph_generation`、`bundle_generation`、`okf_validation`、`index_publication` 和 `release_activation`。

## 调用流程

1. 创建或列出知识库，并保存 `knowledgeBaseId`。
2. 向知识库上传一个或多个 `.md` 文件，并保存返回的来源文件 `fileId`。
3. 轮询来源文件详情或来源文件事件，直到文件进入 `processingState=failed`，或者进入 `processingState=completed` 且 `generatedOutputStatus=visible`。
4. 读取生成文件树，并保存 `path` 或 `fileId`。
5. 按 `path` 或 `fileId` 读取文件内容。
6. 应用需要关系探索时读取 `_graph/by-file/{fileId}.json` 或 related-file endpoint。
7. 按需删除源文件关联的生成页面。
8. 外部系统需要事件投递时注册 webhooks。

## Quick Start

先设置示例占位符。下面的示例使用 `jq` 把上一步响应里的标识符传给下一步请求。

```bash
OPENAPI_BASE_URL="https://openapi.example.com"
OPENAPI_KEY="<openapi-key>"
```

检查 API 版本：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/version" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

创建知识库，并保存 `knowledgeBaseId`：

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

上传一个或多个 Markdown 文件，并保存返回的来源文件标识符。把 `guide.md` 和 `faq.md` 替换成本地 `.md` 文件路径。

```bash
upload_response=$(curl -sS -X POST "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/uploads" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -F "files=@guide.md;type=text/markdown" \
  -F "files=@faq.md;type=text/markdown")

FIRST_SOURCE_FILE_ID=$(printf "%s" "$upload_response" | jq -r ".files[0].sourceFileId")
```

轮询来源文件处理状态，直到文件完全完成或失败：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

当响应中包含以下字段时，表示文件已经完全完成并且可以读取：

```json
{
  "file": {
    "processingState": "completed",
    "generatedOutputStatus": "visible"
  }
}
```

如果响应中包含 `processingState=failed`，先读取 `processingErrorCode`、`processingErrorMessage` 和来源文件事件，再决定是否重试。

需要阶段历史时读取来源文件事件：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID/events?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

当知识库包含大量上传记录时，可以筛选来源文件任务记录。筛选会先于分页执行，返回的 `nextCursor` 只适用于同一组筛选条件：

任务筛选参数属于 [列出来源文件](./operations/list-knowledge-base-source-files.md) 接口的 query 参数。

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "processingStatus=completed" \
  --data-urlencode "generatedOutputStatus=visible" \
  --data-urlencode "fileNameQuery=guide" \
  --data-urlencode "limit=50"
```

当集成方需要清理过期上传记录时，可以删除来源文件任务行。`deleted` 表示未发布的来源文件任务已移除。`hidden` 表示来源文件任务行已隐藏，生成文件仍可通过 `generatedFileId` 或 `generatedFilePath` 读取。`skipped` 表示该行保持原状态；读取 `reason`，如果原因是 `running` 这类临时状态，后续再轮询详情或事件。

```bash
curl -X POST "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/task-deletions" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  -H "Content-Type: application/json" \
  --data "{
  \"sourceFileIds\": [\"$FIRST_SOURCE_FILE_ID\"]
}"
```

任务删除只影响来源文件任务可见性。生成文件删除使用生成文件删除接口，并传入 `generatedFileId` 或逻辑 `generatedFilePath`。

知识库删除和来源文件关联生成页面删除成功后，Admin UI 与 Developer OpenAPI 的读取结果会立即移除对应数据。Focowiki 会在删除请求成功后自动清理已存储的生成数据。

列出生成文件树，并保存第一个逻辑 `path` 和生成文件标识符：

```bash
tree_response=$(curl -sS -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/tree?parentPath=pages&limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY")

FIRST_PATH=$(printf "%s" "$tree_response" | jq -r ".items[0].path")
FIRST_TREE_FILE_ID=$(printf "%s" "$tree_response" | jq -r ".items[0].fileId")
```

当集成方已有短查询短语并需要先找到候选文件时，可以搜索生成文件。搜索只返回文件级候选。使用返回的 `fileId` 或 `generatedFileId` 继续调用文件详情、内容和相关文件接口。使用 `path` 或 `generatedFilePath` 调用按路径读取内容接口。需要查看来源处理上下文时，使用 `sourceFileId` 调用来源文件状态、事件、重试或任务删除接口：

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

`searchStatus` 可能是 `ok`、`no_candidates` 或 `index_unavailable`。`ok` 表示返回了候选文件。`no_candidates` 表示搜索文档已经存在，但当前短语没有命中生成文件。相关数据仍可能存在于其他标题、路径或元数据词中。`index_unavailable` 表示当前 active release 还没有生成文件搜索文档，通常是该 release 在搜索读模型上线前创建。

搜索响应包含 `query`、`resultSummary` 和 `nextRequestTemplates`。`query` 返回规范化后的查询词和本次使用的筛选条件。`resultSummary.sort` 描述结果排序方式，当前是 `score desc`、`path asc` 和 `fileId asc`。`nextRequestTemplates` 给出下一步读取接口模板，包括生成文件详情、生成文件内容、按路径读取内容、相关文件、来源文件状态和来源文件事件。返回 `no_candidates` 或 `index_unavailable` 时，继续参考 `nextActions`，读取 `index.md`，列出文件树，尝试更短或相邻短语，或查看相关文件和图文件。

按逻辑路径读取生成文件内容：

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=$FIRST_PATH"
```

只要路径属于生成后的公开文件树，Unicode 页面路径也可以读取。使用 `--data-urlencode`，让 `pages/遵义市城镇燃气安全管理条例.md` 这类文件名被安全编码：

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=pages/遵义市城镇燃气安全管理条例.md"
```

按文件标识符读取生成文件内容：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/$FIRST_TREE_FILE_ID/content" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

读取 source-backed page 的文件优先图关系入口。页面 frontmatter 和 `_index/search.json` 中的 `graphRef` 也会指向同类路径。

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=_graph/by-file/$FIRST_SOURCE_FILE_ID.json"
```

当后端需要直接读取 JSON 关系记录时，可以调用有界 related-file list：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/$FIRST_TREE_FILE_ID/related?limit=20" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

图关系文件属于逻辑生成文件。可以通过文件树、按路径读取、按 ID 读取或 related-file endpoint 访问。发布出的关系来自 accepted content-evidenced graph edges。API 返回逻辑路径和安全原因，不返回 S3 object keys 或运行时内部信息。

读取上传响应返回的来源文件元数据：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

当外部系统需要来源文件或 release 事件时创建 webhook：

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

查看 [Webhook 推送](./webhook-delivery.md)，了解推送请求头、请求体格式、签名校验、事件类型和重投递行为。

## Agent 接入

当 Agent 需要读取知识库时，在 Agent 和 Focowiki 之间放置开发者后端。后端保存 Focowiki OpenAPI key，选择目标知识库，并向 Agent 暴露小型读取接口。Agent 可以沿生成 Markdown links 和 `_graph/by-file/{fileId}.json` 文件继续探索。

查看 [Agent 接入](../agent-integration/index.md)，了解后端适配和 Skill 设计。

## 接口页面

每个接口页面对应一个 OpenAPI `operationId`。这些页面在文档构建时由后端 OpenAPI contract 生成，因此 method、path、parameters、request body、responses 和 error codes 会与运行时行为保持对齐。

本地生成接口页面：

```bash
pnpm docs:generate-api
```

然后从导航中查看各个接口页面。
