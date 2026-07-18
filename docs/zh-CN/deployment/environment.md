---
title: 环境变量配置
---

# 环境变量配置

本页说明 `.env.example` 中的变量。部署前复制模板，并把占位符替换成当前服务器的真实值。

```bash
cp .env.example .env
```

真实 `.env` 文件不要提交到 git。密码、数据库凭据和 S3 凭据应使用足够长的随机值。

`.env` 是基础设施、端口、origins、登录初始化、日志、存储、分页保护和数据库连接池的启动配置。管理员可以在 Admin UI 中修改的运行时配置，见 [Admin 配置](./admin-settings.md)。

首次启动时，Focowiki 会使用产品默认值初始化 Admin 配置。保存后的 Admin 配置会控制 API 限流、Worker 执行、发布压力、图关系行为和模型配置。

## 运行模式

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `APP_ENV` | 是 | 公开部署使用 `production`。本地开发使用 `development`。 |
| `LOG_LEVEL` | 是 | 生产环境建议使用 `info`。可选值为 `error`、`warn`、`info`、`debug`。 |
| `LOG_FILE_DIR` | 是 | API 容器或进程工作目录内的日志目录。Docker Compose 使用 `logs`，对应容器内 `/app/logs`。 |
| `LOG_FILE_MAX_BYTES` | 是 | 单个运行日志文件触发轮转的最大字节数。默认值为 `10485760`。 |
| `LOG_FILE_MAX_FILES` | 是 | 每个日志流保留的文件数，包含当前写入文件。默认值为 `5`。 |

Focowiki 会把产品运行日志写入文件，同时继续输出 stdout/stderr。Docker Compose 模板也会把 Docker 自身日志限制为每个容器 `50m`、`3` 个文件。

Docker Compose 会把运行日志保存在部署目录下的 `./logs`。API 镜像会在启动 server 或 migration 前创建容器内 `/app/logs` 目录，并把目录权限交给运行时用户。

Docker Compose 会把 PostgreSQL 数据保存在 `./data/postgres`，把 Redis 数据保存在 `./data/redis`，把已保存 provider key 的保护材料保存在 `./runtime-secrets`。迁移服务器时需要随部署数据一起保留这些目录。删除 `./runtime-secrets` 后，需要在 Admin 配置中重新录入已保存的模型 API key。

## 部署镜像

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | 是 | API 镜像地址。模板默认使用 `ghcr.io/farozerolabs/focowiki-api:latest`。固定版本时使用 `:0.5.1` 这类 tag。 |
| `FOCOWIKI_ADMIN_IMAGE` | 是 | Admin UI 镜像地址。模板默认使用 `ghcr.io/farozerolabs/focowiki-admin:latest`。建议与 API 镜像使用相同版本 tag。 |

## 管理员登录

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 是 | 管理后台登录账号。 |
| `ADMIN_PASSWORD` | 是 | 管理后台登录密码。使用强密码。 |
| `ADMIN_SESSION_TTL_SECONDS` | 是 | session 有效期，单位秒。默认值为 `28800`。 |
| `ADMIN_SESSION_COOKIE_SECURE` | 是 | HTTPS 部署使用 `true`。本地 HTTP 开发可使用 `false`。 |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | 是 | Cookie SameSite 策略。标准同站管理后台访问使用 `Lax`。 |

管理员登录使用服务端 session。浏览器收到 HTTP-only session cookie，后端通过 Redis 校验会话。部署者不需要在 `.env` 中提供 session 签名密钥。

