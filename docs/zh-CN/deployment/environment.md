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

Focowiki 会把运行日志写入 `./logs`，同时继续向容器的标准输出和标准错误流写入日志。每个 Compose 服务的 Docker 日志单文件上限为 `10m`，最多保留 `3` 个文件。

上传或文档入库阶段失败时会记录 `ingestion.stage_failed`。生成模型、嵌入模型和重排模型请求失败时还会记录 `provider.request_failed`；可用字段包括服务类型、请求模式、模型名称、HTTP 状态、服务商请求 ID、重试提示和经过清洗的标准错误字段。日志不会记录凭据、Markdown 正文、Prompt、向量或未经处理的服务商原始响应。

生产 Compose 模板把 PostgreSQL 数据保存在 `./data/postgres`，Redis 数据保存在 `./data/redis`，模板附带的 OpenSearch 数据保存在 `./data/opensearch`，OpenSearch TLS 状态保存在 `./opensearch-security`，模板附带的 Meilisearch 数据保存在 `./data/meilisearch`，Meilisearch 备份保存在 `./data/meilisearch-snapshots` 和 `./data/meilisearch-dumps`，运行凭据保存在 `./runtime-secrets`。迁移或备份部署时需要保留所选搜索服务使用的目录。

## 部署镜像

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `FOCOWIKI_API_IMAGE` | 可选 | API 镜像，默认 `ghcr.io/farozerolabs/focowiki-api:latest`。生产环境建议固定版本标签。 |
| `FOCOWIKI_ADMIN_IMAGE` | 可选 | Admin UI 镜像，默认 `ghcr.io/farozerolabs/focowiki-admin:latest`。与 API 镜像使用相同版本。 |

`worker`、`migrate` 和 API 服务统一使用 `FOCOWIKI_API_IMAGE`，无需单独的工作进程镜像。

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
| `ADMIN_PUBLIC_ORIGIN` | 生产环境必填 | Admin UI 公网 HTTPS 来源地址，例如 `https://admin.example.com`。 |
| `ADMIN_API_PUBLIC_ORIGIN` | 生产环境必填 | Admin API 公网 HTTPS 来源地址，例如 `https://admin-api.example.com`。 |
| `ADMIN_TRUSTED_ORIGINS` | 可选 | 允许调用 Admin API 的浏览器来源地址，多个值用英文逗号分隔。留空时使用 Admin UI 来源地址和本地开发来源地址。 |
| `ALLOWED_HOSTS` | 生产环境必填 | API 接受的主机名，多个值用英文逗号分隔。包含反向代理转发的全部域名和本地健康检查主机名。 |
| `TRUSTED_PROXY_MODE` | 可选 | 请求经过可信反向代理时设为 `true`。默认 `false`。 |

生产模板仅把 Admin UI、Admin API 和 Developer OpenAPI 绑定到 `127.0.0.1`，公开访问应通过 HTTPS 反向代理。

## PostgreSQL

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `POSTGRES_DB` | Compose 必填 | PostgreSQL 服务创建的数据库名。 |
| `POSTGRES_USER` | Compose 必填 | PostgreSQL 服务创建的数据库用户。 |
| `POSTGRES_PASSWORD` | Compose 必填 | 强数据库密码。密码写入 `DATABASE_URL` 时需要对特殊字符进行 URL 编码。 |
| `POSTGRES_SHM_SIZE` | 内置 Compose | PostgreSQL 共享内存容量，默认 `512m`。 |
| `POSTGRES_MAX_PARALLEL_WORKERS_PER_GATHER` | 内置 Compose | PostgreSQL 单条查询最多使用的并行工作进程数，默认 `0`。 |
| `DATABASE_URL` | 是 | API 数据库连接地址。生产 Compose 网络使用 `postgres://USER:PASSWORD@postgres:5432/DB`。 |
| `DATABASE_POOL_MAX` | 可选 | 单个 API 进程最多使用的 PostgreSQL 连接数。默认 `10`。 |

生产模板中的 PostgreSQL 和 Redis 不会映射到宿主机端口。数据库管理可以使用 `docker compose exec postgres ...`；确实需要从宿主机访问时，在私有 Compose 文件中显式添加只绑定回环地址的端口映射。

## Redis

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `REDIS_URL` | 是 | Redis 连接地址。生产 Compose 网络使用 `redis://redis:6379/0`。 |

