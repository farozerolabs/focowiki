---
title: 后端适配
---

# 后端适配

后端适配层是产品连接 Focowiki Developer OpenAPI 的应用代码。它把凭据保存在服务端，支持可恢复上传和逐文档索引状态观察，并向 Agent 暴露更小的读取接口。

## 职责

| 职责 | 说明 |
| --- | --- |
| 凭据保存 | 在后端密钥管理服务或运行时配置中保存 Focowiki OpenAPI 基础 URL 和 API 密钥。 |
| 知识库选择 | 将产品租户、项目或用户映射到允许访问的 `knowledgeBaseId`。 |
| 请求整理 | 将产品级请求转换成 Focowiki OpenAPI 调用。 |
| 响应整理 | 只返回 Agent 探索和读取所需字段。 |
| 错误映射 | 将 Focowiki 错误码转换成稳定的应用错误。 |
| 速率控制 | 在请求进入 Focowiki 前应用产品级速率限制。 |
| 模式路由 | 为自有 Agent 客户端提供内置工具，为第三方 Agent 客户端提供只读 HTTP 端点。 |

## 接入步骤

1. 从 Focowiki Admin UI 创建 OpenAPI 密钥。
2. 将密钥保存到后端环境变量或密钥管理服务。
3. 保存 Focowiki OpenAPI 基础 URL，例如 `https://openapi.example.com`。
4. 解析或配置目标 `knowledgeBaseId`。
5. 增加一个小型 Focowiki 客户端模块，处理鉴权、JSON 解析、分页和错误映射。
6. 按产品需要增加知识库创建、上传、源文件观察、重试、删除和 Webhook 管理等工作流服务。
7. 增加面向 Agent 的端点或工具，通过客户端模块提供读取能力。

## 产品工作流边界

开发者后端可以使用完整的 Focowiki Developer OpenAPI：

| 工作流 | 常用操作 |
| --- | --- |
| 知识库管理 | `listKnowledgeBases`、`createKnowledgeBase`、`updateKnowledgeBase`、`deleteKnowledgeBase` |
| Markdown 入库 | `createUploadSession`、`addUploadManifestEntries`、`sealUploadManifest`、`uploadSessionEntryContent`、`getUploadSession`、`finalizeUploadSession` |
| 来源状态查看 | `listKnowledgeBaseSourceFiles`、`getKnowledgeBaseSourceFile`、`retryKnowledgeBaseSourceFile` |
| 来源内容维护 | `moveSourceFile`、`replaceSourceFileContent`、`deleteSourceFile`、`listSourceDirectories`、`moveSourceDirectory`、`deleteSourceDirectory`、`listResourceOperations`、`getResourceOperation` |
| 文件读取与探索 | `listKnowledgeBaseTree`、`getFileById`、`getFileContentById`、`getFileContentByPath`、`searchGeneratedFiles`、`listRelatedFiles`、`expandGraph`、`getGraphOverview` |
| Webhooks | `listWebhooks`、`createWebhook`、`deleteWebhook`、`listWebhookDeliveries`、`redeliverWebhook` |

这些能力属于开发者后端。面向 Agent 的接口默认只暴露探索所需的读取能力。只有产品明确支持 Agent 维护知识库时，才向 Agent 开放写入或删除能力。

## 文档索引生命周期

上传会话是可恢复的传输容器，不是可用性批次。`finalizeUploadSession` 接受上传条目后返回 `operationId`；之后每个文档独立索引，一个文档可以在同会话的其他文档仍处于等待或处理中时先变为可用。

对每个 `sourceFileId`：

1. 调用 `getKnowledgeBaseSourceFile`、跟随 `links.self`，或消费 `document.waiting`、`document.processing`、`document.available`、`document.error`、`document.deleting` Webhook。
2. `state=available` 且 `generatedOutputStatus=current_available` 表示当前内容可读。
3. 跟随 `actions[].href` 或 `links.generatedContent`，不要自行拼接生成路径。
4. `state=error` 且 `generatedOutputStatus=unavailable` 表示不可读。`generatedOutputStatus=previous_available` 表示本次处理失败，但上一个可读修订仍然可用。
5. 只有返回操作和失败指引允许时，才调用 `retryKnowledgeBaseSourceFile`。

已经可用的文档可以立即提供给 Agent，不需要等待整个上传操作完成。

## 最小后端接口

具体路由由你的产品决定。下面是一个适合 Agent 读取的简单形态：

| 后端路由或工具 | 调用 Focowiki | 返回 |
| --- | --- | --- |
| `GET /agent/knowledge/tree` | `listKnowledgeBaseTree` | `activeContentRevision`、文件条目和 `nextCursor`。 |
| `GET /agent/knowledge/files/{fileId}` | `getFileById` | 当前可读文件元数据和 `readActions`。 |
| `GET /agent/knowledge/files/{fileId}/content` | `getFileContentById` | 原样返回 `{ file, content }`。 |
| `GET /agent/knowledge/files/content?path=...` | `getFileContentByPath` | 按逻辑路径原样返回 `{ file, content }`。 |
| `GET /agent/knowledge/files/{fileId}/related` | `listRelatedFiles` | 带 `readActions` 的有界相关文件。 |
| `GET /agent/knowledge/graph/expand?fileId=...` | `expandGraph` | 从一个可读文件探索一层或两层关系。 |
| `GET /agent/knowledge/search?query=<standalone natural-language question>` | `searchGeneratedFiles` | 排序后的可读候选与后续动作。 |