## Admin API

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_API_PORT` | 是 | Admin API 的容器内端口或宿主机端口。生产模板默认 `43000`。 |
| `ADMIN_API_PROXY_TARGET` | 是 | Admin UI 服务端代理到 Admin API 的地址。Docker Compose 使用 `http://api:43000`。本地开发通常使用 `http://127.0.0.1:43000`。 |
| `ADMIN_PUBLIC_ORIGIN` | 是 | Admin UI 的公网 HTTPS origin，例如 `https://admin.example.com`。 |
| `ADMIN_API_PUBLIC_ORIGIN` | 是 | Admin API 的公网 HTTPS origin，例如 `https://admin-api.example.com`。 |
| `ADMIN_TRUSTED_ORIGINS` | 是 | 允许调用 Admin API 的 Admin UI origins，多个值用英文逗号分隔。需要填写浏览器实际访问的 origin。 |
| `ALLOWED_HOSTS` | 生产环境必填 | API 接受的 hostnames，多个值用英文逗号分隔。应包含反向代理域名和本地健康检查 host。 |
| `TRUSTED_PROXY_MODE` | 是 | 位于可信反向代理后方时使用 `true`。本地直连使用 `false`。 |

## Admin UI

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_UI_HOST` | 是 | Admin UI 容器监听地址。Docker Compose 使用 `0.0.0.0`。 |
| `ADMIN_UI_PORT` | 是 | Admin UI 宿主机端口。生产模板默认 `43100`。 |
| `VITE_ADMIN_API_BASE_URL` | 可选 | 特殊部署下的浏览器 API base URL 覆盖值。标准 Admin UI 代理流程保持为空。 |

## PostgreSQL

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `POSTGRES_DB` | 是 | Compose PostgreSQL 服务创建的数据库名。 |
| `POSTGRES_USER` | 是 | Compose PostgreSQL 服务创建的数据库用户。 |
| `POSTGRES_PASSWORD` | 是 | 强数据库密码。 |
| `POSTGRES_PORT` | 是 | Compose PostgreSQL 暴露到宿主机的端口，可以与容器内端口 `5432` 不同。 |
| `DATABASE_URL` | 是 | API 使用的数据库连接串。Docker Compose 中应使用容器网络地址：`postgres://USER:PASSWORD@postgres:5432/DB`。 |
| `DATABASE_POOL_MAX` | 是 | API 和迁移进程最多使用的 PostgreSQL 连接数。 |

`POSTGRES_PORT` 用于宿主机访问 PostgreSQL。`DATABASE_URL` 在容器内使用，生产 Compose 网络中应指向 `postgres:5432`。

## Redis

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `REDIS_PORT` | 是 | Compose Redis 暴露到宿主机的端口。 |
| `REDIS_URL` | 是 | API 使用的 Redis 连接串。Docker Compose 中使用 `redis://redis:6379/0`。 |

`REDIS_PORT` 用于宿主机访问 Redis。`REDIS_URL` 由 API、Worker、迁移进程、sessions、cursors、coordination 和 rate limits 使用。

## Developer OpenAPI

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `PUBLIC_OPENAPI_PORT` | 是 | Developer OpenAPI 的容器内端口或宿主机端口。生产模板默认 `43200`。 |
| `PUBLIC_BASE_URL` | 是 | 生成链接时使用的公网 base URL，例如 `https://openapi.example.com`。 |
| `PUBLIC_OPENAPI_PUBLIC_ORIGIN` | 是 | Developer OpenAPI 的公网 HTTPS origin。 |
| `CORS_ORIGINS` | 是 | CORS 允许的浏览器 origins，多个值用英文逗号分隔。包含 Admin UI origin 和可信开发者前端 origin。 |

OpenAPI key 通过 Admin UI 创建，存储在数据库中，不应写入 `.env`。

## S3 兼容存储

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `S3_ENDPOINT` | 是 | S3 兼容 endpoint URL，例如 AWS S3、Backblaze B2、MinIO 或其他兼容服务。 |
| `S3_REGION` | 是 | 存储服务要求的 region。SDK 有校验要求时使用符合 hostname 规则的 region。 |
| `S3_BUCKET` | 是 | 保存源文件和生成知识库文件的 bucket 名称。 |
| `S3_ACCESS_KEY_ID` | 是 | 存储访问 key ID。 |
| `S3_SECRET_ACCESS_KEY` | 是 | 存储访问 secret key。 |
| `S3_PREFIX` | 是 | 内部对象 key 命名空间，例如 `production`。该值不会暴露在 public URLs 中。 |
| `S3_FORCE_PATH_STYLE` | 是 | 多数 S3 兼容服务使用 `true`。存储服务要求 virtual-host style 时使用 `false`。 |

