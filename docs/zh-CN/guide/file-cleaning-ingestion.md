---
title: 文件清洗入库指南
---

# 文件清洗入库指南

Focowiki 上传 Markdown 文件。团队从 PDF、Word、HTML、表格、OCR 文本、系统导出或混合文件夹开始时，需要先在系统外完成清洗，并输出稳定的 `.md` 文件。

这份指南说明目标文件形态和清洗流程。它适用于手册、制度、研究记录、合同、法规、客服知识、产品文档和内部知识库等专业资料。

## 目标输出

当一份资料需要作为完整文档阅读时，清洗结果应输出为一个 UTF-8 Markdown 文件。大型资料包可以在包含多个独立文档时拆分，拆分过程应保留来源标题、来源标识和章节边界。

目标文件包含三部分：

| 部分 | 作用 |
| --- | --- |
| YAML frontmatter | 保存稳定元数据，用于展示、过滤、搜索、来源追踪和 Agent context。 |
| Markdown 正文 | 保存完整可读文档，包括标题、段落、表格、列表、引用和链接。 |
| 来源说明 | 保存来源证据、转换说明、未解决问题和更新记录。 |

Focowiki 会解析安全的 frontmatter 字段，保留领域元数据，读取标题和链接，并生成包含 `index.md`、`schema.md`、`_index/`、`pages/` 和 `_graph/` 文件的 OKF-style 文件知识库。

## 文件夹路径与生成路径

Admin 上传弹窗支持选择零散 Markdown 文件，也支持选择包含多层子目录的文件夹。文件夹上传会保留经过 NFC 规范化的相对路径。来源文件 `handbook/onboarding/guide.md` 会发布为 `pages/handbook/onboarding/guide.md`，零散文件按 basename 放在 `pages/` 下。

再次选择同一个文件夹时，系统只添加知识库中尚不存在的路径。已有 active path 会被跳过，并保留原 source ID 和 revision。已有路径的内容变更通过明确的 source-file replacement 操作完成。

选择内容中的每一项都必须是 `.md` 文件。路径 segment 应保持稳定，并避开绝对路径、`.`、`..`、反斜杠、控制字符和只有大小写差异的重复路径。Focowiki 保留符合 `index.md`、`index-<number>.md`、`index-map-<number>.md`、`log.md` 和 `log-<number>.md` 形式的生成导航文件名。上传前需要重命名使用这些 basename 的来源文件。

当一个目录的直接列表超过配置预算时，Focowiki 会生成目录 `index.md`、编号 index 页面和 index-map 页面。这些导航页面互相链接，并继续通过文件树和内容接口提供。Agent 使用它们寻找 source-backed Markdown 页面，再读取这些页面作为证据。

## 清洗流程

所有来源格式使用同一套流程。不同格式可以使用不同工具，最终输出契约保持一致。

| 步骤 | 工作内容 |
| --- | --- |
| 盘点 | 列出源文件、来源系统、文件负责人、发布日期、更新日期、标识符、语言和已知重复文件。 |
| 抽取 | 从原始资料中提取文本、表格、标题、链接、图注、脚注和来源 URL。 |
| 规范化 | 修复编码、标题层级、段落断行、表格布局、引用格式、重复页眉和重复页脚。 |
| 映射元数据 | 将来源元数据转换为安全的 YAML frontmatter。领域字段有助于阅读和 Agent 探索时可以保留。 |
| 渲染 Markdown | 按文档或明确的拆分单元写入稳定 `.md` 文件。 |
| 校验 | 检查 frontmatter、链接、重复标题、来源证据、不安全字段、文件大小和可读性。 |
| 抽样复核 | 在大批量上传前复核代表性文档。 |
| 上传 | 通过 Admin UI 或 Developer OpenAPI 上传清洗后的 Markdown，并检查生成结果。 |

## Markdown 结构

清洗后的 Markdown 文件应从 YAML frontmatter 开始。

```md
---
type: "policy"
title: "Customer Data Handling Policy"
description: "Rules for handling customer data in support and operations workflows."
tags:
  - data-governance
  - support
sourceUrl: "https://example.com/policies/customer-data"
sourceName: "Company Policy Portal"
publishedAt: "2026-03-01"
updatedAt: "2026-05-15"
version: "2026.05"
language: "en"
externalId: "policy-customer-data"
sourceHash: "sha256:example"
---

# Customer Data Handling Policy

## Scope

This policy applies to support, operations, and account management teams.

## Handling Rules

| Case | Required Action |
| --- | --- |
| Customer account question | Verify the requester identity before sharing account details. |
| Export request | Follow the approved export workflow and record the request. |

## Related Materials

- [Support escalation policy](./support-escalation.md)
```