API 和所有工作进程都需要访问 Redis。Redis 应保持在部署私有网络内。

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
| `OPENSEARCH_URL`、`OPENSEARCH_AUTH_MODE`、`OPENSEARCH_USERNAME`、`OPENSEARCH_PASSWORD`、`OPENSEARCH_PASSWORD_FILE`、`OPENSEARCH_CA_FILE` | OpenSearch 端点、认证和 CA。Basic 密码直接值与密码文件二选一。 |
| `OPENSEARCH_AWS_REGION`、`OPENSEARCH_AWS_SERVICE` | 仅用于外部 OpenSearch 的 AWS SigV4 认证。 |
| `OPENSEARCH_ADMIN_PASSWORD`、`OPENSEARCH_JAVA_OPTS` | 仅用于 Docker 模板内置 OpenSearch。 |
| `MEILI_HOST`、`MEILI_MASTER_KEY`、`MEILI_API_KEY`、`MEILI_METRICS_API_KEY`、`MEILI_API_KEY_FILE`、`MEILI_METRICS_API_KEY_FILE` | Meilisearch 端点和认证。模板内置服务使用主密钥，并自动生成两个运行密钥文件；外部服务直接提供密钥或密钥文件。 |
| `MEILI_MAX_INDEXING_MEMORY`、`MEILI_MAX_INDEXING_THREADS`、`MEILI_SNAPSHOT_DIR`、`MEILI_SCHEDULE_SNAPSHOT`、`MEILI_DUMP_DIR` | 仅用于 Docker 模板内置 Meilisearch。 |

宿主机使用 `docker-compose.dev.yml` 或 `docker-compose.local.yml` 本地开发时，`MEILI_PORT` 决定模板内置 Meilisearch 暴露到回环地址的端口，默认是 `57700`，并且必须与本地 `MEILI_HOST` URL 中的端口一致。生产 Compose 通过 `http://meilisearch:7700` 在容器网络内通信，不对宿主机暴露该端口。

### 使用 Docker 模板内置 OpenSearch

这是 `.env.example` 的默认方案。保留下面的地址、用户名、密码文件和 CA 文件路径，只替换管理员密码；`SEARCH_INDEX_PREFIX` 可以保留，也可以改为当前部署独占的名称。

```dotenv
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
OPENSEARCH_JAVA_OPTS=-Xms2g -Xmx2g
```

第一次启动时，Docker 模板会自动生成 TLS 文件和 `focowiki-runtime` 的随机运行密码，并写入 `opensearch-security` 和 `runtime-secrets`。不要手工创建证书，不要把 `OPENSEARCH_PASSWORD` 填成管理员密码，也不要修改上面的密码文件和 CA 文件路径。`OPENSEARCH_JAVA_OPTS` 默认设置 2 GiB OpenSearch Java 堆内存；提高前应先测量部署负载和可用内存。

### 使用 Docker 模板内置 Meilisearch

先解除所用 Compose 模板中完整 `meilisearch` 服务块的注释，再将提供商和 Compose 配置组一起切换，并生成一个至少包含 16 字节随机内容的主密钥。运行密钥和诊断密钥由模板自动生成，所以直接值保持为空，文件路径保持模板值。

```dotenv
SEARCH_PROVIDER=meilisearch
SEARCH_INDEX_PREFIX=focowiki
COMPOSE_PROFILES=meilisearch

MEILI_HOST=http://meilisearch:7700
MEILI_MASTER_KEY=<替换为随机主密钥>
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

未选中的 `OPENSEARCH_*` 字段可以留空。内存、线程、快照和转储字段控制模板内置的 Meilisearch 容器；使用外部 Meilisearch 时不使用这些字段。

### 使用外部 OpenSearch

外部服务必须将 `COMPOSE_PROFILES` 留空，否则 Compose 还会启动模板内置 OpenSearch。`OPENSEARCH_URL` 必须是所有 Focowiki 容器都能访问的 HTTPS 地址，不能填写容器自身的 `127.0.0.1` 或 `localhost`。

使用 Basic 认证时填写：

```dotenv
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

```dotenv
SEARCH_PROVIDER=opensearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

OPENSEARCH_URL=https://<外部 OpenSearch 地址>
OPENSEARCH_AUTH_MODE=aws_sigv4
OPENSEARCH_USERNAME=
OPENSEARCH_PASSWORD=
OPENSEARCH_PASSWORD_FILE=
OPENSEARCH_CA_FILE=
OPENSEARCH_AWS_REGION=<AWS 区域>
OPENSEARCH_AWS_SERVICE=es
OPENSEARCH_ADMIN_PASSWORD=
OPENSEARCH_JAVA_OPTS=
```

Amazon OpenSearch Service 使用 `es`，OpenSearch Serverless 使用 `aoss`。凭据使用标准 AWS 环境变量、工作负载身份、共享配置、ECS 或 EC2 凭据；不要为了 Focowiki 新增专用的静态 AWS 密钥字段。

### 使用外部 Meilisearch

外部服务同样必须将 `COMPOSE_PROFILES` 留空。填写外部端点、运行访问密钥和诊断密钥；`MEILI_MASTER_KEY` 及内置容器资源字段留空。

```dotenv
SEARCH_PROVIDER=meilisearch
SEARCH_INDEX_PREFIX=focowiki_prod
COMPOSE_PROFILES=

MEILI_HOST=https://search.example.com
MEILI_MASTER_KEY=
MEILI_API_KEY=<外部服务运行访问密钥>
MEILI_METRICS_API_KEY=<外部服务诊断密钥>
MEILI_API_KEY_FILE=
MEILI_METRICS_API_KEY_FILE=
MEILI_MAX_INDEXING_MEMORY=
MEILI_MAX_INDEXING_THREADS=
MEILI_SNAPSHOT_DIR=
MEILI_SCHEDULE_SNAPSHOT=
MEILI_DUMP_DIR=
```

