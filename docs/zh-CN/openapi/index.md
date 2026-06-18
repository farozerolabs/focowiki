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

## 调用流程

1. 创建或列出知识库，并保存 `knowledgeBaseId`。
2. 向知识库上传一个或多个 `.md` 文件，并保存返回的来源文件 `fileId`。
3. 轮询来源文件详情或来源文件事件，直到每个文件进入 `completed` 或 `failed`。
4. 读取生成文件树，并保存 `path` 或 `fileId`。
5. 按 `path` 或 `fileId` 读取文件内容。
6. 按需删除源文件关联的生成页面。
7. 外部系统需要事件投递时注册 webhooks。

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

FIRST_SOURCE_FILE_ID=$(printf "%s" "$upload_response" | jq -r ".files[0].fileId")
```

轮询来源文件处理状态，直到文件进入终态：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

需要阶段历史时读取来源文件事件：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/source-files/$FIRST_SOURCE_FILE_ID/events?limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

列出生成文件树，并保存第一个逻辑 `path` 和生成文件标识符：

```bash
tree_response=$(curl -sS -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/tree?parentPath=pages&limit=50" \
  -H "Authorization: Bearer $OPENAPI_KEY")

FIRST_PATH=$(printf "%s" "$tree_response" | jq -r ".items[0].path")
FIRST_TREE_FILE_ID=$(printf "%s" "$tree_response" | jq -r ".items[0].fileId")
```

按逻辑路径读取生成文件内容：

```bash
curl -G "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/content" \
  -H "Authorization: Bearer $OPENAPI_KEY" \
  --data-urlencode "path=$FIRST_PATH"
```

按文件标识符读取生成文件内容：

```bash
curl -X GET "$OPENAPI_BASE_URL/openapi/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/files/$FIRST_TREE_FILE_ID/content" \
  -H "Authorization: Bearer $OPENAPI_KEY"
```

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

当 Agent 需要读取知识库时，在 Agent 和 Focowiki 之间放置开发者后端。后端保存 Focowiki OpenAPI key，选择目标知识库，并向 Agent 暴露小型读取接口。

查看 [Agent 接入](../agent-integration/index.md)，了解后端适配和 Skill 设计。

## 接口页面

每个接口页面对应一个 OpenAPI `operationId`。这些页面在文档构建时由后端 OpenAPI contract 生成，因此 method、path、parameters、request body、responses 和 error codes 会与运行时行为保持对齐。

本地生成接口页面：

```bash
pnpm docs:generate-api
```

然后从导航中查看各个接口页面。