每个文件使用一个清晰文档标题。标题层级保持稳定。可读表格保留为 Markdown table。来源链接保留为 Markdown link。脚注和附录在版式无法安全表达时转换为普通 Markdown section。

## 元数据规范

常见元数据字段：

这些字段是推荐示例，用于提升 Markdown 文件的互操作性。上传文件可以包含领域专有元数据。Focowiki 会保留安全且合法的 frontmatter 字段，并透传到生成结果中。

| 字段 | 用途 |
| --- | --- |
| `type` | 文档类型，例如 `policy`、`manual`、`contract`、`research-note` 或 `page`。 |
| `title` | 原始标题或规范标题。 |
| `description` | 经人工书写或复核的简短摘要。 |
| `tags` | 主题、团队、产品、地区或流程标签。 |
| `sourceUrl` | 规范网页、文档系统地址或公开引用地址。 |
| `sourceName` | 系统、发布方、仓库或数据集名称。 |
| `publishedAt` | 原始发布日期。 |
| `updatedAt` | 来源最后更新时间。 |
| `version` | 来源版本、发布号、版次或状态标记。 |
| `language` | 文档主要语言。 |
| `externalId` | 来源系统中的稳定 ID。 |
| `sourceHash` | 清洗来源或原始抽取输入的 hash。 |

领域专有元数据示例包括但不限于 `owner`、`department`、`region`、`product`、`category`、`status`、`jurisdiction`、`standard`、`reviewCycle` 或 `sourceSystem`。

需要移除的字段包括 secrets、本地文件路径、私有对象存储路径、临时转换目录、provider payload、原始凭证、内部队列 ID 和一次性处理 run ID。

## 清洗 Skill 示例

开发者可以在自己的 Agent 环境中放置一个轻量 Skill，用来规范重复的数据清洗工作。这个 Skill 的职责保持收敛：读取源文件、输出 Markdown、基于证据补充 metadata，并写出简短复核报告。

示例 `SKILL.md`：

```md
---
name: clean-focowiki-markdown
description: Use when a user asks to clean source documents into Focowiki-ready Markdown, normalize frontmatter, supplement metadata from document evidence, or prepare files for upload to a file-first knowledge base.
---

# Clean Focowiki Markdown

## Reference

Read the Focowiki file cleaning guide before cleaning when network access is available:
https://docs.focowiki.com/guide/file-cleaning-ingestion

## Workflow

1. Inspect the input folder and identify source formats, duplicate files, document titles, source evidence, and unsafe fields.
2. Preserve the original files. Write cleaned Markdown files to a separate output folder.
3. Produce one `.md` file for each readable document. Split only when a source package contains multiple independent documents.
4. Add YAML frontmatter with verified metadata. Use source evidence, document headings, and body content before adding fields.
5. Keep domain-specific metadata when it is safe and useful. Remove secrets, local paths, private storage paths, temporary run IDs, provider payloads, and credentials.
6. Preserve the complete readable body with stable headings, tables, lists, citations, and links.
7. Validate YAML, filenames, duplicate titles, encoding, links, OCR risk areas, and large files.
8. Write a short report with processed counts, skipped files, uncertain metadata, manual review items, and upload readiness.

## Metadata Rules

- `title`: use the source title or first reliable heading.
- `description`: write one neutral sentence from the document body.
- `tags`: use 3 to 8 compact topic tags supported by the content.
- `sourceUrl`, `sourceName`, `publishedAt`, `updatedAt`, `version`, `externalId`, and `sourceHash`: fill only when evidence exists.
- Domain fields: preserve safe fields such as `owner`, `region`, `status`, `category`, `jurisdiction`, `product`, or `sourceSystem`.
- Unknown fields: omit the field or leave an empty value according to the user's project convention.

## Output

Return:

- Cleaned Markdown output folder
- Validation summary
- Manual review list
- Upload recommendation
```

## 来源格式处理

