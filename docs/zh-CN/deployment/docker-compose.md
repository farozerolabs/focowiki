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

启动前填写 `.env`。启动变量、必填项、可选项和生产填写方式见 [环境变量配置](./environment.md)。在 Admin UI 中修改的运行时配置见 [Admin 配置](./admin-settings.md)。

真实 `.env` 文件和复制后的 Compose 文件应留在 git 之外。

## Runtime logging

`APP_ENV=production` 会启用生产安全运行方式。API error responses 不会把内部诊断信息写入 response body。Admin UI 生产构建会移除产品代码中的 `console.log`、`console.debug`、`console.info` 和 `debugger` statements。

文件日志、日志轮转和 Docker 日志限制见 [环境变量配置](./environment.md#运行模式)。

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

## 升级前备份

已有部署拉取新镜像或执行迁移前，先创建备份。备份目录应留在 git 之外。

```bash
backup_id="$(date +%Y%m%d-%H%M%S)" && mkdir -p "backups/$backup_id" && cp .env docker-compose.yml "backups/$backup_id/"
```

备份 PostgreSQL。这个备份包含知识库、来源文件记录、运行时配置、OpenAPI key、生成文件记录、图关系记录、审计记录和 Worker 状态。

```bash
docker compose -f docker-compose.yml exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "backups/$backup_id/postgres.dump"
```

外部 S3 兼容 bucket 或 prefix 需要通过存储服务的 snapshot、replication、export 或 S3 兼容复制工具备份。PostgreSQL 备份和 S3 备份应来自同一个部署时间点。

Runtime secrets 和 Redis 属于运行时状态。需要保留已保存密钥保护材料、登录态、游标、锁、限流状态或运行中队列状态时，通过基础设施 snapshot 一并备份。

继续升级前，先检查备份文件。

```bash
ls -lh "backups/$backup_id"
```

## 升级顺序

已有部署使用这个顺序升级：

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
```

启动后打开 Admin UI，检查知识库列表、文件预览、Worker 状态和 Developer OpenAPI health。

## 执行迁移检查

```bash
docker compose -f docker-compose.yml run --rm migrate
```

迁移容器使用 API 镜像，数据库迁移完成后退出。这个命令适合在启动前显式检查迁移。生产 Compose 模板也会让 `api` service 依赖 `migrate` service，所以 `docker compose -f docker-compose.yml up -d` 会在 API 启动前执行迁移。

已有部署升级时使用同一迁移流程。迁移会新增运行时设置表，并保留已有知识库数据。升级后的首次启动中，如果数据库里还没有 Admin UI 保存的设置，Focowiki 会用启动默认值初始化 Admin 配置。

从使用 env session 签名的版本升级后，已有 Admin UI session 可能需要重新登录。知识库、OpenAPI key、文件和已保存的运行时配置会继续保留。

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

`docker compose logs -f` 用于查看 container stdout/stderr 日志。产品运行日志文件见 [环境变量配置](./environment.md#运行模式)。

`pnpm compose:clean` 会删除生产 Compose stack 使用的 deployment containers、named volumes、orphans 和本地镜像副本。它也会删除该 stack 拥有的本地 PostgreSQL 和 Redis 数据。

## 启动之后

1. 打开 Admin UI。
2. 使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。
3. 创建知识库。
4. 在 Admin UI 中创建或复制 OpenAPI key。
5. 使用这个 key 调用 Developer OpenAPI。

继续阅读 [Developer OpenAPI](../openapi/index.md)。

## 从备份还原

只在目标部署目录中执行还原。继续前先给当前状态再做一次备份。

1. 停止 stack。

   ```bash
   docker compose -f docker-compose.yml down
   ```

2. 将外部 S3 兼容 bucket 或 prefix 还原或复制到 `.env` 当前配置的位置。

3. 启动 PostgreSQL 和 Redis。

   ```bash
   docker compose -f docker-compose.yml up -d postgres redis
   ```

4. 还原 PostgreSQL。

   ```bash
   cat "backups/<backup-id>/postgres.dump" | docker compose -f docker-compose.yml exec -T postgres \
     sh -lc 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
   ```

5. 明确保留了 runtime secrets 和 Redis snapshot 时，再按基础设施备份进行还原。

6. 执行迁移并启动 stack。

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

7. 检查 Admin UI 登录、知识库列表、文件预览、Developer OpenAPI health 和 Worker 状态。

## 图关系处理说明

Focowiki 将 file graph nodes、graph edges 和 graph job records 保存在 PostgreSQL。Redis 在处理过程中协调 locks 和 pagination state。生成后的图关系文件会随 active bundle 一起发布到 S3 兼容存储。

图关系处理应受 Admin UI 运行时设置控制。避免使用自定义脚本把完整 source corpus 或完整 graph 加载到进程内存。

Worker、发布、上传生成、限流和模型配置见 [Admin 配置](./admin-settings.md)。

未发布阶段的开发部署可以破坏式重建数据。需要清空本地 PostgreSQL 和 Redis volumes 时，先停止 stack，执行 `pnpm compose:clean`，再启动 stack、执行迁移，并重新上传 Markdown 文件生成 graph-backed bundles。
