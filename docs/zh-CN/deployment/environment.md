---
title: 环境变量配置
---

# 环境变量配置

本页说明生产环境 `.env.example` 中的变量。复制模板、替换所有占位符，并确保生成的 `.env` 不会提交到 git。

```bash
cp .env.example .env
```

密码和服务凭据应使用足够长的随机值。启动后可以修改的配置见 [Admin 配置](./admin-settings.md)。

## 运行模式

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `APP_ENV` | 生产环境 | 公开部署使用 `production`。 |
| `LOG_LEVEL` | 可选 | 可选值为 `error`、`warn`、`info`、`debug`。生产环境默认 `info`。 |
| `LOG_FILE_DIR` | 可选 | 运行日志目录。Compose 模板使用 `logs`，挂载到容器内 `/app/logs`。 |
| `LOG_FILE_MAX_BYTES` | 可选 | 单个日志文件的最大字节数。模板使用 `10485760`。 |
| `LOG_FILE_MAX_FILES` | 可选 | 每类日志最多保留的文件数。模板使用 `5`。 |
| `LOG_FILE_MAX_TOTAL_BYTES` | 可选 | 运行日志文件总大小上限。模板使用 `67108864` 字节。 |
| `LOG_FILE_RETENTION_DAYS` | 可选 | 日志最长保留天数。模板使用 `7`。 |

Focowiki 会把运行日志写入 `./logs`，同时继续向容器 stdout 和 stderr 输出日志。每个 Compose 服务的 Docker 日志单文件上限为 `10m`，最多保留 `3` 个文件。

生产 Compose 模板把 PostgreSQL 数据保存在 `./data/postgres`，Redis 数据保存在 `./data/redis`，搜索数据保存在 `./data/meilisearch`，搜索备份保存在 `./data/meilisearch-snapshots` 和 `./data/meilisearch-dumps`，部署私密文件保存在 `./runtime-secrets`。迁移或备份部署时需要保留这些目录。

## 部署镜像

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | 可选 | API 镜像，默认 `ghcr.io/farozerolabs/focowiki-api:latest`。生产环境建议固定版本标签。 |
| `FOCOWIKI_ADMIN_IMAGE` | 可选 | Admin UI 镜像，默认 `ghcr.io/farozerolabs/focowiki-admin:latest`。与 API 镜像使用相同版本。 |

## 管理员登录

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 是 | Admin UI 初始登录账号。 |
| `ADMIN_PASSWORD` | 是 | Admin UI 初始登录密码，应使用强密码。 |
| `ADMIN_SESSION_TTL_SECONDS` | 可选 | 登录有效期，单位秒。默认 `28800`。 |
| `ADMIN_SESSION_COOKIE_SECURE` | 可选 | 生产环境默认 `true`，使用 HTTPS 时必须保持 `true`。 |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | 可选 | 可选值为 `Lax`、`Strict`、`None`，默认 `Lax`。使用 `None` 时必须启用安全 Cookie。 |

## Admin API 与 Admin UI

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_API_PORT` | Compose 必填 | Admin API 的宿主机和容器端口。模板使用 `43000`。 |
| `ADMIN_UI_PORT` | Compose 必填 | Admin UI 的宿主机端口。模板使用 `43100`。 |
| `ADMIN_API_PROXY_TARGET` | Compose 必填 | Admin UI 代理访问 Admin API 的地址。生产模板使用 `http://api:43000`。 |
| `ADMIN_PUBLIC_ORIGIN` | 生产环境必填 | Admin UI 公网 HTTPS origin，例如 `https://admin.example.com`。 |
| `ADMIN_API_PUBLIC_ORIGIN` | 生产环境必填 | Admin API 公网 HTTPS origin，例如 `https://admin-api.example.com`。 |
| `ADMIN_TRUSTED_ORIGINS` | 可选 | 允许调用 Admin API 的浏览器 origins，多个值用英文逗号分隔。留空时使用 Admin UI origin 和本地开发 origins。 |
| `ALLOWED_HOSTS` | 生产环境必填 | API 接受的 hostnames，多个值用英文逗号分隔。包含反向代理转发的全部域名和本地健康检查 hostname。 |
| `TRUSTED_PROXY_MODE` | 可选 | 请求经过可信反向代理时设为 `true`。默认 `false`。 |