| 来源格式 | 清洗要求 |
| --- | --- |
| Word 和富文本 | 保留标题、列表、表格、关键脚注、重要批注和修订结论。移除只用于视觉展示的样式。 |
| PDF | 按阅读顺序抽取文本。重建标题和表格。检查页眉、页脚、断词换行和分栏顺序。 |
| HTML 和网页导出 | 保留语义标题、正文、canonical URL、链接、表格和发布元数据。移除导航、cookie banner、广告和重复布局块。 |
| 表格和 CSV 记录 | 当独立行、sheet 或记录组代表一个可读知识项时，将其转换为 Markdown。需要直接比较的结构化值可以保留为表格。 |
| 扫描件和 OCR 文本 | 复核 OCR 置信度、名称、数字、日期、标题、表格单元格和标点。未解决的 OCR 问题写入来源说明。 |
| JSON、XML、数据库导出和 API 导出 | 将稳定字段映射到 frontmatter。面向读者的内容渲染为正文、列表或表格。保留原始标识符。 |
| 既有 Markdown 文件夹 | 统一 frontmatter、标题风格、相对链接、标题层级、文件名和重复页面。保留有意义的 Markdown links。 |
| 混合资料库 | 每类来源使用对应抽取方式，然后统一应用同一套 Markdown 和元数据标准。 |

## 正文规则

正文应包含读者或 Agent 检查文档所需的完整信息。

- 保留定义、例外、约束、示例、表格和附录。
- 章节顺序影响含义时保留原顺序。
- 保留引用、参考资料、来源 URL 和相关文档链接。
- 使用普通 Markdown links 表达清洗后文件之间的关系。
- 存在未解决转换问题时，使用简短的 `## Source Notes` section 记录。
- 正文中的生成摘要保持简短，原始内容仍然作为主体。

## 质量检查

上传前执行这些检查：

| 检查项 | 检查内容 |
| --- | --- |
| YAML | frontmatter 可以正常解析，并使用有效字符串、数组、日期和布尔值。 |
| 标题 | 每个文件有一个清晰标题。重复标题有明确原因且可追踪。 |
| 文件名 | 文件名稳定、可读，并以 `.md` 结尾。 |
| 编码 | 文件使用 UTF-8，并保留标点、名称、数字和日期。 |
| 标题层级 | 标题层级合乎逻辑，并保留重要结构。 |
| 表格 | 表格仍然可读，没有丢失列或行标签。 |
| 链接 | 相对链接和来源链接可以解析，或有明确说明。 |
| OCR | 高风险名称、数字、日期和标题经过人工复核。 |
| 元数据 | 领域字段有用、安全，并且不包含临时处理细节。 |
| 文件大小 | 超大文档经过拆分点复核。 |
| 隐私 | secrets、本地路径、私有存储路径、内部 URL 和凭证已移除。 |

大规模上传前，从每种来源类型中抽样复核。样本应包含普通文件、长文件、短文件、表格密集文件、链接密集文件和来源元数据缺失文件。

## 上传和检查

清洗完成后，通过 Admin UI 或 Developer OpenAPI 上传 Markdown 文件。

处理完成后检查这些输出：

| 输出 | 检查内容 |
| --- | --- |
| `pages/*.md` | 标题、frontmatter、正文、相关链接和来源说明。 |
| `index.md` | 知识库概览和页面列表。 |
| `schema.md` | 元数据约定和生成文件约定。 |
| `_index/search.json` | 搜索字段、标题、摘要、标签和路径。 |
| `_index/links.json` | Markdown links 和 graph-backed related links。 |
| `_graph/by-file/{fileId}.json` | 单文件关系、原因、权重和相关页面路径。 |
| `log.md` | 最近发布历史和滚动更新记录。 |

生成文件应暴露逻辑路径和安全元数据。生成文件不应暴露本地路径、S3 object keys、转换目录、凭证或 provider payload。

## 入库验收标准

清洗后的 Markdown 资料库满足这些条件时可以上传：

- 每个文件都是有效 `.md` 文件。
- 每个文档都有清晰标题。
- frontmatter 包含有用的来源和领域元数据。
- 正文保留文档的完整可读内容。
- 链接和引用能够帮助人员和 Agent 探索。
- 可用来源证据已经保留。
- 不安全内部细节已经移除。
- 抽样复核确认生成后的 `pages/`、`_index/` 和 `_graph/` 文件可以理解。

## 相关文档

- [Google OKF 规范](./open-knowledge-format.md)
- [文件优先图关系](./file-first-graph.md)
- [Developer OpenAPI](../openapi/index.md)
