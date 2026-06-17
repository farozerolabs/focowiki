---
title: Agent 接入
---

# Agent 接入

Focowiki 通过 Developer OpenAPI 暴露知识库数据。Agent 产品通常会增加一个开发者后端：这个后端保存 Focowiki OpenAPI key，选择知识库，并向 Agent 暴露一个小型读取接口。

本节说明两种接入模式：

| 模式 | 使用场景 | Agent 接入形态 |
| --- | --- | --- |
| 自有 Agent 客户端 | 开发者控制 Agent runtime，并且可以注册内置工具。 | Agent 调用开发者注册的 `list_tree`、`read_file`、`get_file`、`search_files` 等工具。 |
| 第三方 Agent 客户端 | Agent 客户端支持 instructions 和 HTTP access，但无法注册开发者自己的内置工具。 | Skill 通过 HTTP 请求访问开发者提供的只读知识库端点。 |

## 推荐架构

```mermaid
flowchart LR
  OwnAgent["自有 Agent 客户端"] --> Tools["内置知识库工具"]
  ThirdParty["第三方 Agent Skill"] --> Endpoint["只读知识库端点"]
  Tools --> Backend["开发者后端"]
  Endpoint --> Backend
  Backend --> OpenAPI["Focowiki Developer OpenAPI"]
  OpenAPI --> Bundle["生成后的知识库 bundle"]
```

开发者后端是控制点。它保存 Developer OpenAPI base URL 和 key，将产品用户映射到允许访问的知识库，并决定 Agent 可以调用哪些读取能力。

Agent、Skill 或内置工具只调用开发者控制的接口。Focowiki OpenAPI key 保留在后端。

## 后端使用哪些接口

开发者后端通常调用这些 Focowiki 接口：

| 用途 | Developer OpenAPI operation |
| --- | --- |
| 解析可用知识库 | `listKnowledgeBases` |
| 创建和维护知识库 | `createKnowledgeBase`、`deleteKnowledgeBase` |
| 上传 Markdown 文件 | `uploadMarkdownFiles` |
| 观察入库和批量进度 | `listKnowledgeBaseTasks`、`getKnowledgeBaseTask` |
| 读取生成文件树 | `listKnowledgeBaseTree` |
| 读取文件元数据 | `getFileById` |
| 按稳定标识读取文件内容 | `getFileContentById` |
| 按逻辑路径读取文件内容 | `getFileContentByPath` |
| 删除生成文件 | `deleteFileById`、`deleteFileByPath` |
| 管理 Webhook | `listWebhooks`、`createWebhook`、`deleteWebhook`、`listWebhookDeliveries`、`redeliverWebhook` |

这些接口服务于开发者后端和产品工作流。Agent-facing interface 默认保持读取为主。只有产品明确需要 Agent 维护知识库时，才向 Agent 暴露写入或删除能力。

## 后端向 Agent 暴露什么

最小可用的 Agent-facing backend 可以暴露这些操作。在自有 Agent 客户端中，它们表现为内置工具。在第三方 Agent 客户端中，它们表现为只读知识库 URL 下的 HTTP endpoints。

| Agent-facing operation | 用途 |
| --- | --- |
| `list_tree` | 返回一个知识库的分页生成文件条目。 |
| `read_file` | 按 `fileId` 或逻辑 `path` 返回 Markdown 内容。 |
| `get_file` | 返回文件的安全元数据。 |
| `search_files` | 可选操作，由你的搜索层或生成索引文件支持。 |

接口保持小而稳定。Agent 可以发现文件树、读取单个文件、沿着链接继续探索，并重复这个过程。

## 不同模式的接口形态

| 模式 | 接口示例 |
| --- | --- |
| 自有 Agent 客户端 | `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "limit=50"`、`curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"` |
| 第三方 Agent 客户端 | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`、`curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..."` |

## 探索流程

1. 先读取 `index.md`，了解知识库整体结构。
2. 再读取 `schema.md`，理解生成文件约定和 metadata 字段。
3. 分页列出文件树。
4. 按 `fileId` 或 `path` 读取最相关页面。
5. 沿着 Markdown links 和 metadata relationships 继续读取相关文件。
6. 任务没有要求完整导出时，避免一次性读取所有文件。

这个流程可以让请求更稳定，并限制内存、CPU 和 token 消耗。

## 下一步

- [后端适配](./backend-adapter.md)
- [自有 Agent 客户端 Tools 设计](./own-agent-client/tools-design.md)
- [自有 Agent 客户端 Skill 设计](./own-agent-client/skill-design.md)
- [第三方 Agent 客户端 Skill 设计](./third-party-agent-client/skill-design.md)