生产模板仅把 Admin UI、Admin API 和 Developer OpenAPI 绑定到 `127.0.0.1`，公开访问应通过 HTTPS 反向代理。

## PostgreSQL

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `POSTGRES_DB` | Compose 必填 | PostgreSQL 服务创建的数据库名。 |
| `POSTGRES_USER` | Compose 必填 | PostgreSQL 服务创建的数据库用户。 |
| `POSTGRES_PASSWORD` | Compose 必填 | 强数据库密码。密码写入 `DATABASE_URL` 时需要对特殊字符进行 URL 编码。 |
| `DATABASE_URL` | 是 | API 数据库连接地址。生产 Compose 网络使用 `postgres://USER:PASSWORD@postgres:5432/DB`。 |
| `DATABASE_POOL_MAX` | 可选 | 单个 API 进程最多使用的 PostgreSQL 连接数。默认 `10`。 |

生产模板中的 PostgreSQL 和 Redis 不会映射到宿主机端口。数据库管理可以使用 `docker compose exec postgres ...`；确实需要从宿主机访问时，在私有 Compose 文件中显式添加只绑定回环地址的端口映射。

## Redis

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `REDIS_URL` | 是 | Redis 连接地址。生产 Compose 网络使用 `redis://redis:6379/0`。 |

API 和所有 Worker 都需要访问 Redis。Redis 应保持在部署私有网络内。

## 搜索服务

生产模板可以启动私有 Meilisearch。多个 Focowiki 部署共用搜索服务时，每个部署必须使用不同的 `MEILI_INDEX_PREFIX`。

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `COMPOSE_PROFILES` | 可选 | 使用 `bundled-search` 启动模板附带的 Meilisearch。使用外部服务时留空。 |
| `MEILI_HOST` | Compose 必填 | API 和 Worker 可以访问的 Meilisearch 地址。模板附带服务使用 `http://meilisearch:7700`。 |
| `MEILI_MASTER_KEY` | 使用附带服务时必填 | Meilisearch master key，至少使用 16 字节随机内容。 |
| `MEILI_API_KEY` | 使用外部服务时必填 | 外部服务提供的应用访问 key，需要时取消模板中的注释。 |
| `MEILI_METRICS_API_KEY` | 使用外部服务时必填 | 外部服务提供的诊断访问 key，需要时取消模板中的注释。 |
| `MEILI_INDEX_PREFIX` | 是 | 当前部署独占的小写索引前缀，例如 `focowiki_prod`。 |
| `MEILI_MAX_INDEXING_MEMORY` | 使用附带服务时必填 | Meilisearch 索引内存上限。模板使用 `2GiB`。 |
| `MEILI_MAX_INDEXING_THREADS` | 使用附带服务时必填 | Meilisearch 索引线程数。模板使用 `2`。 |
| `MEILI_SNAPSHOT_DIR` | 使用附带服务时必填 | 容器内 snapshot 目录。模板使用 `/meili_snapshots`。 |
| `MEILI_SCHEDULE_SNAPSHOT` | 使用附带服务时必填 | snapshot 间隔秒数。模板使用 `86400`。 |
| `MEILI_DUMP_DIR` | 使用附带服务时必填 | 容器内 dump 目录。模板使用 `/meili_dumps`。 |

使用模板附带服务时，`.env` 和 `runtime-secrets` 都需要保持私密并纳入部署备份。使用外部服务时，应在启动前创建两个所需 key，并确认每个 Focowiki 容器都能访问该服务。

