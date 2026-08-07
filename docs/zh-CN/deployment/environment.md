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

生产 Compose 模板把 PostgreSQL 数据保存在 `./data/postgres`，Redis 数据保存在 `./data/redis`，模板附带的 OpenSearch 数据保存在 `./data/opensearch`，OpenSearch TLS 状态保存在 `./opensearch-security`，模板附带的 Meilisearch 数据保存在 `./data/meilisearch`，Meilisearch 备份保存在 `./data/meilisearch-snapshots` 和 `./data/meilisearch-dumps`，运行凭据保存在 `./runtime-secrets`。迁移或备份部署时需要保留所选搜索服务使用的目录。

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

每个 Focowiki 部署只选择一个搜索服务。先确定使用方式，再按对应示例填写。`SEARCH_PROVIDER` 决定 Focowiki 使用哪种搜索协议；`COMPOSE_PROFILES` 决定 Docker Compose 是否同时启动模板内置的搜索容器。

| 使用方式 | `SEARCH_PROVIDER` | `COMPOSE_PROFILES` |
| --- | --- | --- |
| Docker 模板内置 OpenSearch 3.8.0，默认方案 | `opensearch` | `opensearch` |
| Docker 模板内置 Meilisearch | `meilisearch` | `meilisearch` |
| 外部或云厂商 OpenSearch | `opensearch` | 留空 |
| 外部或云厂商 Meilisearch | `meilisearch` | 留空 |

所有方案都必须设置 `SEARCH_INDEX_PREFIX`。它只能包含小写字母、数字、下划线和连字符，最长 80 个字符。多个 Focowiki 部署共用同一个外部搜索服务时，每个部署必须使用不同的前缀。选定后不要随意修改；修改搜索服务或前缀后，需要在 Admin 中手动维护已有知识库的搜索索引。

| 字段组 | 用途 |
| --- | --- |
| `OPENSEARCH_URL`、`OPENSEARCH_AUTH_MODE`、`OPENSEARCH_USERNAME`、`OPENSEARCH_PASSWORD`、`OPENSEARCH_PASSWORD_FILE`、`OPENSEARCH_CA_FILE` | OpenSearch endpoint、认证和 CA。Basic 密码直接值与密码文件二选一。 |
| `OPENSEARCH_AWS_REGION`、`OPENSEARCH_AWS_SERVICE` | 仅用于外部 OpenSearch 的 AWS SigV4 认证。 |
| `OPENSEARCH_ADMIN_PASSWORD`、`OPENSEARCH_JAVA_OPTS` | 仅用于 Docker 模板内置 OpenSearch。 |
| `MEILI_HOST`、`MEILI_MASTER_KEY`、`MEILI_API_KEY`、`MEILI_METRICS_API_KEY`、`MEILI_API_KEY_FILE`、`MEILI_METRICS_API_KEY_FILE` | Meilisearch endpoint 和认证。模板内置服务使用 master key，并自动生成两个运行 key 文件；外部服务直接提供 key 或 key 文件。 |
| `MEILI_MAX_INDEXING_MEMORY`、`MEILI_MAX_INDEXING_THREADS`、`MEILI_SNAPSHOT_DIR`、`MEILI_SCHEDULE_SNAPSHOT`、`MEILI_DUMP_DIR` | 仅用于 Docker 模板内置 Meilisearch。 |

### 使用 Docker 模板内置 OpenSearch

这是 `.env.example` 的默认方案。保留下面的地址、用户名、密码文件和 CA 文件路径，只替换管理员密码；`SEARCH_INDEX_PREFIX` 可以保留，也可以改为当前部署独占的名称。

```env
SEARCH_PROVIDER=opensearch
SEARCH_INDEX_PREFIX=focowiki
COMPOSE_PROFILES=opensearch

OPENSEARCH_URL=https://opensearch:9200
OPENSEARCH_AUTH_MODE=basic
OPENSEARCH_USERNAME=focowiki-runtime
OPENSEARCH_PASSWORD=
OPENSEARCH_PASSWORD_FILE=/app/runtime-secrets/opensearch-password
OPENSEARCH_CA_FILE=/app/runtime-secrets/opensearch-ca.pem
OPENSEARCH_AWS_REGION=
OPENSEARCH_AWS_SERVICE=es
OPENSEARCH_ADMIN_PASSWORD=<替换为强管理员密码>
OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
```

第一次启动时，Docker 模板会自动生成 TLS 文件和 `focowiki-runtime` 的随机运行密码，并写入 `opensearch-security` 和 `runtime-secrets`。不要手工创建证书，不要把 `OPENSEARCH_PASSWORD` 填成管理员密码，也不要修改上面的密码文件和 CA 文件路径。`OPENSEARCH_JAVA_OPTS` 是 OpenSearch heap，模板默认占用 512 MiB；根据实际负载和服务器内存测量后再调整。

### 使用 Docker 模板内置 Meilisearch

将提供商和 Compose profile 一起切换，并生成一个至少包含 16 字节随机内容的 master key。运行 key 和诊断 key 由模板自动生成，所以直接值保持为空，文件路径保持模板值。

