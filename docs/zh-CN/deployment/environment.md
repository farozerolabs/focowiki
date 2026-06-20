---
title: 环境变量配置
---

# 环境变量配置

本页说明 `.env.example` 中的所有变量。部署前复制模板，并把占位符替换成当前服务器的真实值。

```bash
cp .env.example .env
```

真实 `.env` 文件不要提交到 git。密码、session secret、S3 凭据和模型 API key 应使用足够长的随机值。

## 运行模式

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `APP_ENV` | 是 | 公开部署使用 `production`。本地开发使用 `development`。 |
| `LOG_LEVEL` | 是 | 生产环境建议使用 `info`。可选值为 `error`、`warn`、`info`、`debug`。 |
| `LOG_FILE_DIR` | 是 | API 容器或进程工作目录内的日志目录。Docker Compose 使用 `logs`，对应容器内 `/app/logs`。 |
| `LOG_FILE_MAX_BYTES` | 是 | 单个运行日志文件触发轮转的最大字节数。默认值为 `10485760`。 |
| `LOG_FILE_MAX_FILES` | 是 | 每个日志流保留的文件数，包含当前写入文件。默认值为 `5`。 |
| `LOG_FILE_HOST_DIR` | 仅 Docker Compose 需要 | 挂载到 `/app/logs` 的宿主机目录。默认 `./logs` 相对于 `docker-compose.yml` 和 `.env` 所在的部署目录。 |

Focowiki 会把产品运行日志写入文件，同时继续输出 stdout/stderr。Docker Compose 模板也会把 Docker 自身日志限制为每个容器 `50m`、`3` 个文件。

API 镜像会在启动 server 或 migration 前创建挂载的 `/app/logs` 目录，并把目录权限交给运行时用户。

## 部署镜像

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | 是 | API 镜像地址。模板默认使用 `ghcr.io/farozerolabs/focowiki-api:latest`。固定版本时使用 `:0.2.0` 这类 tag。 |
| `FOCOWIKI_ADMIN_IMAGE` | 是 | Admin UI 镜像地址。模板默认使用 `ghcr.io/farozerolabs/focowiki-admin:latest`。建议与 API 镜像使用相同版本 tag。 |

## 管理员登录

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 是 | 管理后台登录账号。 |
| `ADMIN_PASSWORD` | 是 | 管理后台登录密码。使用强密码。 |
| `ADMIN_SESSION_SECRET` | 是 | 随机 session 签名密钥。长度至少满足 `ADMIN_SESSION_SECRET_MIN_LENGTH`。 |
| `ADMIN_SESSION_TTL_SECONDS` | 是 | session 有效期，单位秒。默认值为 `28800`。 |
| `ADMIN_SESSION_SECRET_MIN_LENGTH` | 是 | session secret 最小长度。默认值为 `32`。 |
| `ADMIN_SESSION_COOKIE_SECURE` | 是 | HTTPS 部署使用 `true`。本地 HTTP 开发可使用 `false`。 |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | 是 | Cookie SameSite 策略。标准同站管理后台访问使用 `Lax`。 |

## Admin API

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_API_PORT` | 是 | Admin API 的容器内端口或宿主机端口。生产模板默认 `43000`。 |
| `ADMIN_PUBLIC_ORIGIN` | 是 | Admin UI 的公网 HTTPS origin，例如 `https://foco.example.com`。 |
| `ADMIN_API_PUBLIC_ORIGIN` | 是 | Admin API 的公网 HTTPS origin，例如 `https://api.example.com`。 |
| `ADMIN_TRUSTED_ORIGINS` | 是 | 允许调用 Admin API 的 Admin UI origins，多个值用英文逗号分隔。需要填写浏览器实际访问的 origin。 |
| `ALLOWED_HOSTS` | 生产环境必填 | API 接受的 hostnames，多个值用英文逗号分隔。应包含反向代理域名和本地健康检查 host。 |
| `TRUSTED_PROXY_MODE` | 是 | 位于可信反向代理后方时使用 `true`。本地直连使用 `false`。 |

## Admin UI

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_UI_HOST` | 是 | Admin UI 容器监听地址。Docker Compose 使用 `0.0.0.0`。 |
| `ADMIN_UI_PORT` | 是 | Admin UI 宿主机端口。生产模板默认 `43100`。 |
| `ADMIN_API_PROXY_TARGET` | 是 | Admin UI 服务端代理到 Admin API 的地址。Docker Compose 使用 `http://api:43000`。本地开发通常使用 `http://127.0.0.1:43000`。 |
| `VITE_ADMIN_API_BASE_URL` | 可选 | 特殊部署下的浏览器 API base URL 覆盖值。标准 Admin UI 代理流程保持为空。 |

## PostgreSQL

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `POSTGRES_DB` | 是 | Compose PostgreSQL 服务创建的数据库名。 |
| `POSTGRES_USER` | 是 | Compose PostgreSQL 服务创建的数据库用户。 |
| `POSTGRES_PASSWORD` | 是 | 强数据库密码。 |
| `POSTGRES_PORT` | 是 | Compose PostgreSQL 暴露到宿主机的端口，可以与容器内端口 `5432` 不同。 |
| `DATABASE_URL` | 是 | API 使用的数据库连接串。Docker Compose 中应使用容器网络地址：`postgres://USER:PASSWORD@postgres:5432/DB`。 |

`POSTGRES_PORT` 用于宿主机访问 PostgreSQL。`DATABASE_URL` 在容器内使用，生产 Compose 网络中应指向 `postgres:5432`。

