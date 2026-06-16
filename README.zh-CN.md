# Focowiki

中文 | [English](./README.md)

Focowiki 是一个轻量级 Markdown 知识库系统，面向开发者和产品经理。它接收清洗后的 `.md` 文件，提取 Markdown frontmatter 和文档信号，生成 OKF-style public bundle，将源文件和生成文件保存到 S3 兼容存储，并通过 Admin UI、Admin API 和 Developer OpenAPI 暴露知识库操作能力。

Focowiki 适合已经拥有 Markdown 知识资产的团队，用一个小型自托管服务生成面向人员、应用和 Agent 的文件化知识包。

## Focowiki 做什么

- 从 Admin UI 上传一个或多个 `.md` 文件。
- 解析 YAML frontmatter、Markdown 标题、Markdown 链接和正文内容。
- 将安全的领域元数据作为 pass-through metadata 保留。
- 生成包含 `index.md`、`log.md`、`schema.md`、`pages/*.md` 和 JSON indexes 的 OKF-style bundle。
- 将原始上传源文件和生成后的 bundle 文件保存到 S3 兼容存储。
- 通过 PostgreSQL 和 Redis-backed coordination 持久化知识库、上传任务、源文件记录、发布记录、生成文件记录、游标和 API keys。
- 通过受 Admin 生成的 bearer keys 保护的 Developer OpenAPI 暴露知识库增删、Markdown 上传、任务观察、生成文件读取、删除和 webhooks。

## Open Knowledge Format

[Google 的 Open Knowledge Format 公告](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/) 将 OKF 描述为一种开放、可移植、适合人类阅读和 Agent 读取的知识表示方式，基于 Markdown 文件和 YAML frontmatter。

[OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) 定义了字段约定和 bundle 结构。Focowiki 使用的 OKF 核心思路包括：

- Markdown 文件作为可读知识单元。
- YAML frontmatter 表达结构化元数据。
- Markdown 链接表达概念之间的关系。
- 文件包可被人类、开发者、工具和 Agent 读取。

## Focowiki 和 OKF 的关系

Focowiki 从上传的 Markdown 文件生成 OKF-style public bundle。生成结果遵循相同的实用模型：Markdown pages、YAML frontmatter、links、indexes 和稳定的文件树。

Focowiki 保持实现轻量。项目聚焦 Markdown intake、确定性 bundle generation、可选的 OpenAI-compatible Structured Outputs assistance、S3-compatible persistence、Admin workflows 和 Developer OpenAPI integration。项目使用 OKF 模型作为输出约定，并链接到 Google 规范，方便需要正式格式细节的读者继续阅读。

## Markdown 上传格式

上传文件必须是 `.md`。每个文件可以包含 YAML frontmatter，后面跟 Markdown 正文。

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
owner: "Support Operations"
sourceSystem: "company-wiki"
---

# Customer Support Playbook

Use this playbook when a priority customer request arrives.

## Intake

Record the customer, request summary, severity, and expected response time.

## Related Documents

- [Escalation rules](./escalation-rules.md)
- [Incident handoff](./incident-handoff.md)
```

常见 OKF-style 字段：

- `type`：内容类型，例如 `page`。
- `title`：生成页面的展示标题。
- `description`：面向读者和搜索的简短摘要。
- `resource`：存在源 URL 或规范引用时使用。
- `tags`：可搜索标签。
- `timestamp`：源文件、发布或更新时间。

额外的安全 frontmatter 字段可以被保留。上传 Markdown 中存在 owner、region、product、version、source system、official identifier、status、category 等领域字段时，Focowiki 可以作为源元数据透传这些字段。Focowiki 将产品契约保持为通用知识库契约。

Markdown links 是主要关系机制。正文中的链接帮助读者和 Agent 从一个生成页面移动到相关页面。

当前上传范围只接受 `.md` 文件。`.txt`、`.json`、`.yaml`、`.yml`、`.zip`、sidecar metadata files、archive uploads 和 upload-to-Markdown conversion 都在当前产品范围之外。

## 快速启动

这个路径使用 pnpm 运行 API services 和 Admin UI，并通过本地 Compose 模板启动 PostgreSQL 和 Redis。

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

打开 Admin UI，使用 `.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。Admin UI 的语言切换在页面头部。

真实上传解析需要 S3 兼容存储。开发模板只提供本地 PostgreSQL 和 Redis；测试上传前需要在 `.env` 中配置 `S3_ENDPOINT`、bucket、region、credentials、prefix 和 path-style mode。

## Docker Compose 部署

仓库提交的是 Compose 模板。复制生产模板，填写 `.env`，从 GitHub Container Registry 拉取镜像，执行迁移，然后启动 stack。

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

默认生产镜像：

