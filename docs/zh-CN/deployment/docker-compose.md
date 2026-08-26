---
title: Docker Compose 部署
---

# Docker Compose 部署

本指南使用生产 Docker Compose 模板和已发布的 GitHub Container Registry 镜像启动 Focowiki。

## 部署要求

生产部署需要：

| 服务 | 用途 |
| --- | --- |
| PostgreSQL | 保存知识库、文件记录、处理状态、设置、OpenAPI 密钥和关系数据。 |
| Redis | 保存登录会话、限流计数、分页和短期任务状态。 |
| OpenSearch 或 Meilisearch | 为每个知识库保存一个搜索索引。模板默认使用 OpenSearch 3.8.0。 |
| S3 兼容存储 | 保存上传的 Markdown 和生成后的知识库文件。 |
| 反向代理 | 为 Admin UI、Admin API 和 Developer OpenAPI 提供 HTTPS 访问。 |

模板会启动 PostgreSQL、Redis 和选中的私有搜索服务。外部 S3 兼容服务需要在 `.env` 中配置。也可以用外部 OpenSearch 或 Meilisearch 替代模板附带的搜索容器。一个 `worker` 服务统一处理文档索引、语义增强、删除、修复和维护。

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

```dotenv
SEARCH_PROVIDER=opensearch
COMPOSE_PROFILES=opensearch
OPENSEARCH_URL=https://opensearch:9200
OPENSEARCH_AUTH_MODE=basic
```

在 `.env` 中只设置一个强管理员密码：

```dotenv
OPENSEARCH_ADMIN_PASSWORD=<generate-an-opensearch-admin-password>
```

无需手工准备 TLS 文件。模板附带的 OpenSearch 启动前，`search-init` 会把 `./data/opensearch` 调整为容器可写，创建当前部署独有的私有 CA 和证书、完整的 OpenSearch Security 配置，以及恰好两个内部身份：配置的管理员和一个只允许访问 `SEARCH_INDEX_PREFIX` 的随机运行身份。私有安全状态保存在 `./opensearch-security`，运行密码和可信 CA 保存在 `./runtime-secrets`。以后每次重启都会原样复用完整且有效的文件。文件缺失、残缺、损坏、权限不安全、接近到期或与当前配置不匹配时，服务会拒绝启动，不会替换部署身份。OpenSearch 的演示安装程序在整个启动过程中始终关闭。模板管理的数据目录无需手工执行 `chown`。

API 和工作进程只会收到生成的运行身份和可信 CA，不会收到管理员密码或私钥。选择 Meilisearch Compose 配置组时，同一个 `search-init` 服务会准备 Meilisearch 的运行访问。

改用模板附带的 Meilisearch 时，先解除 Compose 模板中完整 `meilisearch` 服务块的注释，再设置：

```dotenv
SEARCH_PROVIDER=meilisearch
COMPOSE_PROFILES=meilisearch
MEILI_HOST=http://meilisearch:7700
```

使用外部服务时，将 `COMPOSE_PROFILES` 留空，并填写所选服务的外部端点和认证字段。OpenSearch 支持 Basic 认证、可选的私有 CA，以及服务名为 `es` 或 `aoss` 的 AWS SigV4。外部模式不会启动模板附带的搜索容器或初始化服务。

## 模板启动的服务

| Compose 服务 | 说明 |
| --- | --- |
| `admin` | Admin UI。 |
| `api` | Admin API 和 Developer OpenAPI。 |
| `worker` | 处理文档任务，并以较低优先级执行删除、修复和维护。 |
| `migrate` | 在应用服务启动前检查并更新数据库。 |
| `postgres` | PostgreSQL 数据库。 |
| `redis` | Redis 服务。 |
| `search-init` | 准备选中的模板附带搜索服务；使用 OpenSearch 时，会在其启动前准备数据目录，并生成或校验 TLS、内部身份和受前缀限制的权限。 |
| `opensearch` | 模板附带的 OpenSearch 3.8.0，通过 `COMPOSE_PROFILES=opensearch` 启用。 |
| `meilisearch` | 模板附带的 Meilisearch 备选服务，通过 `COMPOSE_PROFILES=meilisearch` 启用。 |

