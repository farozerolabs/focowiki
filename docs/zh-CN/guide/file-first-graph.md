---
title: 文件优先图关系
---

# 文件优先图关系

Focowiki 会为生成后的 Markdown 页面构建轻量关系图。图关系状态保存在 PostgreSQL，处理过程通过 Redis 协调，并以文件形式发布到 OKF bundle 中。Agent 可以继续通过文件树和内容读取接口探索关系。

这个能力保持文件优先。系统增加稳定的关系文件，同时让删除、重试和重新发布流程能够复用同一份图关系状态。

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
  manifest.json
  nodes.jsonl
  nodes/
    0000.jsonl
  edges/
    0000.jsonl
  by-file/
    {fileId}.json
```

| 文件 | 作用 |
| --- | --- |
| `_graph/index.md` | 给人和 Agent 使用的图关系入口。 |
| `_graph/manifest.json` | 记录数量、路径模式、生成时间和图元数据。 |
| `_graph/nodes.jsonl` | 节点索引入口。小知识库在这里保存节点记录，大知识库在这里保存分片描述。 |
| `_graph/nodes/*.jsonl` | 大规模生成知识库的分片节点记录。 |
| `_graph/edges/*.jsonl` | 分片关系记录，适合导出和审计。 |
| `_graph/by-file/{fileId}.json` | 单个生成页面的有界本地关系，这是 Agent 探索关系的主要文件。 |

Agent 的常规读取路径应从生成后的 Markdown 页面开始，再读取 `_graph/by-file/{fileId}.json`。完整 edge shards 通常用于导出和检查。

## 页面引用

source-backed pages 在存在图关系时会写入稳定 frontmatter。

```yaml
fileId: "source-file-123"
graph: "../_graph/by-file/source-file-123.json"
```

页面正文可以包含由持久化图边生成的 `Related` section。同一组图边也会写入 `_index/links.json`，因此 Markdown 页面、JSON indexes 和 per-file graph files 使用同一份关系来源。

## 关系字段

每条关系记录只包含安全公开字段。

| 字段 | 含义 |
| --- | --- |
| `fileId` | 相关 source-backed file identifier。 |
| `path` | 相关生成 Markdown 路径，例如 `pages/example.md`。 |
| `title` | 相关文件标题。 |
| `relationType` | 关系类型，例如 `explicit_reference`、`title_mention`、`shared_entity`、`shared_subject`、`metadata_supported_content` 或 `model_related_link`。 |
| `direction` | 当前文件指向相关文件时为 `outgoing`，其他文件指向当前文件时为 `incoming`。 |
| `weight` | `0` 到 `1` 的有界优先级分数。 |
| `reason` | 面向用户、开发者和 Agent 的安全解释。 |
| `source` | 关系来源，例如 `deterministic` 或 `model_confirmed`。 |
| `contentAvailable` | 相关 Markdown 内容是否可通过文件读取接口访问。 |

图关系文件只暴露逻辑标识和逻辑路径。它们不会暴露 S3 object keys、本地文件路径、Redis keys、SQL details、模型 provider payloads 或 secrets。

## Agent 探索流程

1. 读取 `index.md`，了解知识库整体结构。
2. 读取 `schema.md`，理解 metadata 和生成文件约定。
3. 分页列出生成文件树。
4. 打开相关的 `pages/*.md` 文件。
5. 读取页面 frontmatter，找到 `fileId` 和 `graph`。
6. 打开 `_graph/by-file/{fileId}.json`。
7. 读取图关系文件返回的相关页面路径。
8. 根据任务需要继续沿 Markdown links 和图关系读取证据。

Developer OpenAPI 也提供一个有界 related-file endpoint，方便偏好 JSON list 的后端集成。文件读取仍然是 Agent-facing 的主要契约。

管理后台预览页复制的是当前选中生成文件的 Developer OpenAPI content URL。`pages/示例.md` 这样的安全 Unicode 页面路径会在复制 URL 中被编码，并由 Developer OpenAPI 解析到 active generated file。

## 运行说明

PostgreSQL 保存 graph nodes、graph edges 和 graph job records。Redis 协调 locks、cursors 和 processing state。S3 兼容存储保存生成后的 `_graph/` 文件和其他 OKF bundle 文件。

处理粒度是单个文件。某个 source file 的图关系失败不会要求其他文件停止处理。失败文件可以通过同一个 source-file retry flow 手动重试。

第一版不增加 embeddings、vector search、rerankers、graph database 或 graph visualization UI。开发者仍然可以在生成 bundle 之上按需要增加搜索或向量访问层。