- `ghcr.io/farozerolabs/focowiki-api:latest`
- `ghcr.io/farozerolabs/focowiki-admin:latest`

Docker Compose 模板默认使用 `latest`。若需固定版本，在 `.env` 中直接按 tag 固定版本号，例如：

```env
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
```

私有 GHCR packages 需要先执行 `docker login ghcr.io`。

生产部署需要：

- PostgreSQL：保存产品记录、任务、发布、生成文件记录、OpenAPI key records 和 audit evidence。
- Redis：保存 sessions、rate limits、cursors、coordination、locks 和 short-lived task refresh state。
- 外部 S3 兼容存储：保存上传源文件和生成后的 public bundles。
- 反向代理后的 HTTPS public origins：用于 Admin UI、Admin API 和 Developer OpenAPI。

Docker Compose 默认读取根目录 `.env`。真实的 `docker-compose.yml`、`docker-compose.dev.yml`、`docker-compose.local.yml`、`.env`、credentials、local paths、S3 keys、model keys、session secrets 和 raw Markdown data 应留在 git 之外。

常用生产 Compose 命令：

```bash
pnpm compose:config
pnpm compose:example:config
pnpm compose:pull
pnpm compose:migrate
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down
pnpm compose:clean
```

`pnpm compose:clean` 会删除生产 Compose stack 使用的 deployment containers、named volumes、orphans 和本地镜像副本。它也会删除该 stack 拥有的本地 PostgreSQL 和 Redis 数据。

## 本地开发

本仓库使用 pnpm 和 TypeScript。

Workspace packages：

- `apps/api`：Hono API server、Admin endpoints、Developer OpenAPI endpoints、runtime config、database repositories、Redis coordination、webhook delivery 和 S3 storage。
- `apps/admin`：Vite React Admin UI，使用 shadcn/ui components 和 `en-US` / `zh-CN` i18n resources。
- `packages/okf`：metadata resolution、OKF-style bundle generation、indexes、logs 和可选 model assistance helpers。

Host-based development 使用本地基础设施模板：

