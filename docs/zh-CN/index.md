---
title: 项目介绍
---

# Focowiki

Focowiki 是一个轻量级 Markdown 知识库系统，面向开发者和产品经理。它接收清洗后的 `.md` 文件，提取 Markdown frontmatter 和文档信号，生成 OKF-style 文件知识库，将来源文件和生成文件保存到 S3 兼容存储，并通过 Admin UI、Admin API 和 Developer OpenAPI 暴露知识库工作流。

Focowiki 适合已经拥有 Markdown 知识资产的团队。团队可以用一个小型自托管服务生成面向人员、应用和 Agent 的文件知识库。

![Focowiki 架构图](/images/focowiki-architecture.png)

## Focowiki 提供什么

Focowiki 将 Markdown 文件和文件夹生成可供用户、应用和 AI Agent 探索的知识库。

- **上传文档和文件夹。** 添加单个 Markdown 文件或完整的多层文件夹，并保留路径、名称、元数据、链接和正文。
- **浏览结构化知识。** 通过文件树打开文档，移动或重命名文件和文件夹，替换正文并删除过时内容。
- **查找相关文档。** 搜索文件内容、浏览目录索引、查看相关文档，并通过知识图谱继续探索关联内容。
- **接入应用和 AI Agent。** 使用 Developer OpenAPI 上传内容、浏览文件树、读取完整 Markdown 文件、执行搜索、探索图关系并管理文档变更。
- **通过 Admin UI 管理系统。** 创建知识库、查看文件处理进度、配置模型和运行参数，并管理 API key。
- **部署到自己的基础设施。** 使用 Docker Compose、PostgreSQL、Redis、OpenSearch 或 Meilisearch，以及 S3 兼容存储运行 Focowiki。

## Admin UI 预览

![Focowiki Admin UI 知识库详情页](/images/focowiki-admin-detail.png)

## Open Knowledge Format

[Google 的 Open Knowledge Format 公告](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/) 将 OKF 描述为一种开放、可移植、适合人类阅读和 Agent 读取的知识表示方式，基于 Markdown 文件和 YAML frontmatter。

[固定版本的 OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md) 定义了字段约定和可移植目录结构。Focowiki 使用相同的实用模型：Markdown pages、YAML frontmatter、links、indexes 和稳定的文件树。

## Markdown 上传格式

上传文件必须是 `.md`。每个文件可以包含 YAML frontmatter，后面跟 Markdown 正文。

```md
---
type: "page"
title: "Customer Support Playbook"
description: "How the support team handles priority customer requests."
resource: "https://example.com/docs/support-playbook"
tags:
  - support
  - operations
timestamp: "2026-06-16T00:00:00Z"
owner: "Support Operations"
sourceSystem: "company-wiki"
---

# Customer Support Playbook

Use this playbook when a priority customer request arrives.

## Intake

Record the customer, request summary, severity, and expected response time.

## Related Documents

- [Escalation rules](./escalation-rules.md)
- [Incident handoff](./incident-handoff.md)
```

常见 OKF-style 字段：

| 字段 | 用途 |
| --- | --- |
| `type` | 内容类型，例如 `page`。 |
| `title` | 生成页面的展示标题。 |
| `description` | 面向读者和搜索的简短摘要。 |
| `resource` | 存在源 URL 或规范引用时使用。 |
| `tags` | 可搜索标签。 |
| `timestamp` | 源文件、发布或更新时间。 |

额外的安全 frontmatter 字段可以被保留。上传 Markdown 中存在 owner、region、product、version、source system、official identifier、status、category 等领域字段时，Focowiki 可以作为源元数据透传这些字段。

Markdown links 是主要关系机制。正文中的链接帮助读者和 Agent 从一个生成页面移动到相关页面。

## 产品流程

1. 配置 PostgreSQL、Redis、所选搜索服务、S3 兼容存储、Admin credentials、启动种子设置和服务端口。
2. 使用 Docker Compose 或本地开发命令启动 Focowiki。
3. 打开 Admin UI，检查运行时设置，并创建知识库。
4. 上传一个或多个清洗后的 Markdown 文件。
5. 查看来源文件处理状态，等待每个文件处理结束。
6. 通过 Admin UI 或 Developer OpenAPI 读取生成后的知识库文件。
7. 使用 Developer OpenAPI keys 接入应用后端或 Agent-facing backend。

## 下一步

- [了解 Google OKF 规范](./guide/open-knowledge-format.md)
- [了解文件优先图关系](./guide/file-first-graph.md)
- [使用 Docker Compose 部署](./deployment/docker-compose.md)
- [使用 Developer OpenAPI](./openapi/index.md)
- [接入 Agent](./agent-integration/index.md)