`search` 路由应保持为 `searchGeneratedFiles` 的轻量透传。第一次搜索发送用户的完整独立问题，并使用默认 `hybrid` 模式。适配层应保留 `activeContentRevision`、`searchStatus`、`semanticStatus`、`evidenceStatus`、`rerankerStatus`、`graphStatus`、`resultSummary`、`nextActions` 以及每个结果的 `readActions`。Agent 必须读取选中的来源 Markdown 后才能使用其内容作为证据。

第三方 Agent 客户端可以使用 `https://knowledge.example.com` 作为只读基础 URL，并在后端路由到同一套 `/agent/knowledge` 适配层。这样 Skill 看到的是 `/tree`、`/files/{fileId}`、`/files/content?path=index.md` 这类短路径，同时鉴权、授权和 Focowiki OpenAPI 调用仍由开发者后端控制。

自有 Agent 客户端可以注册同一组契约的内置工具：

| 工具 | 后端路由 |
| --- | --- |
| `list_tree` | `GET /agent/knowledge/tree` |
| `get_file` | `GET /agent/knowledge/files/{fileId}` |
| `read_file` | `GET /agent/knowledge/files/{fileId}/content` 或 `GET /agent/knowledge/files/content?path=...` |
| `read_related` | `GET /agent/knowledge/files/{fileId}/related`，或使用返回的 `graphRef` 读取关系文件 |
| `search_files` | `GET /agent/knowledge/search?query=<完整独立的用户问题>` |
| `expand_graph` | `GET /agent/knowledge/graph/expand?fileId=...` |

## 标识符流转

后端应该保留 Focowiki 返回的同一组标识符：

| 标识符 | 来源 | 后续用途 |
| --- | --- | --- |
| `knowledgeBaseId` | Admin UI、`listKnowledgeBases` 或后端配置 | 限定所有 Focowiki 调用范围。 |
| `sourceFileId` | 上传响应和源文件处理记录 | 读取处理状态和源 Markdown、执行支持的变更，并在 `generatedOutputStatus` 变为 `current_available` 后标识对应的可读来源页面。 |
| `fileId` | 文件树条目、搜索结果、文件详情、相关文件或图扩展 | 读取文件元数据和内容。来源页面与 `sourceFileId` 使用同一个稳定值。 |
| `generatedPath` 或 `path` | 源文件详情、文件树条目、搜索结果、文件详情或返回的链接 | 按可移植逻辑路径读取当前内容。 |
| `activeContentRevision` | 文件树、文件、搜索、相关文件和图响应 | 让多次调用保持在同一个当前可读知识库修订；修订变化后重新开始分页。 |
| `graphRef` | 搜索结果和关系响应 | 直接读取返回的 `_graph/by-file/**` JSON 路径，无需自行拼接。 |
| `cursor` | 列表响应 | 继续分页。 |

这样可以保证 Agent 调用流程连续。上一个调用返回的值可以直接用于下一个调用。

工作流从来源文件处理记录开始时，先调用来源文件详情接口。`generatedOutputStatus` 变为 `current_available` 后，直接请求响应中非空的 `links.generatedContent` 或 `open_generated_file` 操作。来源页面使用同一个 `sourceFileId` 作为可读 `fileId`。

不要丢弃连续性字段。内容读取保留 OpenAPI 的 `{ file, content }` 结构，并保留所有 `readActions`。产品如果有意把工具输出压平，必须把映射写成明确的适配契约，同时保留 `frontmatter`、`okfSignals`、`activeContentRevision`、`fileId` 和 `path`。

## 安全规则

- Focowiki OpenAPI 密钥只保存在后端。
- Agent 或产品用户调用后端前必须完成鉴权。
- 每个请求都要按知识库授权。
- 拒绝存储路径，只接受 Focowiki 返回的 `fileId` 或逻辑 `path`。
- 使用分页和单请求限制。
- `nextCursor` 只能和相同接口参数及 `activeContentRevision` 一起复用。
- 保留 `{ error, requestId }` 错误包；`RATE_LIMITED` 应遵循 `retryAfterSeconds`，`SEARCH_TIMEOUT` 或 `SEARCH_UNAVAILABLE` 不能被映射成 `no_candidates`。
- 记录请求 ID 和稳定错误码，方便排查问题。

## 实现结构

适配层保持小模块拆分：

| 模块 | 用途 |
| --- | --- |
| `config` | 加载 Focowiki 服务地址和凭据。 |
| `focowikiClient` | 调用 Developer OpenAPI 并规范化错误。 |
| `knowledgeAccess` | 选择知识库并执行授权。 |
| `agentRoutes` | 暴露最小的面向 Agent 接口。 |

这个结构便于审查，也方便后续替换成更完整的搜索层。