```bash
cp .env.dev.example .env
cp docker-compose.local.yml.example docker-compose.local.yml
pnpm compose:local:up
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

常用本地基础设施命令：

```bash
pnpm compose:local:config
pnpm compose:local:example:config
pnpm compose:local:up
pnpm compose:local:ps
pnpm compose:local:down
pnpm compose:local:clean
```

`pnpm compose:local:clean` 会删除 local infrastructure stack 的本地 PostgreSQL 和 Redis containers、named volumes 和 orphans。

Docker development 会从 Dockerfile 构建本地 API 和 Admin 镜像：

```bash
cp .env.dev.example .env
cp docker-compose.dev.yml.example docker-compose.dev.yml
pnpm compose:dev:build
pnpm compose:dev:migrate
pnpm compose:dev:up
```

常用 Docker development 命令：

```bash
pnpm compose:dev:config
pnpm compose:dev:example:config
pnpm compose:dev:build
pnpm compose:dev:migrate
pnpm compose:dev:up
pnpm compose:dev:ps
pnpm compose:dev:logs
pnpm compose:dev:down
pnpm compose:dev:clean
```

`pnpm compose:dev:clean` 会删除 Docker development Compose stack 使用的 development containers、named volumes、orphans 和本地构建镜像。

## 配置

本地开发使用 `.env.dev.example`，部署使用 `.env.example`。API process 会自动加载根目录 `.env` 文件。只有需要加载其他本地文件时才设置 `ENV_FILE=/absolute/path/to/.env`。

Admin 和 public origins：

- `APP_ENV`：`development` 或 `production`。
- `ADMIN_USERNAME`、`ADMIN_PASSWORD`：Admin 登录凭据。
- `ADMIN_SESSION_SECRET`：用于 HTTP-only Admin session cookies 的高熵签名密钥。
- `ADMIN_SESSION_TTL_SECONDS`、`ADMIN_SESSION_SECRET_MIN_LENGTH`、`ADMIN_SESSION_COOKIE_SECURE`、`ADMIN_SESSION_COOKIE_SAME_SITE`：session lifetime 和 cookie controls。
- `ADMIN_API_PORT`、`ADMIN_UI_HOST`、`ADMIN_UI_PORT`、`ADMIN_API_PROXY_TARGET`：Admin API、Admin UI runtime ports 和 proxy target。
- `ADMIN_PUBLIC_ORIGIN`、`ADMIN_API_PUBLIC_ORIGIN`、`PUBLIC_OPENAPI_PUBLIC_ORIGIN`：外部可访问 origins。
- `ADMIN_TRUSTED_ORIGINS`、`ALLOWED_HOSTS`、`TRUSTED_PROXY_MODE`、`CORS_ORIGINS`：browser、host、proxy 和 public response controls。

基础设施：

- `DATABASE_URL`：PostgreSQL connection URL。
- `REDIS_URL`：Redis connection URL。
- `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_PORT`、`REDIS_PORT`：bundled Compose service settings 和本地主机端口。

S3 兼容存储：

- `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`：object storage connection settings。
- `S3_PREFIX`：内部 object-key namespace。Public URLs 不会暴露这个值。
- `S3_FORCE_PATH_STYLE`：很多本地或自托管 S3 兼容服务需要设置为 `true`。

Developer OpenAPI：

- `PUBLIC_OPENAPI_PORT`：Developer OpenAPI service port。
- `PUBLIC_BASE_URL`：生成 Developer OpenAPI file URLs 时使用的 base URL。
- Developer OpenAPI bearer keys 在 Admin UI 的 `OpenAPI keys` 中生成和管理。Keys 以 database-backed hash-only records 形式保存。

上传、生成和分页：

- `MAX_UPLOAD_BYTES`、`MAX_UPLOAD_FILES`：upload request bounds。
- `GENERATION_BATCH_SIZE`：bounded OKF generation batch size。
- `UPLOAD_TASK_CONCURRENCY`：每个 API process 的 active upload parsing and generation tasks。
- `UPLOAD_FILE_PROCESSING_CONCURRENCY`：每个 task 的 Markdown source processing 和 OKF publication concurrency。
- `OKF_LOG_MAX_ENTRIES`、`OKF_LOG_MAX_BYTES`：rolling generated `log.md` bounds。
- `ADMIN_LIST_PAGE_SIZE`、`ADMIN_LIST_MAX_PAGE_SIZE`、`ADMIN_PAGINATION_CURSOR_TTL_SECONDS`：bounded Admin pagination defaults 和 Redis cursor TTL。

安全限制：

- `ADMIN_LOGIN_RATE_LIMIT_MAX`、`ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS`：Redis-backed Admin login throttle。
- `ADMIN_API_RATE_LIMIT_MAX`、`ADMIN_API_RATE_LIMIT_WINDOW_SECONDS`：Redis-backed Admin API request throttle。
- `UPLOAD_RATE_LIMIT_MAX`、`UPLOAD_RATE_LIMIT_WINDOW_SECONDS`：Redis-backed upload request throttle。
- `PUBLIC_OPENAPI_RATE_LIMIT_MAX`、`PUBLIC_OPENAPI_RATE_LIMIT_WINDOW_SECONDS`：Redis-backed Developer OpenAPI request throttle。
- `SECURITY_AUDIT_RETENTION_DAYS`：persisted security audit evidence 的 retention window。

可选模型辅助：

- `MODEL_BASE_URL`：OpenAI-compatible Responses API base URL。启用模型辅助且该值为空时，默认使用 `https://api.openai.com/v1`。
- `MODEL_API_KEY`：model bearer credential。
- `MODEL_NAME`：model name。
- `MODEL_CONTEXT_WINDOW_TOKENS`：模型上下文窗口，用于判断可以发送多少 Markdown。
- `MODEL_REQUEST_MAX_TIMEOUT_MS`：hard maximum model receive timeout。
- `MODEL_REQUEST_IDLE_TIMEOUT_MS`：idle no-progress receive timeout。
- `MODEL_SUGGESTION_CONCURRENCY`：concurrent model suggestion requests。

`MODEL_API_KEY` 或 `MODEL_NAME` 为空时，model assistance 保持禁用。

## 生成的 Bundle

Focowiki 将 raw source files 和 generated bundle files 写入知识库范围内的 S3 兼容存储内部 object keys。Developer OpenAPI URLs 只暴露产品级 identifiers 和 logical paths。

生成的 bundle files：

```text
index.md
log.md
schema.md
pages/*.md
_index/manifest.json
_index/search.json
_index/links.json
```

Developer OpenAPI endpoint groups：

```text
GET    /openapi/v1/health
GET    /openapi/v1/version
GET    /openapi/v1/openapi.json
POST   /openapi/v1/knowledge-bases
GET    /openapi/v1/knowledge-bases
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}
DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}
POST   /openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks/{taskId}
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/tree
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content
GET    /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content?path=pages%2Fexample.md
DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}
DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files?path=pages%2Fexample.md
POST   /openapi/v1/webhooks
GET    /openapi/v1/webhooks
DELETE /openapi/v1/webhooks/{webhookId}
GET    /openapi/v1/webhook-deliveries
POST   /openapi/v1/webhook-deliveries/{deliveryId}/redeliver
```

