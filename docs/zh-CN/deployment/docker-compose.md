---
title: Docker Compose 部署
---

# Docker Compose 部署

本指南使用生产 Docker Compose 模板和已发布的 GitHub Container Registry 镜像启动 Focowiki。

## 部署要求

生产部署需要：

| 服务 | 用途 |
| --- | --- |
| PostgreSQL | 保存知识库、文件记录、处理状态、设置、OpenAPI key 和关系数据。 |
| Redis | 保存登录 session、限流计数、分页和短期任务状态。 |
| Meilisearch | 为每个知识库保存一个搜索索引。 |
| S3 兼容存储 | 保存上传的 Markdown 和生成后的知识库文件。 |
| 反向代理 | 为 Admin UI、Admin API 和 Developer OpenAPI 提供 HTTPS 访问。 |

模板会启动 PostgreSQL、Redis 和可选的私有 Meilisearch。外部 S3 兼容服务需要在 `.env` 中配置。

## 准备文件

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data/postgres data/redis data/meilisearch data/meilisearch-snapshots data/meilisearch-dumps runtime-secrets logs backups
```

启动前填写 `.env`。所有生产变量见 [环境变量配置](./environment.md)，启动后可以修改的配置见 [Admin 配置](./admin-settings.md)。

真实 `.env` 和复制后的 `docker-compose.yml` 不要提交到 git。

## 模板启动的服务

| Compose 服务 | 说明 |
| --- | --- |
| `admin` | Admin UI。 |
| `api` | Admin API 和 Developer OpenAPI。 |
| `source-worker` | 处理上传的 Markdown 文件。 |
| `publication-worker` | 让已经处理完成的文件更新可以被读取。 |
| `maintenance-worker` | 执行搜索和存储维护。 |
| `migrate` | 在应用服务启动前检查并更新数据库。 |
| `postgres` | PostgreSQL 数据库。 |
| `redis` | Redis 服务。 |
| `meilisearch` | 可选的模板附带搜索服务，通过 `COMPOSE_PROFILES=bundled-search` 启用。 |
| `meilisearch-init` | 在启动期间准备搜索服务访问。 |

生产模板只把 Admin UI、Admin API 和 Developer OpenAPI 发布到 `127.0.0.1`。PostgreSQL、Redis 和 Meilisearch 保持在 Compose 私有网络内。

## 拉取镜像

```bash
docker compose -f docker-compose.yml pull
```

镜像变量默认使用 `latest`。生产环境应把两个镜像固定为相同的发布版本。

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
```

## 启动服务

首次启动前执行一次数据库命令，然后启动全部服务。

```bash
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

默认本地地址使用 `.env` 中的端口：

| 服务 | 本地 URL |
| --- | --- |
| Admin UI | `http://127.0.0.1:${ADMIN_UI_PORT}` |
| Admin API | `http://127.0.0.1:${ADMIN_API_PORT}` |
| Developer OpenAPI | `http://127.0.0.1:${PUBLIC_OPENAPI_PORT}` |

公开访问应通过 `.env` 中配置的 HTTPS origins。

## 检查启动状态

```bash
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail=200 api source-worker publication-worker maintenance-worker
```

所有长期运行的服务都应显示 healthy。启动失败时，先检查 `migrate`、`meilisearch-init` 或异常服务的第一条错误。常见原因包括基础设施不可访问、凭据错误、公网 origin 无效，或者数据库来自不受支持的旧版本。

启动后：

1. 打开 Admin UI，使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。
2. 检查 Admin 配置。
3. 创建知识库并上传一个小型 Markdown 文件。
4. 确认文件变为可见，并且可以读取和搜索。
5. 创建 OpenAPI key，并检查 Developer OpenAPI。

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

`docker compose logs -f` 用于查看容器输出。产品日志文件保存在 `./logs`，限制见 [环境变量配置](./environment.md#运行模式)。

`pnpm compose:clean` 会删除当前服务使用的容器、Docker 管理的卷、孤立容器和本地镜像副本。`data`、`runtime-secrets` 和 `logs` 目录仍会保留。只有确定要删除部署数据时才删除这些目录。

## 更新现有部署

每次更新前都要阅读发行说明。当前存储版本无法直接使用破坏性存储更新之前的数据库。执行这次升级时，需要保留旧部署的有效备份，使用空的 PostgreSQL、Redis、Meilisearch 和 S3 位置，并重新导入 Markdown 文件。完成知识库数量、文件路径、预览、搜索、关系和 API 访问检查前，保留旧部署。

更新到继续支持当前数据库格式的后续版本时：

1. 创建备份。
2. 更新 `.env` 中两个镜像的版本并拉取镜像。
3. 完成发行说明要求的准备工作。
4. 执行数据库命令。
5. 启动更新后的服务。

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

数据库命令成功后可以再次执行。该命令不会处理上传文件，也不会重建搜索索引。版本更新需要维护索引时，知识库页面会显示维护操作。维护期间，已经可以读取的文件继续可用。

## 处理失败

来源文件列表会显示当前状态、当前步骤、失败信息和可用操作。

- 文件处理失败时使用**重试处理**。
- 文件已经处理完成但更新没有变为可见时使用**重试发布**。
- 可重复出现的失败需要先修正配置或服务错误，再执行重试。

文件到达 `state=visible` 后可以读取生成内容。较新的更新失败时，之前已经可见的内容继续可读。

## 备份

在 `.env` 和 `docker-compose.yml` 所在目录执行备份。停止会修改 Focowiki 数据的服务，并保持 PostgreSQL 运行。

```bash
docker compose -f docker-compose.yml stop api source-worker publication-worker maintenance-worker
pnpm compose:backup
```

上述服务仍在运行时，备份命令会拒绝继续。命令会生成带 checksum 的归档，其中包含 PostgreSQL 备份、所需 S3 文件、部署设置、`.env`、Compose 文件和部署所需的私密文件。归档及其 `.sha256` 文件应保存在当前服务器之外。

Redis 和 Meilisearch 数据可以重新生成。需要包含兼容的 Meilisearch snapshot 时，同时传入 `--meilisearch-snapshot` 和 `--meilisearch-snapshot-sha256`。

部署使用显式 Compose project name 时，备份和还原命令都需要传入相同的 `--project-name <name>`。

## 从备份还原

还原目标必须为空；目标中已有数据时先单独备份。

1. 停止全部服务。

   ```bash
   docker compose -f docker-compose.yml down
   ```

2. 配置 `.env`，指向空的 PostgreSQL 数据库和空的 S3 前缀，然后只启动 PostgreSQL。

   ```bash
   docker compose -f docker-compose.yml up -d postgres
   ```

3. 使用归档和 checksum 文件执行还原。

   ```bash
   pnpm compose:restore -- \
     --archive backups/focowiki-<backup-id>.tar.gz \
     --checksum backups/focowiki-<backup-id>.tar.gz.sha256
   ```

   还原命令会校验归档，并拒绝非空的数据库、S3 前缀或 `runtime-secrets` 目标。

4. 使用备份对应的 API 和 Admin 镜像版本。

5. 执行数据库命令并启动服务。

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

6. 未还原兼容的 Meilisearch snapshot 时，对每个知识库执行**维护索引**。

允许新写入前，检查知识库数量、文件路径、预览、搜索、关系导航、Admin UI 登录、Developer OpenAPI health 和 Worker health。

## 容量说明

观察部署资源后，再通过 Admin UI 调整 Worker、发布、维护、搜索和图关系配置。避免使用一次性读取全部来源文件或全部关系数据的脚本。详见 [Admin 配置](./admin-settings.md)。
