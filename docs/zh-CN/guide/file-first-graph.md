---
title: 来源文件证据与图关系
---

# 来源文件证据与图关系

Focowiki 会为生成后的 Markdown 页面构建轻量关系图，并在知识库具有生效语义契约时建立向量与 GraphRAG 语义投影。图关系状态保存在 PostgreSQL，处理过程通过 Redis 协调，并以文件形式发布到 OKF bundle 中。Agent 可以继续通过文件树和内容读取接口探索关系。

本文所说的“来源文件证据”表示来源 Markdown 始终是权威内容，搜索、向量和图关系只负责发现候选，Agent 回答前仍需读取来源文件。这不是搜索通道的优先级：Developer OpenAPI 省略 `mode` 时默认执行 `hybrid`，并行运行所有可用的文件、关键词、向量和图检索通道，再融合为来源文件结果。系统同时增加稳定的关系文件，让删除、重试和重新发布流程能够复用同一份图关系状态。

## 为什么需要

大规模知识库需要稳定的跨文件关系。模型 prompt 可以检查当前文件和有限候选文件，但无法把一个文件和几千、几万篇文档逐一比较。

Focowiki 把关系生成拆成两层：

| 层级 | 作用 |
| --- | --- |
| 内容画像 | 从每个 Markdown 正文生成通用画像，包括摘要、主题、关键词、实体、显式引用、标题结构和安全 frontmatter context。 |
| 确定性候选 | 使用有界数据库读取和内容证据，例如 Markdown links、标题提及、共享实体、共享主题、显式引用和已有互相关系。 |
| 可选模型确认 | 只把当前文件画像、有界正文视图和候选文件卡片发送给配置好的模型。模型只能确认、拒绝、分类、打权重和解释已有候选。 |

模型不能发明目标文件。模型确认拒绝某个候选时，这个候选不会作为 accepted relationship 发布。模型确认失败时，具有强正文证据的确定性关系仍然可以发布。

共享状态、宽泛类型、低信息量标签或生成的系统标题不会单独生成页面 `Related` link。metadata 可以作为辅助证据，但关系需要先有正文画像中的内容证据。

## 生成文件

图关系文件位于生成 bundle 的 `_graph/` 目录。

```text
_graph/
  index.md
  graph_node/v1/
    {shard}.json
  graph_edge/v1/
    {shard}.json
  by-file/
    {fileId}.json
```

| 文件 | 作用 |
| --- | --- |
| `_graph/index.md` | 给人和 Agent 使用的图关系入口。 |
| `_index/catalog.json` | 当前图节点和图边投影分片的有界目录。 |
| `_graph/graph_node/v1/*.json` | 分片图节点记录。 |
| `_graph/graph_edge/v1/*.json` | 分片关系记录，适合导出和审计。 |
| `_graph/by-file/{fileId}.json` | 单个生成页面的有界本地关系，这是 Agent 探索关系的主要文件。 |

存在图输出时，根目录 `index.md` 会链接 `_graph/index.md`。Agent 的常规读取路径从生成后的 Markdown 页面开始，再读取 `_graph/by-file/{fileId}.json`。完整 edge shards 通常用于导出和检查。

## 页面引用

由上传文件生成的 Markdown 页面在存在图关系时会写入稳定 frontmatter。

```yaml
fileId: "source-file-123"
graph: "../_graph/by-file/source-file-123.json"
```

页面正文可以包含由持久化图边生成的 `Related` section。同一组图边也会写入 `_index/links.json`，因此 Markdown 页面、JSON indexes 和 per-file graph files 使用同一份关系来源。

## 关系字段

每条关系记录只包含安全公开字段。

| 字段 | 含义 |
| --- | --- |
| `fileId` | 相关已发布来源文件标识。 |
| `path` | 相关生成 Markdown 路径，例如 `pages/example.md`。 |
| `title` | 相关文件标题。 |
| `relationType` | 关系类型，例如 `direct_reference`、`same_entity`、`same_specific_subject` 或 `metadata_supported_content`。 |
| `direction` | 当前文件指向相关文件时为 `outgoing`，其他文件指向当前文件时为 `incoming`。 |
| `weight` | `0` 到 `1` 的有界优先级分数。 |
| `reason` | 面向用户、开发者和 Agent 的安全解释。 |
| `source` | 关系来源，例如 `deterministic` 或 `model_confirmed`。 |
| `contentAvailable` | 相关 Markdown 内容是否可通过文件读取接口访问。 |

图关系文件只暴露逻辑标识和逻辑路径。它们不会暴露 S3 object keys、本地文件路径、Redis keys、SQL details、模型 provider payloads 或 secrets。

## Agent 探索流程

1. 读取 `index.md`，了解知识库整体结构。
2. 需要发现关系时，沿 `index.md` 中的图入口继续读取。
3. 读取 `schema.md`，理解 metadata 和生成文件约定。
4. 在任务需要时检查 `_index/*`，获取生成后的 search、links、manifest 或 tree 线索。
5. 分页列出生成文件树。
6. 打开相关的 `pages/*.md` 文件，并读取完整 Markdown 正文。
7. 读取页面 frontmatter，找到 `fileId`、`path` 和 `graph`。
8. 打开 `_graph/by-file/{fileId}.json`，调用 related-file endpoint，或用已知 file ID 调用 Developer OpenAPI graph expansion。
9. 读取图扩展或图关系文件返回的相关页面路径。
10. 根据任务需要继续沿 Markdown links、文件树、`_index/*`、搜索候选和图关系读取证据。