每个环境建议使用独立 bucket 或 prefix。

## 分页和内容读取限制

这些值保留在 `.env` 中，因为它们决定 API 内存边界、Redis cursor 行为、响应大小和 PostgreSQL 连接池。

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_LIST_DEFAULT_PAGE_SIZE` | 是 | Admin source-file、task、generation 和 generated-file 列表的默认页大小。 |
| `ADMIN_LIST_MAX_PAGE_SIZE` | 是 | Admin 列表 API 接受的最大页大小。 |
| `TREE_CHILD_DEFAULT_PAGE_SIZE` | 是 | 生成文件树 API 的直接子节点默认页大小。 |
| `TREE_CHILD_MAX_PAGE_SIZE` | 是 | 生成文件树 API 接受的最大直接子节点页大小。 |
| `PAGINATION_CURSOR_TTL_SECONDS` | 是 | Admin 和 Developer OpenAPI 分页读取时 Redis cursor token 的有效秒数。 |
| `GENERATED_CONTENT_MAX_BYTES` | 是 | 单次 API 响应最多读取的生成文件内容字节数。更大的文件返回 413。 |

## Worker 启动配置

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `SOURCE_WORKER_DATABASE_POOL_MAX` | 是 | 单个 source-worker 进程最多使用的 PostgreSQL 连接数。8C/32G 服务器可从 `8` 开始。 |
| `PUBLICATION_WORKER_DATABASE_POOL_MAX` | 是 | 单个 publication-worker 进程最多使用的 PostgreSQL 连接数。可从 `4` 开始。 |
| `MAINTENANCE_WORKER_DATABASE_POOL_MAX` | 是 | 单个 maintenance-worker 进程最多使用的 PostgreSQL 连接数。可从 `2` 开始。 |

每个角色会在启动时创建自己的 PostgreSQL 连接池。修改 `.env` 后需要重启对应角色。总连接预算按 `API 副本数 * DATABASE_POOL_MAX + source-worker 副本数 * SOURCE_WORKER_DATABASE_POOL_MAX + publication-worker 副本数 * PUBLICATION_WORKER_DATABASE_POOL_MAX + maintenance-worker 副本数 * MAINTENANCE_WORKER_DATABASE_POOL_MAX + 迁移与运维余量` 计算。

## 安全审计

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `SECURITY_AUDIT_RETENTION_DAYS` | 是 | security audit records 保留天数。 |

API 限流在 [Admin 配置](./admin-settings.md) 中管理。运行时限流应结合反向代理、Cloudflare 或其他边缘层限流一起调整。

## 生产检查清单

执行 `docker compose up -d` 前确认：

1. 所有占位符都已替换。
2. `POSTGRES_PASSWORD` 和 `S3_SECRET_ACCESS_KEY` 保持私密。
3. 公网 origins 与反向代理域名一致。
4. `ALLOWED_HOSTS` 包含 Admin UI、Admin API、Developer OpenAPI、`127.0.0.1` 和 `localhost`，以支持容器内本地健康检查。
5. Docker 部署中的 `DATABASE_URL` 和 `REDIS_URL` 使用 Compose service names。
6. 部署目录下有可写的 `data`、`logs` 和 `runtime-secrets` 目录，或者 Docker 能够自动创建这些目录。
7. S3 凭据可以读写配置的 bucket 和 prefix。
8. 启动后打开 Admin UI，并检查 [Admin 配置](./admin-settings.md)。
