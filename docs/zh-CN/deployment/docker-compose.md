---
title: Docker Compose 部署
---

# Docker Compose 部署

本指南使用生产 Docker Compose 模板和 GitHub Container Registry 镜像启动 Focowiki。

## 部署要求

生产部署需要：

| 服务 | 用途 |
| --- | --- |
| PostgreSQL | 保存产品记录、来源文件处理记录、graph nodes、graph edges、发布、生成文件记录、OpenAPI key records 和 audit evidence。 |
| Redis | 保存 sessions、rate limits、cursors、coordination、locks 和 short-lived source-file refresh state。 |
| S3 兼容存储 | 保存上传源文件和生成后的 public bundles，包括 `_graph/` 文件。 |
| 反向代理 | 为 Admin UI、Admin API 和 Developer OpenAPI 提供 HTTPS public origins。 |

Compose 模板会启动 PostgreSQL 和 Redis。外部 S3 兼容服务需要在 `.env` 中配置。

## 准备文件

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
```

启动前填写 `.env`。重点配置分组：

| 分组 | 示例 |
| --- | --- |
| Admin | `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` |
| 端口和 origins | `ADMIN_UI_PORT`, `ADMIN_API_PORT`, `PUBLIC_OPENAPI_PORT`, `ADMIN_API_PROXY_TARGET`, `ADMIN_PUBLIC_ORIGIN`, `ADMIN_API_PUBLIC_ORIGIN`, `PUBLIC_BASE_URL`, `PUBLIC_OPENAPI_PUBLIC_ORIGIN` |
| Database | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL` |
| Redis | `REDIS_URL` |
| S3 兼容存储 | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
| Model provider | `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`, `MODEL_CONTEXT_WINDOW_TOKENS` |
| Runtime limits | Upload、task、model 和 API concurrency settings |

真实 `.env` 文件和复制后的 Compose 文件应留在 git 之外。

## 拉取镜像

```bash
docker compose -f docker-compose.yml pull
```

模板默认使用这些镜像：

| 镜像 | 默认 tag |
| --- | --- |
| `ghcr.io/farozerolabs/focowiki-api` | `latest` |
| `ghcr.io/farozerolabs/focowiki-admin` | `latest` |

如需固定版本，在 `.env` 中设置镜像变量。

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
```

## 执行迁移检查

```bash
docker compose -f docker-compose.yml run --rm migrate
```

迁移容器使用 API 镜像，数据库迁移完成后退出。这个命令适合在启动前显式检查迁移。生产 Compose 模板也会让 `api` service 依赖 `migrate` service，所以 `docker compose -f docker-compose.yml up -d` 会在 API 启动前执行迁移。

## 启动服务

```bash
docker compose -f docker-compose.yml up -d
```

默认服务地址由 `.env` 端口决定：

| 服务 | 本地 URL 格式 |
| --- | --- |
| Admin UI | `http://127.0.0.1:${ADMIN_UI_PORT}` |
| Admin API | `http://127.0.0.1:${ADMIN_API_PORT}` |
| Developer OpenAPI | `http://127.0.0.1:${PUBLIC_OPENAPI_PORT}` |

公开部署时，将 Admin UI、Admin API 和 Developer OpenAPI 放到 `.env` 配置的 HTTPS origins 后面。

## 常用命令

```bash
pnpm compose:config
pnpm compose:pull
pnpm compose:migrate
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down
pnpm compose:clean
```

`pnpm compose:clean` 会删除生产 Compose stack 使用的 deployment containers、named volumes、orphans 和本地镜像副本。它也会删除该 stack 拥有的本地 PostgreSQL 和 Redis 数据。

## 启动之后

1. 打开 Admin UI。
2. 使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。
3. 创建知识库。
4. 在 Admin UI 中创建或复制 OpenAPI key。
5. 使用这个 key 调用 Developer OpenAPI。

继续阅读 [Developer OpenAPI](../openapi/index.md)。

## 图关系处理说明

Focowiki 将 file graph nodes、graph edges 和 graph job records 保存在 PostgreSQL。Redis 在处理过程中协调 locks 和 pagination state。生成后的图关系文件会随 active bundle 一起发布到 S3 兼容存储。

图关系处理应受 `.env` 中的 runtime limits 控制。避免使用自定义脚本把完整 source corpus 或完整 graph 加载到进程内存。

未发布阶段的开发部署可以破坏式重建数据。需要清空本地 PostgreSQL 和 Redis volumes 时，先停止 stack，执行 `pnpm compose:clean`，再启动 stack、执行迁移，并重新上传 Markdown 文件生成 graph-backed bundles。