生产模板只把 Admin UI、Admin API 和 Developer OpenAPI 发布到 `127.0.0.1`。PostgreSQL、Redis 和两种模板附带的搜索服务都保持在 Compose 私有网络内，并且只会启动选中的搜索配置组。

## 拉取镜像

```bash
docker compose -f docker-compose.yml pull
```

镜像变量默认使用 `latest`。生产环境应把两个镜像固定为相同的发布版本；`worker` 使用 API 镜像。

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:<release-tag>
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:<release-tag>
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

公开访问应通过 `.env` 中配置的 HTTPS 来源地址。

## 检查启动状态

```bash
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail=200 api worker admin
```

所有长期运行的服务都应显示 `healthy`。启动失败时，先检查 `migrate`、所选搜索服务的初始化服务或异常服务的第一条错误。常见原因包括基础设施不可访问、凭据错误、TLS 信任无效、公开来源地址无效，或者数据库来自不受支持的旧版本。

启动后：

1. 打开 Admin UI，使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。
2. 检查 Admin 配置。
3. 在**模型配置**中分别创建并测试生成模型与嵌入模型，然后将生成模型**设为生效**并**激活**嵌入模型。完成上传需要这两项配置。
4. 创建知识库并上传一个小型 Markdown 文件。
5. 确认文件逐步变为 `available`，随后可以读取并通过搜索找到。
6. 后续上传和正文替换会自动执行同一处理流程。已有内容更换模型、嵌入维度或搜索服务时，或者需要明确修复或重建时，执行一次**维护索引**。
7. 创建 OpenAPI 密钥，并检查 Developer OpenAPI。

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

原地更新时，执行数据库命令期间应保持 API、worker 和 Admin 服务停止。更新会保留已经可用的内容，以及当前生效的生成路径、来源版本、关系和搜索所有权；尚未完成的最终发布协调会按当前 worker 约定重置，已完成的模型、GraphRAG、嵌入、来源存储和搜索准备结果仍会保留。迁移不会调用外部服务、改写 S3 对象或重建知识库。

更新现有部署时：

1. 创建备份。
2. 停止 `api`、`worker` 和 `admin`，不要让新旧 worker 同时连接同一个数据库。
3. 更新 `.env` 中的镜像版本并拉取镜像。
4. 完成发行说明要求的准备工作。
5. 在应用服务保持停止时执行数据库命令。
6. 启动更新后的服务，验证已有读取后再接受新写入。

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml stop api worker admin
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

数据库命令成功后可以再次执行。该命令不会处理上传文件，也不会重建搜索索引。需要回滚时，先停止更新后的服务，再使用备份中记录的镜像版本还原同一份协调备份。新部署启动后，已有内容更换模型、嵌入维度、输出格式或搜索服务时，可能需要执行**维护索引**。维护期间，已经可以读取的文件继续可用。

## 处理失败

来源文件列表会显示当前状态、当前步骤、失败信息和可用操作。

- 文件处理失败时使用**重试处理**。
- 可重复出现的失败需要先修正配置或服务错误，再执行重试。

文件到达 `state=available` 后可以读取生成内容。替换失败时，之前已经可用的内容继续可读。

文件只有在必要处理完成，并且生成内容可以读取和搜索后才会显示为可用。重试前，先在 Admin 中修正模型、嵌入、搜索或资源上限问题。相关配置发生变化，或者需要明确修复、恢复或完整重建时，使用**维护索引**。

## 备份

在 `.env` 和 `docker-compose.yml` 所在目录执行备份。停止会修改 Focowiki 数据的服务，并保持 PostgreSQL 运行。

备份归档只能使用相同存储结构版本和匹配的镜像版本还原。旧版本创建的备份只用于配合旧版本镜像回滚，不能作为本次破坏式目标版本的初始数据。

```bash
docker compose -f docker-compose.yml stop api worker admin
pnpm compose:backup
```

上述服务仍在运行时，备份命令会拒绝继续。命令会生成带校验和的归档，其中包含 PostgreSQL 备份、所需 S3 文件、部署设置、`.env`、Compose 文件和 `runtime-secrets`。归档及其 `.sha256` 文件应保存在当前服务器之外。

使用模板附带的 OpenSearch 时，还要把已停止服务的完整 `opensearch-security` 目录复制到加密的部署备份存储中，并与匹配的 `.env`、`runtime-secrets` 和 OpenSearch 数据备份一起保存。标准备份归档不包含生成的私钥。