Developer OpenAPI 也提供一个有界 related-file endpoint，方便偏好 JSON list 的后端集成。文件读取仍然是 Agent-facing 的主要契约。

管理后台预览页复制的是当前选中生成文件的 Developer OpenAPI content URL。`pages/示例.md` 这样的安全 Unicode 页面路径会在复制 URL 中被编码，并由 Developer OpenAPI 解析到 active generated file。

## 图搜索

Developer OpenAPI 文件搜索默认使用 `mode=hybrid`。系统在各自的有界预算内并行执行精确路径、精确标题、词法、Jieba、文件图、正文向量、实体向量、关系向量和社区向量等可用通道，再通过确定性融合与稳定排序规则生成一个去重后的来源文件结果列表。精确路径和有正文证据的精确标题仍保持明确的优先级。`mode=file` 用于显式缩小到文件发现范围并保持既有调用契约；`mode=graph` 用于显式缩小到持久化图节点和图关系范围。

正文向量覆盖每个活动来源文件；存在生效语义投影时，融合检索还可以使用有界的实体、关系和社区证据增强来源文件发现。只有生成模型负责的语义骨架采用稀疏选择，未被选中的文件仍参与精确、词法、Jieba、正文向量和文件图检索。搜索返回已发布来源文件结果和可选的 `semanticStatus`，不会返回生成答案、原始向量、prompt 或内部语义记录。可选语义通道较慢或不可用时，已经完成的安全通道仍可在整体查询时限内返回结果。

图搜索读取的是生成 `_graph/` 文件和 `Related` section 的同一份活动关系投影。请求过程中不会临时解析图文件。这样可以让大规模知识库查询保持有界，并让导入、删除和发布流程通过同一个活动 generation 更新图读取。

每个图搜索结果可以包含 `matchType`、`graphContext.graphRef`、`graphContext.relationships`、`graphContext.graphPaths` 和结果级 `readActions`。图字段用于导航，随后通过 `readActions` 按 ID 或路径读取生成后的 Markdown 文件。生成后的 Markdown 文件内容仍然是回答前应该读取的证据来源。

图扩展可以使用 file、node、edge 或 query 作为 seed，并返回有界关系路径和文件读取动作。Agent 拿到有价值的文件或图候选后，可以使用图扩展继续发现相邻文件，再回到同一个 loop 读取 Markdown 文件。搜索和图扩展用于发现线索。完整 Markdown 文件仍然是最终回答的证据来源。

## 运行说明

PostgreSQL 保存关系事实、投影影响项、活动图节点和活动图边。Redis 协调范围锁、cursor 和短期图缓存。S3 兼容存储将生成后的 `_graph/` Markdown 与机器分片保存为活动 generation 引用的不可变对象。

处理粒度是单个文件。知识库已有当前语义契约时，上传和正文替换会自动执行完整来源索引、有界 GraphRAG 增强、语义协调、向量生成、受影响图与生成内容投影，以及所选搜索服务的最终入库。每个来源文件都会进入精确路径、精确标题、词法、Jieba、正文向量、文件图和所选搜索服务索引；模型生成的图增强只处理由确定性内容结构和文件关系选出的重要来源，避免大批量导入时为每个分块分别请求生成模型。搜索入库是最后的就绪门禁。创建、替换、重命名、移动或删除文件时，只更新受影响的文件、关系、语义、向量、反向引用、生成内容和搜索范围；目录操作使用有界子项批次。普通变更不会触发完整知识库图重建，也不依赖手动维护索引；失败文件可以通过同一个 source-file retry flow 手动重试。

可选语义增强使用 Admin 管理的生成模型和向量模型。它可以在现有页面和 `_graph` 资源中增加有界实体上下文与证据更充分的关系解释，但不会增加另一套公开文件树、图数据库、实体管理控制台或图可视化 UI。现有 Markdown 路径、导航文件、稳定叶文件、来源正文和 Developer OpenAPI 读取流程保持不变。显式维护只用于建立首个契约、接入契约或搜索服务变更、修复、恢复和完整重建；构建并校验替换语义投影期间，当前可读内容继续生效。

当前版本从干净的破坏式存储基线启动，不复用或转换旧版本的知识库、来源内容、模型设置、生成内容、语义产物或搜索索引；需要把来源 Markdown 重新导入空目标部署。**维护索引**继续用于后续当前基线内的契约或搜索服务接入。完整覆盖与稀疏增强含义不同：每个活动来源文件都会获得上面列出的完整确定性与向量检索覆盖，只有有界语义骨架会使用生成模型。来源 Markdown 始终是权威内容，并继续通过相同的 Developer OpenAPI 读取动作返回。

大批量导入时，应保留部署环境中的 source-worker CPU 与内存上限，并在同时观察生成模型 endpoint、向量模型 endpoint、PostgreSQL、对象存储和所选搜索服务后再提高 Admin 并发。即使本地 CPU 和内存保持在限制内，外部模型延迟仍可能是主要索引耗时。文件处理状态和维护状态会展示进度与安全错误，不需要对全部语料重新重试。
