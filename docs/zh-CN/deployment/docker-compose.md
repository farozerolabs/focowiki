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
| OpenSearch 或 Meilisearch | 为每个知识库保存一个搜索索引。模板默认使用 OpenSearch 3.8.0。 |
| S3 兼容存储 | 保存上传的 Markdown 和生成后的知识库文件。 |
| 反向代理 | 为 Admin UI、Admin API 和 Developer OpenAPI 提供 HTTPS 访问。 |

模板会启动 PostgreSQL、Redis 和选中的私有搜索服务。外部 S3 兼容服务需要在 `.env` 中配置。也可以用外部 OpenSearch 或 Meilisearch 替代模板附带的搜索容器。可选语义增强在现有 `source-worker` 服务的独立发布镜像中运行，不会增加另一个长期运行服务。

## 准备文件

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data/postgres data/redis data/opensearch data/meilisearch data/meilisearch-snapshots data/meilisearch-dumps opensearch-security runtime-secrets logs backups
```

启动前填写 `.env`。所有生产变量见 [环境变量配置](./environment.md)，启动后可以修改的配置见 [Admin 配置](./admin-settings.md)。

真实 `.env` 和复制后的 `docker-compose.yml` 不要提交到 git。

## 选择搜索服务

复制后的环境模板默认启动 OpenSearch 3.8.0：

```env
SEARCH_PROVIDER=opensearch
COMPOSE_PROFILES=opensearch
OPENSEARCH_URL=https://opensearch:9200
OPENSEARCH_AUTH_MODE=basic
```

在 `.env` 中只设置一个强管理员密码：

```env
OPENSEARCH_ADMIN_PASSWORD=<generate-an-opensearch-admin-password>
```

无需手工准备 TLS 文件。模板附带的 OpenSearch 启动前，`search-init` 会创建当前部署独有的私有 CA 和证书、完整的 OpenSearch Security 配置，以及恰好两个内部身份：配置的管理员和一个只允许访问 `SEARCH_INDEX_PREFIX` 的随机运行身份。私有安全状态保存在 `./opensearch-security`，运行密码和可信 CA 保存在 `./runtime-secrets`。以后每次重启都会原样复用完整且有效的文件。文件缺失、残缺、损坏、权限不安全、接近到期或与当前配置不匹配时，服务会拒绝启动，不会替换部署身份。OpenSearch 的 demo 安装程序在整个启动过程中始终关闭。

API 和 Worker 只会收到生成的运行身份和可信 CA，不会收到管理员密码或私钥。选择 Meilisearch profile 时，同一个 `search-init` 服务会准备 Meilisearch 的运行访问。

改用模板附带的 Meilisearch 时设置：

```env
SEARCH_PROVIDER=meilisearch
COMPOSE_PROFILES=meilisearch
MEILI_HOST=http://meilisearch:7700
```

使用外部服务时，将 `COMPOSE_PROFILES` 留空，并填写所选服务的外部 endpoint 和认证字段。OpenSearch 支持 Basic 认证、可选的私有 CA，以及服务名为 `es` 或 `aoss` 的 AWS SigV4。外部模式不会启动模板附带的搜索容器或初始化服务。

## 模板启动的服务

| Compose 服务 | 说明 |
| --- | --- |
| `admin` | Admin UI。 |
| `api` | Admin API 和 Developer OpenAPI。 |
| `source-worker` | 处理上传的 Markdown 文件；同时配置两种模型后，还会在资源上限内执行语义增强。该服务使用独立的 source-worker 镜像。 |
| `publication-worker` | 让已经处理完成的文件更新可以被读取。 |
| `maintenance-worker` | 执行搜索和存储维护。 |
| `migrate` | 在应用服务启动前检查并更新数据库。 |
| `postgres` | PostgreSQL 数据库。 |
| `redis` | Redis 服务。 |
| `search-init` | 准备选中的模板附带搜索服务；使用 OpenSearch 时，会在其启动前生成或校验 TLS、内部身份和受前缀限制的权限。 |
| `opensearch` | 模板附带的 OpenSearch 3.8.0，通过 `COMPOSE_PROFILES=opensearch` 启用。 |
| `meilisearch` | 模板附带的 Meilisearch 备选服务，通过 `COMPOSE_PROFILES=meilisearch` 启用。 |

生产模板只把 Admin UI、Admin API 和 Developer OpenAPI 发布到 `127.0.0.1`。PostgreSQL、Redis 和两种模板附带的搜索服务都保持在 Compose 私有网络内，并且只会启动选中的搜索 profile。

## 拉取镜像

```bash
docker compose -f docker-compose.yml pull
```

镜像变量默认使用 `latest`。生产环境应把三个镜像固定为相同的发布版本。

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
FOCOWIKI_SOURCE_WORKER_IMAGE=ghcr.io/farozerolabs/focowiki-source-worker:0.0.1
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

所有长期运行的服务都应显示 healthy。启动失败时，先检查 `migrate`、所选搜索服务的初始化服务或异常服务的第一条错误。常见原因包括基础设施不可访问、凭据错误、TLS 信任无效、公网 origin 无效，或者数据库来自不受支持的旧版本。

启动后：

1. 打开 Admin UI，使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。
2. 检查 Admin 配置。
3. 需要启用语义增强时，在设置中分别创建并测试生成模型与向量模型，然后启用两者。基础文件优先流程不要求模型凭据。
4. 创建知识库并上传一个小型 Markdown 文件。
5. 确认文件依次经过 GraphRAG、语义协调、向量生成、受影响图与生成内容更新和最终搜索入库，然后变为可见并可读取、搜索。
6. 该知识库后续普通上传和正文替换会自动执行同一处理流程。在当前存储基线内创建但尚未建立语义契约的知识库，以及后续需要接入模型、语义契约、向量维度或搜索服务变更的知识库，需要为该次接入运行一次**维护索引**。
7. 创建 OpenAPI key，并检查 Developer OpenAPI。

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

`pnpm compose:clean` 会删除当前服务使用的容器、Docker 管理的卷、孤立容器和本地镜像副本。`data`、`opensearch-security`、`runtime-secrets` 和 `logs` 目录仍会保留。只有确定要删除部署数据时才删除这些目录。

## 更新现有部署

本版本是完整的破坏式存储重置。所有旧版本 PostgreSQL schema 都会被拒绝；旧 PostgreSQL 数据、Redis 状态、S3 对象、运行时模型设置、知识库标识、生成内容和搜索索引均不复用。旧部署的完整协调备份只用于回滚。目标版本必须使用空 PostgreSQL 数据库、空 Redis namespace、空 S3 prefix 和空搜索 prefix，执行迁移后重新配置模型、创建知识库并重新导入来源 Markdown。禁止把旧版本备份还原到本版本。完成新导入的文件数量、路径、预览、搜索、关系和 API 访问检查前，保留完整旧部署。

更新到继续支持当前数据库格式的后续版本时：

1. 创建备份。
2. 更新 `.env` 中三个镜像的版本并拉取镜像。
3. 完成发行说明要求的准备工作。
4. 执行数据库命令。
5. 启动更新后的服务。

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

数据库命令成功后可以再次执行。该命令不会处理上传文件，也不会重建搜索索引。当前干净基线启动后，后续当前基线内的契约或搜索服务变更可能需要维护索引；知识库页面会显示维护操作，维护期间已经可以读取的文件继续可用。

## 处理失败

来源文件列表会显示当前状态、当前步骤、失败信息和可用操作。

- 文件处理失败时使用**重试处理**。
- 文件已经处理完成但更新没有变为可见时使用**重试发布**。
- 可重复出现的失败需要先修正配置或服务错误，再执行重试。

文件到达 `state=visible` 后可以读取生成内容。较新的更新失败时，之前已经可见的内容继续可读。

语义任务会在来源 Markdown 文件之外单独报告 pending、degraded、failed、superseded 或 completed 状态。对于已有契约的上传或正文替换，所选搜索服务的入库是最后一个必需索引门禁，因此成功前文件不会显示为已就绪。安全语义错误或可选搜索通道不可用不会替换来源文件错误契约，也不会暴露服务商 payload。重试受影响任务前，先在 Admin 中修正模型、向量、搜索或资源上限问题。维护只用于首次接入、契约或搜索服务变更、明确修复、恢复和完整重建。

## 备份

在 `.env` 和 `docker-compose.yml` 所在目录执行备份。停止会修改 Focowiki 数据的服务，并保持 PostgreSQL 运行。

备份归档只能使用相同存储 schema generation 和匹配的镜像版本还原。旧版本创建的备份只用于配合旧版本镜像回滚，不能作为本次破坏式目标版本的初始数据。

```bash
docker compose -f docker-compose.yml stop api source-worker publication-worker maintenance-worker
pnpm compose:backup
```

上述服务仍在运行时，备份命令会拒绝继续。命令会生成带 checksum 的归档，其中包含 PostgreSQL 备份、所需 S3 文件、部署设置、`.env`、Compose 文件和 `runtime-secrets`。归档及其 `.sha256` 文件应保存在当前服务器之外。

使用模板附带的 OpenSearch 时，还要把已停止服务的完整 `opensearch-security` 目录复制到加密的部署备份存储中，并与匹配的 `.env`、`runtime-secrets` 和 OpenSearch 数据备份一起保存。标准备份归档不包含生成的私钥。

Redis 和搜索索引都可以重新生成。需要包含兼容的 Meilisearch snapshot 时，同时传入 `--meilisearch-snapshot` 和 `--meilisearch-snapshot-sha256`。备份命令不会打包 OpenSearch snapshot；需要 snapshot 时使用 OpenSearch 服务商提供的流程，也可以在还原后逐个重建知识库索引。

部署使用显式 Compose project name 时，备份和还原命令都需要传入相同的 `--project-name <name>`。

## 从备份还原

只有当前存储基线创建的备份可以还原到本版本，且还原目标必须为空；目标中已有数据时先单独备份。旧版本备份只能配合其对应的旧镜像还原成回滚部署。

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

4. 还原模板附带的 OpenSearch 数据时，启动 OpenSearch 前还原与其匹配的完整 `opensearch-security` 目录。不要混入其他部署的文件。

5. 使用备份对应的 API、Admin 和 source-worker 镜像版本。

6. 执行数据库命令并启动服务。

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

7. 未还原所选搜索服务的兼容 snapshot 时，对每个知识库执行**维护索引**。

允许新写入前，检查知识库数量、文件路径、预览、搜索、关系导航、Admin UI 登录、Developer OpenAPI health 和 Worker health。

## 切换搜索服务

切换搜索服务不会复制或自动重建索引。

1. 停止全部服务，并在验证完成前保留当前搜索服务的数据。
2. 修改 `SEARCH_PROVIDER`、对应的 endpoint 和认证字段，以及 `COMPOSE_PROFILES`（`opensearch`、`meilisearch`，外部服务则留空）。
3. 启动服务并检查健康状态。
4. 已有知识库的树、正文、生成文件、图关系、设置和 Developer OpenAPI 非搜索读取继续可用。完成接入前，搜索会返回可重试的暂不可用响应。
5. 对每个已有知识库执行一次**维护索引**。系统会在所选搜索服务中完整构建并验证新索引，再将其设为生效索引。兼容的已存储向量产物会被复用，因此只切换搜索服务不会重复调用相同模型。
6. 验证搜索和常规发布后，再按照备份策略处理旧搜索服务数据。

切换回原来的服务也执行相同步骤。旧的物理索引不会被自动重新启用。搜索服务变化不会修改 Developer OpenAPI 的请求和响应 schema。

搜索持续不可用时，确认运行日志中的搜索服务符合预期、所有容器都能访问 endpoint、TLS 和凭据有效，并确认该知识库的**维护索引**已经完成。维护操作运行期间不要反复重启 Worker。

## 轮换模板附带 OpenSearch 的 TLS

普通重启不会轮换证书。需要轮换时，先停止全部服务，并备份 `opensearch-security`、`runtime-secrets` 和 OpenSearch 数据。把现有 `opensearch-security` 目录、`runtime-secrets/opensearch-password` 和 `runtime-secrets/opensearch-ca.pem` 一起移动到受保护的备份存储，再创建一个空的 `opensearch-security` 目录；`runtime-secrets` 中其他无关文件保持不变。启动一次全部服务，确认 OpenSearch 健康、Admin 搜索和 Developer OpenAPI 搜索正常后，才能处理之前匹配的安全文件备份。

启动报告 `OpenSearch security assets are incomplete or invalid` 时，保留失败状态原样用于诊断；初始化程序不会修复不完整的安全目录与运行时密码组合。应从同一份备份还原匹配的安全目录、密码文件和 CA 文件，或者执行停止全部服务后的轮换流程。不要只删除一个生成文件，也不要在不同部署之间复制证书。

## 容量说明

生产模板默认把 `source-worker` 限制在 2 个 CPU、2 GiB 内存和 128 个进程或线程以内。启动硬上限在 `.env` 中调整；观察部署资源后，再通过 Admin UI 调整 Worker、发布、维护、搜索、图关系、语义搜索和向量模型配置。避免使用一次性读取全部来源文件或全部关系数据的脚本。详见 [环境变量配置](./environment.md#worker-启动限制) 和 [Admin 配置](./admin-settings.md)。