## Developer OpenAPI

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `PUBLIC_OPENAPI_PORT` | Compose 必填 | Developer OpenAPI 的宿主机和容器端口。模板使用 `43200`。 |
| `PUBLIC_BASE_URL` | 是 | API 链接使用的公网 HTTPS 地址，例如 `https://openapi.example.com`。 |
| `PUBLIC_OPENAPI_PUBLIC_ORIGIN` | 可选 | Developer OpenAPI 的公网 HTTPS origin，默认使用 `PUBLIC_BASE_URL`。 |

Developer OpenAPI key 在 Admin UI 中创建，不要写入 `.env`。

## S3 兼容存储

生产 Compose 模板不启动对象存储服务。需要配置所有 Focowiki 容器都能访问的 AWS S3、Cloudflare R2、MinIO 或其他 S3 兼容 bucket。

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `S3_ENDPOINT` | 是 | 存储服务 endpoint URL。 |
| `S3_REGION` | 是 | 存储服务要求的 region。 |
| `S3_BUCKET` | 是 | 当前部署使用的 bucket。 |
| `S3_ACCESS_KEY_ID` | 是 | 后端使用的存储访问 key ID。 |
| `S3_SECRET_ACCESS_KEY` | 是 | 后端使用的存储 secret key。 |
| `S3_PREFIX` | 是 | 当前部署独占的非空对象 key 前缀，例如 `production`。 |
| `S3_FORCE_PATH_STYLE` | 可选 | 默认 `false`。存储服务要求 path style 时使用 `true`；AWS S3 通常使用 `false`。 |

凭据需要在配置前缀下列出 bucket，并读取、写入、检查和删除对象。备份与还原还要求存储服务支持列出对象版本。每个环境使用独立 bucket 或前缀。

## 分页与内容限制

本节变量均为可选项，`.env.example` 中的值可作为初始值。

| 变量 | 用途 |
| --- | --- |
| `ADMIN_LIST_DEFAULT_PAGE_SIZE` | Admin 列表默认页大小。 |
| `ADMIN_LIST_MAX_PAGE_SIZE` | Admin 列表允许的最大页大小。 |
| `TREE_CHILD_DEFAULT_PAGE_SIZE` | 生成文件树直接子节点的默认页大小。 |
| `TREE_CHILD_MAX_PAGE_SIZE` | 生成文件树直接子节点的最大页大小。 |
| `PAGINATION_CURSOR_TTL_SECONDS` | 分页读取 cursor 的有效秒数。 |
| `GENERATED_CONTENT_MAX_BYTES` | 单次 API 响应允许返回的生成文件最大字节数，超过时返回 HTTP 413。 |

## Worker 数据库连接池

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `SOURCE_WORKER_DATABASE_POOL_MAX` | 可选 | 单个来源处理 Worker 使用的 PostgreSQL 连接数。默认 `6`，模板使用 `8`。 |
| `PUBLICATION_WORKER_DATABASE_POOL_MAX` | 可选 | 单个发布 Worker 使用的 PostgreSQL 连接数。默认 `4`。 |
| `MAINTENANCE_WORKER_DATABASE_POOL_MAX` | 可选 | 单个维护 Worker 使用的 PostgreSQL 连接数。默认 `2`。 |

使用多个副本时，需要汇总所有 API 和 Worker 的连接池上限，并为迁移和管理员访问预留连接。

## 安全审计

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `SECURITY_AUDIT_RETENTION_DAYS` | 可选 | 安全审计记录的保留天数。默认 `30`。 |

## 生产检查清单

启动前确认：

1. `.env` 中所有占位符均已替换。
2. API 与 Admin UI 镜像固定为同一个 Focowiki 版本。
3. 公网 origins 使用 HTTPS，并与反向代理域名一致。
4. `ALLOWED_HOSTS` 包含反向代理转发给 API 的全部 hostname。
5. 容器可以访问 PostgreSQL、Redis、Meilisearch 和 S3。
6. S3 凭据可以在选定前缀下执行所需操作。
7. `data`、`logs`、`runtime-secrets` 和 `backups` 可写并已纳入备份计划。
8. 首次登录后检查 Admin 配置。
