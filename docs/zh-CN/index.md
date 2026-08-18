---
title: 项目介绍
---

# Focowiki

Focowiki 是一个面向开发者和产品经理的轻量级 Markdown 知识库系统。它接收清洗后的 `.md` 文件，保留 Markdown 前置元数据和文档信号，生成 OKF 风格的文件知识库，并通过 Admin UI、Admin API 和 Developer OpenAPI 提供知识库工作流。

Focowiki 适合已经拥有 Markdown 知识资产的团队。团队可以用一个小型自托管服务生成面向人员、应用和 Agent 的文件知识库。

![Focowiki 架构图](/images/focowiki-architecture.png)

## Focowiki 提供什么

Focowiki 将 Markdown 文件和文件夹生成可供用户、应用和 AI Agent 探索的知识库。

- **上传文档和文件夹。** 添加单个 Markdown 文件或完整的多层文件夹，并保留路径、名称、元数据、链接和正文。
- **浏览结构化知识。** 通过文件树打开文档，移动或重命名文件和文件夹，替换正文并删除过时内容。
- **查找相关文档。** 搜索文件内容、浏览目录索引、查看相关文档，并通过知识图谱继续探索关联内容。
- **接入应用和 AI Agent。** 使用 Developer OpenAPI 上传内容、浏览文件树、读取完整 Markdown 文件、执行搜索、探索图关系并管理文档变更。
- **通过 Admin UI 管理系统。** 创建知识库、查看文件处理进度、配置模型和运行参数，并管理 API 密钥。
- **部署到自己的基础设施。** 使用 Docker Compose、PostgreSQL、Redis、OpenSearch 或 Meilisearch，以及 S3 兼容存储运行 Focowiki。

## Admin UI 预览

![Focowiki Admin UI 知识库详情页](/images/focowiki-admin-detail.png)

## Open Knowledge Format

[Google 的 OKF 0.2 公告](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals) 将 OKF 描述为一种开放、可移植、适合人类阅读和 Agent 读取的知识表示方式，基于 Markdown 文件和可选的 YAML 前置元数据。

[固定版本的 OKF 0.2 规范](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/930b65fc3f5619d5d0591f88c72ebae8b848d60d/okf/SPEC.md) 增加了结构化来源、生成、验证、生命周期和 Attested Computation 元数据。Focowiki 保持相同的实用文件模型：Markdown 页面、YAML 前置元数据、链接、索引和稳定的文件树。

## Markdown 上传格式

上传文件必须是 `.md`。每个文件可以是普通 Markdown，也可以包含 YAML 前置元数据，后面跟 Markdown 正文。下面所有 OKF 0.2 字段均为可选上传字段。

```md
---
okf_version: "0.2"
type: "Guide"
title: "Customer Support Playbook"
description: "How the support team handles priority customer requests."
tags:
  - support
  - operations
sources:
  - id: "support-handbook"
    resource: "references/support-handbook.md"
generated:
  by: "publisher:docs"
  at: "2026-06-16T00:00:00Z"
verified:
  - by: "human:support-reviewer"
    at: "2026-06-16T01:00:00Z"
status: "stable"
stale_after: "2026-12-16"
---

# Customer Support Playbook

Use this playbook when a priority customer request arrives.

## Intake

Record the customer, request summary, severity, and expected response time.

## Related Documents

- [Escalation rules](./escalation-rules.md)
- [Incident handoff](./incident-handoff.md)
```

常见 OKF 风格字段：

| 字段 | 用途 |
| --- | --- |
| `type` | 内容类型，例如 `Guide` 或 `Attested Computation`。 |
| `title` | 生成页面的展示标题。 |
| `description` | 面向读者和搜索的简短摘要。 |
| `tags` | 可搜索标签。 |
| `sources` | 结构化来源 ID、资源路径和可选使用时间范围。 |
| `generated` | 存在可靠生成证据时记录生产方和事件时间。 |
| `verified` | 一个或多个机器或人工验证事件。 |
| `status` | 生命周期值：`draft`、`stable` 或 `deprecated`。 |
| `stale_after` | 内容被视为过期的日期。 |

额外的安全前置元数据字段可以保留。缺失、不完整、类型错误或格式错误的 OKF 字段本身不会阻止上传。原始前置元数据保持可读；无法规范化的值返回 `null`，仅在使用对应 OKF 搜索筛选时被排除。旧版 `timestamp` 仍可读取，并会被明确标识为回退来源。

Markdown 链接是主要关系机制。正文中的链接帮助读者和 Agent 从一个生成页面移动到相关页面。

## 产品流程

1. 配置 PostgreSQL、Redis、所选搜索服务、S3 兼容存储、Admin 凭据、启动种子设置和服务端口。
2. 使用 Docker Compose 或本地开发命令启动 Focowiki。
3. 打开 Admin UI，检查运行时设置，并创建知识库。
4. 上传一个或多个清洗后的 Markdown 文件。
5. 查看来源文件处理状态，等待每个文件处理结束。
6. 通过 Admin UI 或 Developer OpenAPI 读取生成后的知识库文件。
7. 使用 Developer OpenAPI 密钥接入应用后端或面向 Agent 的后端。

## 下一步

- [了解 Google OKF 规范](./guide/open-knowledge-format.md)
- [了解来源文件证据与图关系](./guide/file-first-graph.md)
- [使用 Docker Compose 部署](./deployment/docker-compose.md)
- [使用 Developer OpenAPI](./openapi/index.md)
- [接入 Agent](./agent-integration/index.md)