也可以把两个密钥保存到宿主机的 `runtime-secrets` 目录，并改用 `MEILI_API_KEY_FILE` 和 `MEILI_METRICS_API_KEY_FILE` 指定容器内路径。生产环境必须同时提供运行访问密钥和诊断密钥。

Focowiki 会忽略未选中搜索服务的字段。`.env`、`runtime-secrets` 和使用内置 OpenSearch 时生成的 `opensearch-security` 都包含私密部署数据，需要限制访问并纳入备份。

## Developer OpenAPI

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `PUBLIC_OPENAPI_PORT` | Compose 必填 | Developer OpenAPI 的宿主机和容器端口。模板使用 `43200`。 |
| `PUBLIC_BASE_URL` | 是 | API 链接使用的公网 HTTPS 地址，例如 `https://openapi.example.com`。 |
| `PUBLIC_OPENAPI_PUBLIC_ORIGIN` | 可选 | Developer OpenAPI 的公网 HTTPS 来源地址，默认使用 `PUBLIC_BASE_URL`。 |

Developer OpenAPI 密钥在 Admin UI 中创建，不要写入 `.env`。

## S3 兼容存储

生产 Compose 模板不启动对象存储服务。需要配置所有 Focowiki 容器都能访问的 AWS S3、Cloudflare R2、MinIO 或其他 S3 兼容存储桶。

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `S3_ENDPOINT` | 是 | 存储服务端点 URL。 |
| `S3_REGION` | 是 | 存储服务要求的区域。 |
| `S3_BUCKET` | 是 | 当前部署使用的存储桶。 |
| `S3_ACCESS_KEY_ID` | 是 | 后端使用的存储访问密钥 ID。 |
| `S3_SECRET_ACCESS_KEY` | 是 | 后端使用的存储私密密钥。 |
| `S3_PREFIX` | 是 | 当前部署独占的非空对象键前缀，例如 `production`。 |
| `S3_FORCE_PATH_STYLE` | 可选 | 默认 `false`。存储服务要求路径式访问时使用 `true`；AWS S3 通常使用 `false`。 |

凭据需要在配置前缀下列出存储桶，并读取、写入、检查和删除对象。备份与还原还要求存储服务支持列出对象版本。每个环境使用独立存储桶或前缀。

## 分页与内容限制

本节变量均为可选项，`.env.example` 中的值可作为初始值。

| 变量 | 用途 |
| --- | --- |
| `ADMIN_LIST_DEFAULT_PAGE_SIZE` | Admin 列表默认页大小。 |
| `ADMIN_LIST_MAX_PAGE_SIZE` | Admin 列表允许的最大页大小。 |
| `TREE_CHILD_DEFAULT_PAGE_SIZE` | 生成文件树直接子节点的默认页大小。 |
| `TREE_CHILD_MAX_PAGE_SIZE` | 生成文件树直接子节点的最大页大小。 |
| `PAGINATION_CURSOR_TTL_SECONDS` | 分页游标的有效秒数。 |
| `GENERATED_CONTENT_MAX_BYTES` | 单次 API 响应允许返回的生成文件最大字节数，超过时返回 HTTP 413。 |

## Worker 启动限制

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `WORKER_DATABASE_POOL_MAX` | 可选 | 单个 Worker 使用的 PostgreSQL 连接数。模板使用 `8`。 |
| `WORKER_CPUS` | 可选 | Worker 容器的 CPU 硬上限。模板使用 `2.0`。 |
| `WORKER_MEMORY_LIMIT` | 可选 | Worker 容器的内存硬上限。模板使用 `2g`。 |
| `WORKER_PIDS_LIMIT` | 可选 | Worker 容器允许的最大进程和线程数。模板使用 `128`。 |

使用多个副本时，需要汇总所有 API 和 Worker 的连接池上限，并为迁移和管理员访问预留连接。

Worker 使用的 API 镜像包含可选语义增强运行时。这些启动硬上限保留在 `.env`；文档并发、语义分块、证据、查询嵌入并发和缓存上限应在测量 CPU、内存、服务商延迟与工作量后通过 Admin 配置调整。

## 安全审计

| 变量 | 是否必填 | 填写方式 |
| --- | --- | --- |
| `SECURITY_AUDIT_RETENTION_DAYS` | 可选 | 安全审计记录的保留天数。默认 `30`。 |

## 生产检查清单

启动前确认：

1. `.env` 中所有占位符均已替换。
2. API 与 Admin UI 镜像固定为同一个 Focowiki 版本。
3. 公网来源地址使用 HTTPS，并与反向代理域名一致。
4. `ALLOWED_HOSTS` 包含反向代理转发给 API 的全部主机名。
5. 容器可以访问 PostgreSQL、Redis、所选搜索服务和 S3。
6. S3 凭据可以在选定前缀下执行所需操作。
7. `data`、`logs`、`opensearch-security`、`runtime-secrets` 和 `backups` 可写并已纳入备份计划。
8. 首次登录后检查 Admin 配置。
