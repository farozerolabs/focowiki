---
title: Docker Compose 部署
---

# Docker Compose 部署

本指南使用生产 Docker Compose 模板和 GitHub Container Registry 镜像启动 Focowiki。

## 部署要求

生产部署需要：

| 服务 | 用途 |
| --- | --- |
| PostgreSQL | 保存来源修订、持久化角色任务、发布 generation、投影记录、OpenAPI key、运行配置和审计证据。 |
| Redis | 保存 session、限流计数、cursor、短期缓存、通知和范围协调状态。 |
| S3 兼容存储 | 保存上传来源修订和内容寻址的生成 Markdown 与投影对象。 |
| 反向代理 | 为 Admin UI、Admin API 和 Developer OpenAPI 提供 HTTPS public origins。 |

Compose 模板会启动 PostgreSQL 和 Redis。外部 S3 兼容服务需要在 `.env` 中配置。

## 准备文件

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data/postgres data/redis runtime-secrets logs backups
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

`pnpm compose:clean` 会删除生产 Compose stack 使用的 deployment containers、Docker 管理的 named volumes、orphans 和本地镜像副本。部署目录下的 `data`、`runtime-secrets` 和 `logs` 会保留。只有明确要删除本地部署数据时，才手动删除这些目录。

## 启动之后

1. 打开 Admin UI。
2. 使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。
3. 创建知识库。
4. 在 Admin UI 中创建或复制 OpenAPI key。
5. 使用这个 key 调用 Developer OpenAPI。

继续阅读 [Developer OpenAPI](../openapi/index.md)。

## 发布失败诊断

来源文件列表会返回统一的生命周期状态、当前阶段、安全失败详情和允许执行的操作。`state=failed` 的行会标明终止阶段，并提供可以与产品日志对应的关联 ID。

来源文件处理失败时使用“重试处理”。必要投影校验或 generation 激活失败时使用“重试发布”。发布重试会保留已完成的来源事实并继续合并后的 generation。确定性的校验失败需要在修正原因后显式重试。

文件只有在 `state=visible` 后才能读取生成内容。候选 generation 通过变更投影校验并成功激活前不会进入正常读取。候选 generation 失败时，之前的活动 generation 继续保持可读。

## 备份

在 `.env` 和 `docker-compose.yml` 所在的部署目录中停止服务并打包本地持久化目录。

```bash
docker compose -f docker-compose.yml down
backup_id="$(date +%Y%m%d-%H%M%S)" && mkdir -p backups data/postgres data/redis runtime-secrets logs && tar -czf "backups/focowiki-$backup_id.tar.gz" .env docker-compose.yml data runtime-secrets logs
```

外部 S3 兼容 bucket 或 prefix 需要通过存储服务提供的快照、复制或导出功能单独备份。PostgreSQL 和 S3 备份应来自同一个时间点。

## 从备份还原

只在目标部署目录中执行还原。继续前先给当前状态再做一次备份。

1. 停止 stack。

   ```bash
   docker compose -f docker-compose.yml down
   ```

2. 在部署目录中解压备份。

   ```bash
   tar -xzf backups/focowiki-<backup-id>.tar.gz
   ```

3. 将外部 S3 兼容 bucket 或 prefix 还原或复制到 `.env` 当前配置的位置。

4. 将 API 和 Admin 镜像标签改为备份对应的版本。

5. 执行迁移并启动 stack。

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

6. 检查 Admin UI 登录、知识库列表、文件预览、Developer OpenAPI health 和 Worker 状态。

## 图关系处理说明

Focowiki 将基于正文的图关系事实和活动图投影保存在 PostgreSQL。Redis 提供短期协调和查询缓存。生成后的图关系 Markdown 与机器分片以不可变 S3 对象保存，并由活动 generation 引用。

图关系处理应受 Admin UI 运行时设置控制。避免使用自定义脚本把完整 source corpus 或完整 graph 加载到进程内存。

API 限流、Worker、发布、图关系和模型配置见 [Admin 配置](./admin-settings.md)。
