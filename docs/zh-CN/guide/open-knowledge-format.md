---
title: Google OKF 规范
---

# Open Knowledge Format

Focowiki 生成与 Google Open Knowledge Format（OKF）0.2 对齐的 Markdown 知识库。该格式通过 Markdown 文件、可选 YAML frontmatter、标准链接、目录索引和更新日志保持知识的可移植性与可读性。

## 官方基线

Focowiki 固定使用一个已获取的规范版本，避免上游修改静默改变校验行为。

- [Google Cloud OKF 0.2 公告](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals)
- [OKF 0.2 规范固定版本 `930b65fc`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/930b65fc3f5619d5d0591f88c72ebae8b848d60d/okf/SPEC.md)

实现会区分官方规则与 Focowiki 生成规则。

| 分类 | 行为 |
| --- | --- |
| 官方 OKF 0.2 | 描述可移植的来源、生成、验证、生命周期和 Attested Computation metadata。这些字段对上传文件属于建议项。 |
| 产品安全规则 | 上传内容必须是安全 Markdown；路径受支持；存在 frontmatter 时 YAML 可解析；数据可安全序列化；资源大小在允许范围内。 |
| Focowiki 生成规则 | 生成链接可以访问，链接标签与目标 concept 一致，导航完整，大目录使用有界续页 concept。 |

缺失、不完整或格式错误的 OKF 字段本身不会阻止上传、发布、无过滤搜索或文件读取。Focowiki 保留安全的原始 frontmatter；只有成功规范化的值会参与派生信号和过滤；产品不会限定领域分类体系。

## Concept 文件

上传文件可以是普通 UTF-8 Markdown，也可以包含 YAML frontmatter。下面所有 OKF 0.2 字段对产品上传而言均为可选项；来源存在可靠证据时补充这些字段，可以提升互操作性和决策支持能力。

```md
---
okf_version: "0.2"
type: "Guide"
title: "Incident response"
description: "Steps for responding to a production incident."
tags:
  - operations
  - reliability
sources:
  - id: "service-handbook"
    resource: "references/service-handbook.md"
generated:
  by: "publisher:docs"
  at: "2026-07-13T00:00:00Z"
verified:
  - by: "human:platform-reviewer"
    at: "2026-07-13T01:00:00Z"
status: "stable"
stale_after: "2026-10-13"
---

# Incident response

Start by confirming the affected service and current impact.
```

`sources` 记录来源，`generated` 记录生成事件，`verified` 记录复核事件，`status` 与 `stale_after` 描述生命周期。旧版 `timestamp` 仍可读取，并会作为可区分的生成时间回退来源。安全的未知字段仍会作为生产方 metadata 保留。

## 决策信号与搜索过滤

Developer OpenAPI 的文件 metadata 和搜索结果会返回保留的原始 `frontmatter`，以及一个 `okfSignals` 对象。该对象包含可为空的规范化状态、验证层级、是否过期、过期日期、生成时间及其来源、最近验证时间和来源数量。

省略 `status` 时有效值为 `stable`；显式提供无效状态时结果为 `null`。省略验证信息时层级为 `unverified`；显式提供格式错误的验证信息时结果为 `null`。缺少有效 `stale_after` 时新鲜度为 `null`；显式提供格式错误的 sources 时来源数量为 `null`。这些信号仅用于提示，不授予权限，也不会执行内容。

现有文件搜索接口增加可选的 `okfStatus`、`okfTrustTier` 和 `okfFreshness` 过滤字段。使用过滤条件时，对应规范化信号为 `null` 的文件会被排除；这些文件仍可通过直接读取和无过滤搜索访问。

## Attested Computation

OKF 0.2 可以使用 `Attested Computation` 描述 runtime、parameters、内联或引用的 computation、executor 和 attester。Focowiki 会保留完整或不完整但安全的 metadata，并通过既有树、文件、内容、搜索、关系图和相关文件接口暴露 Markdown。产品不会执行 computation，也不会把 metadata 当作授权证明。

只有被上传并作为受支持知识库文件发布的安全本地引用，才会作为可读文件被发现。指向被排除 runtime asset 的引用可以保留在 frontmatter 中，但不会被声明为可读取的 Focowiki 文件。

## 保留文件

精确文件名 `index.md` 和 `log.md` 为保留文件。

根目录 `index.md` 的 frontmatter 只能声明 `okf_version: "0.2"`。嵌套目录中的 `index.md` 不包含 frontmatter。两者都使用标题和标准 Markdown 链接。