## Redis

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `REDIS_PORT` | 是 | Compose Redis 暴露到宿主机的端口。 |
| `REDIS_URL` | 是 | API 使用的 Redis 连接串。Docker Compose 中使用 `redis://redis:6379/0`。 |

`REDIS_PORT` 用于宿主机访问 Redis。`REDIS_URL` 由 API 和迁移进程使用。

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
| `S3_BUCKET` | 是 | 保存源文件和生成 bundle 的 bucket 名称。 |
| `S3_ACCESS_KEY_ID` | 是 | 存储访问 key ID。 |
| `S3_SECRET_ACCESS_KEY` | 是 | 存储访问 secret key。 |
| `S3_PREFIX` | 是 | 内部对象 key 命名空间，例如 `production`。该值不会暴露在 public URLs 中。 |
| `S3_FORCE_PATH_STYLE` | 是 | 多数 S3 兼容服务使用 `true`。存储服务要求 virtual-host style 时使用 `false`。 |

每个环境建议使用独立 bucket 或 prefix。

## 上传和处理限制

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | 是 | 单个 Markdown 文件最大上传字节数。 |
| `MAX_UPLOAD_FILES` | 是 | 单次上传请求最多接受的文件数量。 |
| `GENERATION_BATCH_SIZE` | 是 | 生成和索引工作的批大小。保持有界，避免进程内存一次承载过多数据。 |
| `UPLOAD_TASK_CONCURRENCY` | 是 | 上传任务 worker 数。小服务器使用 `1`，观察稳定后再谨慎增加。 |
| `UPLOAD_FILE_PROCESSING_CONCURRENCY` | 是 | 文件并发处理数。使用 `1` 可以让内存和模型请求更稳定。 |
| `OKF_LOG_MAX_ENTRIES` | 是 | 生成 OKF 文件中保留的 update log 条数。 |
| `OKF_LOG_MAX_BYTES` | 是 | 生成 update log 的最大字节数。 |

8 核 32 GB 服务器建议从 `UPLOAD_TASK_CONCURRENCY=1` 和 `UPLOAD_FILE_PROCESSING_CONCURRENCY=1` 开始。增加并发前先观察 CPU、内存、S3 吞吐、数据库延迟和模型延迟。

## 安全限制

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `ADMIN_LOGIN_RATE_LIMIT_MAX` | 是 | 每个窗口内允许的登录尝试次数。默认值为 `8`。 |
| `ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS` | 是 | 登录限流窗口，单位秒。默认值为 `900`。 |
| `ADMIN_API_RATE_LIMIT_MAX` | 是 | 每个窗口内允许的 Admin API 请求数。 |
| `ADMIN_API_RATE_LIMIT_WINDOW_SECONDS` | 是 | Admin API 限流窗口，单位秒。 |
| `UPLOAD_RATE_LIMIT_MAX` | 是 | 每个窗口内允许的上传请求数。 |
| `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` | 是 | 上传限流窗口，单位秒。 |
| `PUBLIC_OPENAPI_RATE_LIMIT_MAX` | 是 | 每个窗口内允许的 Developer OpenAPI 请求数。 |
| `PUBLIC_OPENAPI_RATE_LIMIT_WINDOW_SECONDS` | 是 | Developer OpenAPI 限流窗口，单位秒。 |
| `SECURITY_AUDIT_RETENTION_DAYS` | 是 | security audit records 保留天数。 |

这些值应结合反向代理、Cloudflare 或其他边缘层限流一起调整。

## 模型辅助

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `MODEL_BASE_URL` | 可选 | OpenAI-compatible API base URL。模板默认值为 `https://api.openai.com/v1`。 |
| `MODEL_API_KEY` | 可选 | 模型服务 API key。为空时关闭模型辅助增强。 |
| `MODEL_NAME` | 可选 | 用于 metadata 和关系建议的模型名称。为空时关闭模型辅助增强。 |
| `MODEL_CONTEXT_WINDOW_TOKENS` | 可选 | 近似上下文窗口，用于决定发送给模型的 Markdown 内容长度。 |
| `MODEL_REQUEST_MAX_TIMEOUT_MS` | 可选 | 模型请求最大总耗时。 |
| `MODEL_REQUEST_IDLE_TIMEOUT_MS` | 可选 | 等待模型输出时允许的最大空闲时间。 |
| `MODEL_SUGGESTION_CONCURRENCY` | 可选 | 模型建议请求并发数。生产环境保持较低，便于控制稳定性和 provider rate limits。 |

模型辅助使用 OpenAI-compatible Structured Outputs。`MODEL_API_KEY` 或 `MODEL_NAME` 为空时，上传和 OKF 生成会继续执行，并跳过模型建议。

## 生产检查清单

执行 `docker compose up -d` 前确认：

1. 所有占位符都已替换。
2. `ADMIN_SESSION_SECRET`、`POSTGRES_PASSWORD`、`S3_SECRET_ACCESS_KEY` 和 `MODEL_API_KEY` 保持私密。
3. 公网 origins 与反向代理域名一致。
4. `ALLOWED_HOSTS` 包含 Admin UI、Admin API、Developer OpenAPI、`127.0.0.1` 和 `localhost`，以支持容器内本地健康检查。
5. Docker 部署中的 `DATABASE_URL` 和 `REDIS_URL` 使用 Compose service names。
6. `LOG_FILE_HOST_DIR` 指向部署目录下可写的目录。
7. S3 凭据可以读写配置的 bucket 和 prefix。