Redis 和搜索索引都可以重新生成。需要包含兼容的 Meilisearch 快照时，同时传入 `--meilisearch-snapshot` 和 `--meilisearch-snapshot-sha256`。备份命令不会打包 OpenSearch 快照；需要快照时使用 OpenSearch 服务商提供的流程，也可以在还原后逐个重建知识库索引。

部署使用显式 Compose 项目名时，备份和还原命令都需要传入相同的 `--project-name <name>`。

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

3. 使用归档和校验和文件执行还原。

   ```bash
   pnpm compose:restore -- \
     --archive backups/focowiki-<backup-id>.tar.gz \
     --checksum backups/focowiki-<backup-id>.tar.gz.sha256
   ```

   还原命令会校验归档，并拒绝非空的数据库、S3 前缀或 `runtime-secrets` 目标。

4. 还原模板附带的 OpenSearch 数据时，启动 OpenSearch 前还原与其匹配的完整 `opensearch-security` 目录。不要混入其他部署的文件。

5. 使用备份对应的 API 和 Admin 镜像版本。

6. 执行数据库命令并启动服务。

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

7. 未还原所选搜索服务的兼容快照时，对每个知识库执行**维护索引**。

允许新写入前，检查知识库数量、文件路径、预览、搜索、关系导航、Admin UI 登录、Developer OpenAPI 健康检查和工作进程健康检查。

## 切换搜索服务

切换搜索服务不会复制或自动重建索引。

1. 停止全部服务，并在验证完成前保留当前搜索服务的数据。
2. 修改 `SEARCH_PROVIDER`、对应的端点和认证字段，以及 `COMPOSE_PROFILES`（`opensearch`、`meilisearch`，外部服务则留空）。
3. 启动服务并检查健康状态。
4. 已有知识库的树、正文、生成文件、图关系、设置和 Developer OpenAPI 非搜索读取继续可用。完成接入前，搜索会返回可重试的暂不可用响应。
5. 对每个已有知识库执行一次**维护索引**。系统会在所选搜索服务中完整构建并验证新索引，再将其设为生效索引。兼容的已存储嵌入结果会被复用，因此只切换搜索服务不会重复调用相同模型。
6. 验证搜索和常规文档可用性后，再按照备份策略处理旧搜索服务数据。

切换回原来的服务也执行相同步骤。旧的物理索引不会被自动重新启用。搜索服务变化不会修改 Developer OpenAPI 的请求和响应结构。

搜索持续不可用时，确认运行日志中的搜索服务符合预期、所有容器都能访问端点、TLS 和凭据有效，并确认该知识库的**维护索引**已经完成。维护操作运行期间不要反复重启工作进程。

## 轮换模板附带 OpenSearch 的 TLS

普通重启不会轮换证书。需要轮换时，先停止全部服务，并备份 `opensearch-security`、`runtime-secrets` 和 OpenSearch 数据。把现有 `opensearch-security` 目录、`runtime-secrets/opensearch-password` 和 `runtime-secrets/opensearch-ca.pem` 一起移动到受保护的备份存储，再创建一个空的 `opensearch-security` 目录；`runtime-secrets` 中其他无关文件保持不变。启动一次全部服务，确认 OpenSearch 健康、Admin 搜索和 Developer OpenAPI 搜索正常后，才能处理之前匹配的安全文件备份。

启动报告 `OpenSearch security assets are incomplete or invalid` 时，保留失败状态原样用于诊断；初始化程序不会修复不完整的安全目录与运行时密码组合。应从同一份备份还原匹配的安全目录、密码文件和 CA 文件，或者执行停止全部服务后的轮换流程。不要只删除一个生成文件，也不要在不同部署之间复制证书。

## 容量说明

生产模板默认把 `worker` 限制在 2 个 CPU、2 GiB 内存和 128 个进程或线程以内。启动硬上限在 `.env` 中调整。观察部署资源后，在**设置**中调整 Worker、生成知识库、维护、搜索、图关系和语义搜索，在**模型配置**中管理嵌入模型。避免使用一次性读取全部来源文件或全部关系数据的脚本。详见 [环境变量配置](./environment.md#worker-启动限制) 和 [Admin 配置](./admin-settings.md)。
