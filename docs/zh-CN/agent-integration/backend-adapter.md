---
title: 后端适配
---

# 后端适配

后端适配层是你的产品连接 Focowiki Developer OpenAPI 的应用代码。它把 Focowiki 凭据保存在服务端，支持上传、源文件处理观察等产品工作流，并向 Agent 暴露更小的读取接口。

## 职责

| 职责 | 说明 |
| --- | --- |
| 凭据保存 | 在后端 secret manager 或 runtime configuration 中保存 Focowiki OpenAPI base URL 和 API key。 |
| 知识库选择 | 将产品租户、项目或用户映射到允许访问的 `knowledgeBaseId`。 |
| 请求整理 | 将产品级请求转换成 Focowiki OpenAPI 调用。 |
| 响应整理 | 只返回 Agent 探索和读取所需字段。 |
| 错误映射 | 将 Focowiki 错误码转换成稳定的应用错误。 |
| 速率控制 | 在请求进入 Focowiki 前应用产品级 rate limits。 |
| 模式路由 | 为自有 Agent 客户端提供内置工具，为第三方 Agent 客户端提供只读 HTTP endpoints。 |

## 接入步骤

1. 从 Focowiki Admin UI 创建 OpenAPI key。
2. 将 key 保存到后端环境变量或 secret manager。
3. 保存 Focowiki OpenAPI base URL，例如 `https://openapi.example.com`。
4. 解析或配置目标 `knowledgeBaseId`。
5. 增加一个小型 Focowiki client module，处理鉴权、JSON 解析、分页和错误映射。
6. 按产品需要增加知识库创建、上传、源文件观察、重试、删除和 Webhook 管理等工作流服务。
7. 增加 Agent-facing endpoints 或 tools，通过 client module 提供读取能力。

## 产品工作流边界

开发者后端可以使用完整的 Focowiki Developer OpenAPI：

| 工作流 | 常用 operations |
| --- | --- |
| 知识库管理 | `listKnowledgeBases`、`createKnowledgeBase`、`deleteKnowledgeBase` |
| Markdown 入库 | `uploadMarkdownFiles`、`listKnowledgeBaseSourceFiles`、`getKnowledgeBaseSourceFile`、`listKnowledgeBaseSourceFileEvents`、`retryKnowledgeBaseSourceFile` |
| 生成文件维护 | `listKnowledgeBaseTree`、`getFileById`、`getFileContentById`、`getFileContentByPath`、`deleteFileById`、`deleteFileByPath` |
| Webhooks | `listWebhooks`、`createWebhook`、`deleteWebhook`、`listWebhookDeliveries`、`redeliverWebhook` |

这些能力属于开发者后端。Agent-facing layer 默认只暴露探索所需的读取能力。只有产品明确支持 Agent 维护知识库时，才向 Agent 开放写入或删除能力。

## 最小后端接口

具体路由由你的产品决定。下面是一个适合 Agent 读取的简单形态：

| 后端路由或工具 | 调用 Focowiki | 返回 |
| --- | --- | --- |
| `GET /agent/knowledge/tree` | `listKnowledgeBaseTree` | 文件条目分页和 `nextCursor`。 |
| `GET /agent/knowledge/files/{fileId}` | `getFileById` | 安全文件元数据。 |
| `GET /agent/knowledge/files/{fileId}/content` | `getFileContentById` | Markdown 内容。 |
| `GET /agent/knowledge/files/content?path=...` | `getFileContentByPath` | 按逻辑路径读取的 Markdown 内容。 |
| `GET /agent/knowledge/search?query=...` | 你的搜索层或生成索引文件 | 供 Agent 继续读取的候选文件。 |

`search` 路由是可选项。第一版可以只提供文件树和文件读取。

第三方 Agent 客户端可以使用 `https://knowledge.example.com` 作为只读 base URL，并在后端内部路由到同一套 `/agent/knowledge` adapter。这样 Skill 看到的是 `/tree`、`/files/{fileId}`、`/files/content?path=index.md` 这类短路径，同时鉴权、授权和 Focowiki OpenAPI 调用仍然由开发者后端控制。

自有 Agent 客户端可以注册同一组 contract 的内置工具：

| 工具 | 后端路由 |
| --- | --- |
| `list_tree` | `GET /agent/knowledge/tree` |
| `get_file` | `GET /agent/knowledge/files/{fileId}` |
| `read_file` | `GET /agent/knowledge/files/{fileId}/content` 或 `GET /agent/knowledge/files/content?path=...` |
| `search_files` | `GET /agent/knowledge/search?query=...` |

## 标识符流转

后端应该保留 Focowiki 返回的同一组标识符：

| 标识符 | 来源 | 后续用途 |
| --- | --- | --- |
| `knowledgeBaseId` | Admin UI、`listKnowledgeBases` 或后端配置 | 限定所有 Focowiki 调用范围。 |
| `fileId` | 上传响应、源文件处理记录、文件树条目或文件详情响应 | 读取文件元数据和内容。 |
| `path` | 文件树条目 | 按逻辑路径读取文件内容。 |
| `cursor` | 列表响应 | 继续分页。 |

这样可以保证 Agent 调用流程连续。上一个调用返回的值可以直接用于下一个调用。

## 安全规则

- Focowiki OpenAPI key 只保存在后端。
- Agent 或产品用户调用后端前必须完成鉴权。
- 每个请求都要按知识库授权。
- 拒绝存储路径，只接受 Focowiki 返回的 `fileId` 或逻辑 `path`。
- 使用分页和单请求限制。
- 记录 request IDs 和稳定错误码，方便排查问题。

## 实现结构

适配层保持小模块拆分：

| 模块 | 用途 |
| --- | --- |
| `config` | 加载 Focowiki origin 和 credentials。 |
| `focowikiClient` | 调用 Developer OpenAPI 并规范化错误。 |
| `knowledgeAccess` | 选择知识库并执行授权。 |
| `agentRoutes` | 暴露最小 Agent-facing interface。 |

这个结构便于 review，也方便后续替换成更完整的搜索层。
