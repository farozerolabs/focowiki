---
title: Google OKF 规范
---

# Open Knowledge Format

Focowiki 生成与 Google Open Knowledge Format（OKF）v0.1 Draft 对齐的 Markdown 知识库。该格式通过 Markdown 文件、YAML frontmatter、标准链接、目录索引和更新日志保持知识的可移植性与可读性。

## 官方基线

Focowiki 固定使用一个已获取的规范版本，避免上游修改静默改变校验行为。

- [Google Cloud 公告](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF v0.1 Draft 固定版本 `ee67a5ca`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md)

实现会区分官方规则与 Focowiki 生成规则。

| 分类 | 行为 |
| --- | --- |
| 官方强制规则 | concept frontmatter 可以解析，concept 的 `type` 非空，保留文件 `index.md` 与 `log.md` 使用规定结构。 |
| 官方建议规则 | 来源存在可靠信息时，concept 使用清晰的标题、描述、资源、标签、时间、结构化 Markdown、链接、索引描述和编号引用。 |
| Focowiki 生成规则 | 生成链接可以访问，链接标签与目标 concept 一致，导航完整，大目录使用有界续页 concept。 |

缺少可选 metadata 或包含安全的未知 metadata 不会使 concept 失效。Focowiki 会保留安全的生产方字段，也不会限定领域分类体系。

## Concept 文件

每个非保留 Markdown concept 使用 UTF-8 Markdown 和 YAML frontmatter，并包含非空 `type`。

```md
---
type: "Guide"
title: "Incident response"
description: "Steps for responding to a production incident."
resource: "https://docs.example.com/incident-response"
tags:
  - operations
  - reliability
timestamp: "2026-07-13T00:00:00Z"
owner: "Platform team"
---

# Incident response

Start by confirming the affected service and current impact.
```

当来源提供可靠信息时，推荐使用 `title`、`description`、`resource`、`tags` 和 `timestamp`。`owner` 等字段可以作为生产方 metadata 保留。

## 保留文件

精确文件名 `index.md` 和 `log.md` 为保留文件。

根目录 `index.md` 的 frontmatter 只能声明 `okf_version: "0.1"`。嵌套目录中的 `index.md` 不包含 frontmatter。两者都使用标题和标准 Markdown 链接。

```md
---
okf_version: "0.1"
---
# Product knowledge

Generated at: 2026-07-13T00:00:00.000Z

## Explore

- [Browse documents](/pages/index.md) - Explore source-backed Markdown files by directory.
- [Metadata and navigation schema](/schema.md) - Review concept metadata and navigation conventions.
- [Update history](/log.md) - Review bounded publication history.
- [Machine-readable indexes](/_index/index.md) - Access generated manifests, search records, links, and changes.
```

嵌套目录索引使用相同的直接结构，不包含 frontmatter：

```md
# Runbooks

- [Incident response](/pages/runbooks/incident-response.md) - Steps for responding to a production incident.
```

根目录 `log.md` 不包含 frontmatter。文件以 `# Directory Update Log` 开始，内容按 ISO 日期分组，并将较新的日期放在前面。

```md
# Directory Update Log

## 2026-07-13

* **Publication**: Published 12 Markdown pages.

## 2026-07-12

* **Publication**: Published 10 Markdown pages.
```

## 链接与引用

Focowiki 生成的内部链接使用以 `/` 开始的知识库相对路径。生成关系必须指向来源 Markdown 文件，或指向最终能够到达来源证据的带类型导航 concept。

生成引用使用一个位于文件末尾的章节，并连续编号：

```md
# Citations

[1] [Source](https://docs.example.com/incident-response)
[2] [Service handbook](/pages/handbooks/service.md)
```

Focowiki 会保留来源文件中已有的链接和引用章节，不会重新设置格式或编号。

## 生成结构

```text
index.md
log.md
log-000001.md
schema.md
schema-frontmatter.md
schema-navigation.md
schema-extensions.md
pages/
  index.md
  runbooks/
    index.md
    incident-response.md
  large-directory/
    index.md
    index-000001.md
    index-map-000001.md
_index/
  index.md
  manifest.json
  search.json
  links.json
  changes.json
_graph/
  index.md
  manifest.json
  ...
```

`pages/` 下的来源 concept 始终是最终阅读和引用证据。`schema*.md`、`log-*.md`、目录续页、`_index/` 和 `_graph/` 属于 Focowiki 生成扩展。

精确 `index.md` 和 `log.md` 之外的 Markdown 扩展使用普通 concept frontmatter 和描述性 `type`，例如 `Schema Reference`、`Directory Index Page`、`Directory Index Map` 或 `Update History Page`。精确的 `_index/index.md` 与 `_graph/index.md` 仍属于嵌套保留索引，不包含 frontmatter。

## 大目录与历史记录

精确目录 `index.md` 始终保持有界。当直接列表超过配置的条目或字节限制时，该文件会链接到 `index-000001.md` 类型续页。每个续页提供目录、上一页和下一页导航，并按确定顺序列出一段直接条目。

续页目录超过限制时，精确索引会链接到 `index-map-000001.md` 类型 concept。Focowiki 不创建人工领域目录，也不会遗漏来源 concept。每个来源 concept 在所属目录导航序列中只出现一次。

根目录 `log.md` 保留有界的近期记录。更早的保留记录进入 `log-000001.md` 类型 concept，并提供根日志、上一页和下一页导航。

## 发布校验

生成 release 通过 concept、保留文件、生成链接、续页链和来源导航校验后才会进入可读状态。生成结果无效时，校验返回数量受限的规则 ID 和逻辑路径。

可选 metadata、未知类型、安全的未知字段、缺少可选用户索引和来源文件中的失效链接仍然可以读取。零失效链接规则只约束 Focowiki 生成的链接。

Admin 预览与 Developer OpenAPI 使用相同的逻辑路径和生成 Markdown 内容。生成文件不会包含 Admin URL、存储路径、队列状态、凭证或仅供服务内部使用的标识符。

## 大规模知识库

目录导航和 release 校验使用有界分页、续页 concept 和 release 范围内的持久化事实。大规模知识库不需要一个包含全部文件的 Markdown 索引，也不需要在单个进程中加载所有来源正文。

验证覆盖扁平和嵌套的 100,000 concept 结构，并检查 Markdown 文件有界、导航完整、链接覆盖确定和资源使用稳定。