```env
SEARCH_PROVIDER=meilisearch
SEARCH_INDEX_PREFIX=focowiki
COMPOSE_PROFILES=meilisearch

MEILI_HOST=http://meilisearch:7700
MEILI_MASTER_KEY=<替换为随机 master key>
MEILI_API_KEY=
MEILI_METRICS_API_KEY=
MEILI_API_KEY_FILE=/app/runtime-secrets/meilisearch-api-key
MEILI_METRICS_API_KEY_FILE=/app/runtime-secrets/meilisearch-metrics-key
MEILI_MAX_INDEXING_MEMORY=2GiB
MEILI_MAX_INDEXING_THREADS=2
MEILI_SNAPSHOT_DIR=/meili_snapshots
MEILI_SCHEDULE_SNAPSHOT=86400
MEILI_DUMP_DIR=/meili_dumps
```

未选中的 `OPENSEARCH_*` 字段可以留空。内存、线程、snapshot 和 dump 字段控制模板内置的 Meilisearch 容器；使用外部 Meilisearch 时不使用这些字段。

### 使用外部 OpenSearch

外部服务必须将 `COMPOSE_PROFILES` 留空，否则 Compose 还会启动模板内置 OpenSearch。`OPENSEARCH_URL` 必须是所有 Focowiki 容器都能访问的 HTTPS 地址，不能填写容器自身的 `127.0.0.1` 或 `localhost`。

使用 Basic 认证时填写：

```env
SEARCH_PROVIDER=opensearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

OPENSEARCH_URL=https://search.example.com
OPENSEARCH_AUTH_MODE=basic
OPENSEARCH_USERNAME=<外部服务运行用户名>
OPENSEARCH_PASSWORD=<外部服务运行密码>
OPENSEARCH_PASSWORD_FILE=
OPENSEARCH_CA_FILE=
OPENSEARCH_AWS_REGION=
OPENSEARCH_AWS_SERVICE=es
OPENSEARCH_ADMIN_PASSWORD=
OPENSEARCH_JAVA_OPTS=
```

如果不希望把 Basic 密码直接写入 `.env`，可将密码保存到宿主机的 `runtime-secrets` 目录，把 `OPENSEARCH_PASSWORD` 留空，并将 `OPENSEARCH_PASSWORD_FILE` 设置为对应的容器内路径，例如 `/app/runtime-secrets/opensearch-password`。外部服务使用私有 CA 时，也把 CA 文件放入 `runtime-secrets`，并将 `OPENSEARCH_CA_FILE` 设置为对应的容器内路径；使用公共可信证书时保持为空。

Amazon OpenSearch Service 或 OpenSearch Serverless 使用 SigV4 时填写：

```env
SEARCH_PROVIDER=opensearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

OPENSEARCH_URL=https://<外部 OpenSearch endpoint>
OPENSEARCH_AUTH_MODE=aws_sigv4
OPENSEARCH_USERNAME=
OPENSEARCH_PASSWORD=
OPENSEARCH_PASSWORD_FILE=
OPENSEARCH_CA_FILE=
OPENSEARCH_AWS_REGION=<AWS region>
OPENSEARCH_AWS_SERVICE=es
OPENSEARCH_ADMIN_PASSWORD=
OPENSEARCH_JAVA_OPTS=
```

Amazon OpenSearch Service 使用 `es`，OpenSearch Serverless 使用 `aoss`。凭据使用标准 AWS 环境变量、workload identity、shared configuration、ECS 或 EC2 credentials；不要为了 Focowiki 新增专用的静态 AWS key 字段。

### 使用外部 Meilisearch

外部服务同样必须将 `COMPOSE_PROFILES` 留空。填写外部 endpoint、运行访问 key 和诊断 key；`MEILI_MASTER_KEY` 及内置容器资源字段留空。

```env
SEARCH_PROVIDER=meilisearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

MEILI_HOST=https://search.example.com
MEILI_MASTER_KEY=
MEILI_API_KEY=<外部服务运行访问 key>
MEILI_METRICS_API_KEY=<外部服务诊断 key>
MEILI_API_KEY_FILE=
MEILI_METRICS_API_KEY_FILE=
MEILI_MAX_INDEXING_MEMORY=
MEILI_MAX_INDEXING_THREADS=
MEILI_SNAPSHOT_DIR=
MEILI_SCHEDULE_SNAPSHOT=
MEILI_DUMP_DIR=
```

也可以把两个 key 保存到宿主机的 `runtime-secrets` 目录，并改用 `MEILI_API_KEY_FILE` 和 `MEILI_METRICS_API_KEY_FILE` 指定容器内路径。生产环境必须同时提供运行访问 key 和诊断 key。

Focowiki 会忽略未选中搜索服务的字段。`.env`、`runtime-secrets` 和使用内置 OpenSearch 时生成的 `opensearch-security` 都包含私密部署数据，需要限制访问并纳入备份。

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
5. 容器可以访问 PostgreSQL、Redis、所选搜索服务和 S3。
6. S3 凭据可以在选定前缀下执行所需操作。
7. `data`、`logs`、`opensearch-security`、`runtime-secrets` 和 `backups` 可写并已纳入备份计划。
8. 首次登录后检查 Admin 配置。
