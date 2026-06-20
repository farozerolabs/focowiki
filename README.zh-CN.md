# Focowiki

中文 | [English](./README.md)

Focowiki 是一个开源 Markdown 知识库平台，面向开发者和产品经理。它接收清洗后的 `.md` 文件，生成 OKF-style 知识包，将源文件和生成文件保存到 S3 兼容存储，并提供用于管理知识库的 Admin UI。

这个项目适合希望自托管文件化知识系统的团队。生成后的知识包可以被人、应用和 Agent 通过文档化的产品接口读取。

<img src="./docs/public/images/focowiki-architecture.png" alt="Focowiki 架构图" width="880" />

## 文档

完整文档见 [docs.focowiki.com](https://docs.focowiki.com)。

以下内容请直接查看文档：

- [项目介绍](https://docs.focowiki.com/zh-CN/)
- [Docker Compose 部署](https://docs.focowiki.com/zh-CN/deployment/docker-compose)
- [使用 Agent 部署](https://docs.focowiki.com/zh-CN/deployment/agent-deployment)
- [Developer OpenAPI](https://docs.focowiki.com/zh-CN/openapi/)
- [Agent 接入](https://docs.focowiki.com/zh-CN/agent-integration/)
- [Open Knowledge Format 指南](https://docs.focowiki.com/zh-CN/guide/open-knowledge-format)
- [文件优先图关系指南](https://docs.focowiki.com/zh-CN/guide/file-first-graph)

## 项目来源

Focowiki 受到 Google Open Knowledge Format 工作的启发。

[Google 的 Open Knowledge Format 公告](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/) 描述了一种基于 Markdown 文件和 YAML frontmatter 的可移植知识表示方式。[OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) 定义了 metadata、Markdown pages、links、indexes 和 update logs 的约定。

Focowiki 将这个模型落实为一个可运行的产品。上传后的 Markdown 文件会生成 OKF-style public bundle，包含稳定的 Markdown pages、metadata、links、indexes 和 file tree，可在 Admin UI 中浏览，也可通过文档化的 Developer OpenAPI 接入。

## Focowiki 提供什么

- 只接收 `.md` 文件的 Markdown 上传流程。
- YAML frontmatter 和 Markdown 结构提取。
- OKF-style generated bundle，包含 `index.md`、`log.md`、`schema.md`、`pages/*.md`、`_index/*.json` 和 `_graph/*`。
- PostgreSQL-backed records，用于知识库、任务、发布、文件和 API keys。
- Redis-backed coordination，用于 sessions、cursors、rate limits 和 task state refresh。
- S3 兼容存储，用于上传源文件和生成后的 bundle 文件。
- Admin UI，用于登录、知识库管理、上传、文件树浏览、任务观察和 OpenAPI key 管理。
- Developer OpenAPI，用于后端集成。见 [Developer OpenAPI 文档](https://docs.focowiki.com/zh-CN/openapi/)。

## Admin UI 预览

<img src="./docs/public/images/focowiki-admin-detail.png" alt="Focowiki Admin UI 知识库详情页" width="880" />

## Agent Demo 运行结果

Demo Agent 运行结果展示了第三方 Agent 通过 demo 后端和 Skill 读取 Focowiki 法律知识库并回答问题。

<img src="./docs/public/images/demo-agent-zh-cn-1.png" alt="Demo Agent 中文运行结果，第 1 部分" width="880" />

<img src="./docs/public/images/demo-agent-zh-cn-2.png" alt="Demo Agent 中文运行结果，第 2 部分" width="880" />

查看 [Agent Demo 运行结果文档](https://docs.focowiki.com/zh-CN/agent-integration/demo-agent-result) 了解接入上下文。

## Markdown 输入

当前上传只接受 `.md` 文件。Markdown 文件可以包含 YAML frontmatter，后面跟 Markdown 正文。

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
---

# Customer Support Playbook

Use this playbook when a priority customer request arrives.
```

额外的安全 frontmatter 字段可以作为 pass-through metadata 保留。详细输入说明见 [项目介绍](https://docs.focowiki.com/zh-CN/)。

## Docker Compose 部署

仓库提供 Docker Compose 模板。生产部署使用发布到 GitHub Container Registry 的镜像，并连接你自己的 PostgreSQL、Redis 和 S3 兼容存储。

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

### 使用 Agent 部署

如果使用 Codex、Claude Code 或类似的 coding Agent，可以让 Agent 阅读这个仓库并协助使用 Docker Compose 部署 Focowiki。

```text
查看 farozerolabs/focowiki 仓库：
https://github.com/farozerolabs/focowiki

阅读 README.md，帮我使用 Docker Compose 部署 Focowiki。
```

默认生产镜像：

- `ghcr.io/farozerolabs/focowiki-api:latest`
- `ghcr.io/farozerolabs/focowiki-admin:latest`

Docker Compose 模板默认使用 `latest`。若需固定版本，在 `.env` 中直接指定镜像 tag：

```env
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.1.0
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.1.0
```

生产部署需要：

- PostgreSQL，用于产品记录、任务、发布、生成文件记录、API key records 和 audit evidence。
- Redis，用于 sessions、rate limits、cursors、coordination、locks 和 short-lived task refresh state。
- 外部 S3 兼容存储，用于上传源文件和生成后的 public bundles。
- 反向代理后的 HTTPS public origins，用于 Admin UI、Admin API 和 Developer OpenAPI。

Docker Compose 默认读取根目录 `.env` 文件。真实的 `docker-compose.yml`、`.env`、credentials、local paths、S3 keys、model keys、session secrets 和 raw Markdown data 应留在 git 之外。

配置细节和运行命令见 [Docker Compose 部署文档](https://docs.focowiki.com/zh-CN/deployment/docker-compose)。

## 本地开发

Focowiki 使用 pnpm、TypeScript、Vite、React、Hono、PostgreSQL、Redis 和 S3 兼容存储。

```bash
pnpm install
cp .env.dev.example .env
cp docker-compose.local.yml.example docker-compose.local.yml
docker compose -f docker-compose.local.yml up -d postgres redis
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

本地服务地址：

- Admin UI：`http://127.0.0.1:43100`
- Admin API：`http://127.0.0.1:43000`
- Developer OpenAPI：`http://127.0.0.1:43200`

真实上传解析需要在 `.env` 中配置 S3 兼容存储。

## License

Focowiki 使用 modified Apache License 2.0 发布。见 [LICENSE](./LICENSE)。

## References

- [Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [Focowiki documentation](https://docs.focowiki.com)