```md
---
okf_version: "0.2"
---
# Product knowledge

## Explore

- [Browse documents](/pages/index.md) - 3 top-level entries.
- [Relationship graph](/_graph/index.md) - 12 accepted relationships.
- [Metadata schema](/schema.md)
- [Update history](/log.md)
- [Machine-readable indexes](/_index/index.md)
```

嵌套目录索引使用相同的直接结构，不包含 frontmatter：

```md
# Runbooks

[Parent directory](/pages/index.md)

[Knowledge base](/index.md) · [Documents](/pages/index.md) · [Machine-readable indexes](/_index/index.md) · [Relationship graph](/_graph/index.md)

[Browse entries](/pages/runbooks/index-<stable-id>.md)
```

根目录 `log.md` 不包含 frontmatter。文件以 `# Directory Update Log` 开始，在存在变更时间时写入当前发布日期，并包含一条有界的发布摘要。

```md
# Directory Update Log

## 2026-07-13

* **Publication**: Published 12 source-backed Markdown files.
```

## 链接与来源

Focowiki 生成的内部链接使用以 `/` 开始的知识库相对路径。生成关系必须指向来源 Markdown 文件，或指向最终能够到达来源证据的带类型导航 concept。

Focowiki 不会合成带编号的 `# Citations` 章节。只有存在明确证据时才会生成结构化 `sources`。来源文件已有的链接、脚注和引用章节会保持原样，不会被重新设置格式、编号，也不会从无关字段推断来源。

## 生成结构

```text
index.md
log.md
schema.md
pages/
  index.md
  runbooks/
    index.md
    incident-response.md
  large-directory/
    index.md
    index-<stable-id>.md
_index/
  index.md
  catalog.json
  search/
    index.md
    v1/
      index.md
      index-<stable-id>.md
      0000.json
  manifest/, links/, tree/
    ...
_graph/
  index.md
  graph_node/, graph_edge/
    ...
  by-file/
    index.md
    index-<stable-id>.md
    <source-file-id>.json
```

`pages/` 下的来源 concept 始终是最终阅读和引用证据。`schema.md`、目录续页、`_index/` 和 `_graph/` 属于 Focowiki 生成扩展。当前发布格式将更新摘要保存在根目录的精确 `log.md` 中，不生成带编号的历史记录页。

精确 `index.md` 和 `log.md` 之外的生成 Markdown concept 使用普通 frontmatter 和描述性 `type`，例如 `Schema Reference` 或 `Directory Index Page`。包括 `_index/index.md` 和 `_graph/index.md` 在内的精确目录索引仍属于保留导航文件，不包含 frontmatter。

## 大目录与更新日志

精确目录 `index.md` 始终保持有界。当直接列表超过配置的条目或字节限制时，该文件会链接到稳定的 `index-<stable-id>.md` 类型续页。每个续页提供目录、上一页和下一页导航，并按确定顺序列出一段直接条目。Focowiki 不创建人工领域目录，也不会遗漏来源 concept。每个来源 concept 在所属目录导航序列中只出现一次。

根目录、文档目录、机器索引和关系图导航页都会链接到同一组有界的全局入口。类型化 projection JSON 和逐文件关系 JSON 可通过扩展目录链找到。逐文件关系条目还会链接到当前来源 Markdown 证据页；`_index/catalog.json` 保持有界，不逐项列出所有逐文件资源。

根目录 `log.md` 保存当前发布的有界摘要。当前发布格式不会生成 `log-000001.md` 或其他带编号的历史记录页。

## 发布校验

候选 generation 通过 concept、保留文件、生成链接、续页链、来源导航、分片结构和删除缺失校验后才会进入可读状态。生成结果无效时，校验返回数量受限的规则 ID 和逻辑路径。

缺失或格式错误的 OKF 字段、未知类型、安全的未知字段、缺少可选用户索引、指向被排除 asset 的来源引用，以及来源文件中的失效链接仍然可以读取。Focowiki 对自己生成的 artifact 执行严格所有权和链接校验；用户编写内容的规范差异只作为非阻塞提示。

Admin 预览与 Developer OpenAPI 使用相同的逻辑路径和生成 Markdown 内容。生成文件不会包含 Admin URL、存储路径、队列状态、凭证或仅供服务内部使用的标识符。

## 大规模知识库

目录导航和 generation 校验使用有界分页、续页 concept 和 generation 范围内的持久化事实。大规模知识库不需要一个包含全部文件的 Markdown 索引，也不需要在单个进程中加载所有来源正文。

验证覆盖扁平和嵌套的 100,000 concept 结构，并检查 Markdown 文件有界、导航完整、链接覆盖确定和资源使用稳定。