Health endpoint 只返回健康状态。产品和 API 版本信息通过 `/openapi/v1/version` 获取，机器可读接口契约通过 `/openapi/v1/openapi.json` 获取。

`index.md` 是 public navigation file。`log.md` 是从 persisted release and task facts 生成的 bounded rolling update history。`schema.md` 描述 generated bundle metadata shape。`pages/*.md` 包含带 YAML frontmatter 的 public concept pages。`_index/*.json` 包含 manifest、search 和 links 的 generated machine-readable indexes。

数据库保存 knowledge base records、task lifecycle rows、source file records、release records、generated file records、checksums、metadata summaries 和 S3 object-key mappings。Raw uploaded Markdown 和 generated Markdown/JSON bodies 保存在 S3 兼容存储中。Public responses 不会暴露 bucket names、`S3_PREFIX`、internal release IDs、storage task IDs 或 raw object keys。

每个 Developer OpenAPI route 都需要 `Authorization: Bearer <Admin-generated OpenAPI key>`。Key lifecycle 仍然只在 Admin 中管理，不通过 Developer OpenAPI 暴露。响应保持可复用 identifier 连续：`knowledgeBaseId`、`taskId`、`fileId`、`webhookId`、`deliveryId`、`cursor` 和 `path` 可以直接传给文档中的后续 endpoint。

Developer OpenAPI errors 使用稳定 JSON envelope：

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource was not found.",
    "httpStatus": 404
  },
  "requestId": "req-example"
}
```

Webhook subscription 只在创建时返回 signing secret。后续列表和 delivery log responses 不会暴露 signing secrets。

## 安全基线

Admin API 是 authorization boundary。每个受保护的 Admin API request 都会在服务端校验 signed Redis-backed session。Cookie-authenticated state-changing Admin API requests 还需要 trusted `Origin` 或 `Referer`。

Production mode 会在服务启动前拒绝 placeholder secrets、weak Admin session secrets、insecure public origins、unsafe session-cookie settings、wildcard private CORS 和 missing allowed hosts。Login failures、throttling、invalid sessions、origin rejection、logout、selected upload events 和 Developer OpenAPI rate-limit events 会写入 redacted audit evidence，其中不包含 passwords、cookies、API keys、S3 object keys、local paths 或 raw Markdown bodies。

使用域名反向代理部署时，需要显式设置 public origins、`ALLOWED_HOSTS` 和 `TRUSTED_PROXY_MODE`。生产环境使用 HTTPS public origins。PostgreSQL、Redis 和 S3 兼容存储应放在私有基础设施中。

## 质量检查

Pull requests 和 `main` branch pushes 会运行 GitHub Actions CI。CI 使用 pnpm 和 committed lockfile 安装依赖，然后运行 lint、typecheck、tests、build、local path leak validation，以及 production、Docker development、local infrastructure 三套模板的 Compose config validation。

Contributor checks：

```bash
pnpm verify
pnpm build
pnpm validate:no-local-paths
pnpm compose:example:config
pnpm compose:dev:example:config
pnpm compose:local:example:config
```

Docker image publishing 会在 `v1.2.3` 这样的 semantic version tags 和 manual dispatch 时运行。常规 release path 是推送版本 tag；该 workflow 会将 Dockerfile `api` target 构建为 `ghcr.io/farozerolabs/focowiki-api`，将 Dockerfile `admin` target 构建为 `ghcr.io/farozerolabs/focowiki-admin`。发布的 release images 包含 version tags、`latest`、不可变的 `sha-*` tags、OCI metadata labels 和 registry-linked build provenance attestations。

## 依赖策略

依赖变更使用 pnpm。新增 packages 时请求当前 latest versions，例如：

```bash
pnpm add hono@latest
pnpm add -D vitest@latest
pnpm dlx shadcn@latest
```

Resolved versions 会记录在 `pnpm-lock.yaml`。Imports 和 generated code 需要与 locked versions 兼容。

## 产品边界

- 上传源文件必须是 `.md`。
- Metadata 来源包括 Markdown frontmatter、deterministic Markdown signals、filename fallback，以及用于补全 missing generic fields 的 optional model suggestions。
- PostgreSQL 和 Redis 是 production Admin state、sessions、coordination 和 paginated Admin reads 的必需服务。
- Search 通过 generated `_index/search.json` 提供。
- Developer OpenAPI 提供 knowledge-base CRUD、uploads、task state、generated files、deletion 和 webhooks。
- Admin review 是 read-only。Generated files 在 UI 中查看，并由 uploads 重新生成。

## License

Focowiki 使用 modified Apache License 2.0 发布。见 [LICENSE](./LICENSE)。

## References

- [Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [GitHub README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [Open Source Guides: Starting an Open Source Project](https://opensource.guide/starting-a-project/#writing-a-readme)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
