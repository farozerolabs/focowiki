---
title: Google OKF 规范
---

# Google OKF 规范

Focowiki 生成与 Google Open Knowledge Format（OKF）0.2 对齐的可移植 Markdown 知识库。即使没有可选的 OKF 元数据，上传的 Markdown 仍然可以读取。

## 官方基线

- [Google Cloud OKF 0.2 公告](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals)
- [OKF 0.2 规范，固定修订 `930b65fc`](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/930b65fc3f5619d5d0591f88c72ebae8b848d60d/okf/SPEC.md)

产品区分三类规则：

| 规则 | 含义 |
| --- | --- |
| 官方 OKF 0.2 | 定义推荐的来源、生成、验证、生命周期和 Attested Computation 元数据。 |
| 上传安全 | 要求路径受支持、内容是 UTF-8 Markdown、存在前置元数据时 YAML 可以解析、字段值安全且文件大小可接受。 |
| 生成知识库 | 要求导航完整、生成链接有效、路径可移植，并且索引文件保持有界。 |

OKF 字段都是可选上传字段。缺失、不完整或格式错误的 OKF 元数据本身不会阻止上传、普通文件读取或无过滤搜索。安全的原始前置元数据会继续保留；只有成功规范化的值才参与 OKF 筛选。

## Markdown 输入

文件可以是普通 Markdown，也可以由 YAML 前置元数据和 Markdown 正文组成。

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

只有来源提供可靠证据时才填写元数据：

- `sources` 记录来源。
- `generated` 记录生成事件。
- `verified` 记录复核事件。
- `status` 和 `stale_after` 描述生命周期。
- 安全的领域字段可以继续保留在前置元数据中。

不要编造来源、验证、所有权或生命周期信息。

## 决策信号与筛选

Developer OpenAPI 的文件和搜索响应会返回保留的 `frontmatter`，以及规范化后的 `okfSignals`。

规范化信号包括状态、验证层级、新鲜度、过期日期、生成时间、最近验证时间和来源数量。显式提供的无效值会规范化为 `null`。只有接口契约明确规定默认值时，省略的字段才使用默认值。

文件搜索支持可选的 `okfStatus`、`okfTrustTier` 和 `okfFreshness` 筛选。使用筛选时，对应规范化信号为 `null` 的文件会被排除；不需要限制结果时应省略这些字段。

这些信号只提供参考，不授予权限，也不会执行文档内容。

## Attested Computation

OKF 0.2 可以使用 Attested Computation 描述运行环境、参数、计算内容、执行者和证明者元数据。Focowiki 会保留安全元数据，并通过普通读取和搜索接口提供 Markdown。

Focowiki 不执行所描述的计算，也不会把相关元数据当作授权依据。本地引用只有在目标文件也已上传并且当前可读取时，才会成为可发现文件。

## 生成结构

生成知识库使用普通 Markdown 导航，以及有界的 JSON 发现和关系记录。

```text
index.md
log.md
pages/
  index.md
  index-directory-leaf-<stable-id>.md
  runbooks/
    index.md
    index-directory-leaf-<stable-id>.md
    incident-response.md
_index/
  index.md
  index-extension-leaf-<stable-id>.md
  catalog.json
  pages/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    all-documents.json
    runbooks/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      runbooks-documents.json
  terms/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    han/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      han-terms-part-0001.json
_graph/
  index.md
  index-extension-leaf-<stable-id>.md
  catalog.json
  by-directory/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    runbooks/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      runbooks-relationships.json
  by-file/
    index.md
    index-extension-leaf-<stable-id>.md
    runbooks/
      index.md
      index-extension-leaf-<stable-id>.md
      incident-response.json
```

这是一份结构示例。每个非空生成目录都有 `index.md` 和有界的稳定导航页。可读文档目录使用 `index-directory-leaf-<stable-id>.md`，机器可读目录使用 `index-extension-leaf-<stable-id>.md`。机器可读目录的路由文件名是 `index.json`；数据文件使用目录名或页面名形成语义化名称，只有需要分片时才追加 `-part-NNNN`。

系统只生成当前确实包含内容的目录和记录。关系分支和逐文件关系记录只在存在已接受关系时生成。

| 位置 | 用途 |
| --- | --- |
| `pages/**` | 从上传文档生成的完整可读 Markdown。 |
| `_index/pages/**` | 有界的页面和目录发现记录。 |
| `_index/terms/**` | 有界的多语言导航词项。 |
| `_graph/by-directory/**` | 按文档目录分组的关系。 |
| `_graph/by-file/**` | 单个可读文档的关系。 |
| `log.md` | 有界的近期文档变更。 |

`pages/**` 是最终阅读和引用证据；`_index/**` 和 `_graph/**` 用于发现和导航。

## 保留导航文件

精确文件名 `index.md` 和 `log.md` 保留给生成导航和更新记录使用。

根目录 `index.md` 可以包含 `okf_version: "0.2"` 前置元数据。嵌套 `index.md` 使用标题和普通相对链接。根目录 `log.md` 不包含前置元数据。

大目录使用稳定的 `index-<stable-id>.md` 续页。每个续页会链接所属目录，并在存在时链接上一页和下一页。一个来源文档在所属目录导航序列中只出现一次。

生成的 Markdown 链接相对于当前文件，生成的 JSON 路径相对于知识库根目录。因此，完整复制生成目录到其他位置后，内部导航仍然有效。

## 可移植公开内容

生成知识库文件只包含文档路径和安全的文档元数据，不包含：

- 生成器额外加入的产品名或服务名。
- 数据库、队列、任务、修订、模型或服务商标识。
- 服务 URL、本地文件路径、存储位置、对象键或凭据。

只要字段值符合安全格式，来源正文就会保留。来源编写的链接和引用部分不会被重新编号，也不会被推断出来的引用替换。

## 更新与校验

新增、替换、重命名、移动或删除文档时，受影响的导航、索引、关系和日志文件会一起更新；处理期间不相关的可读文档仍然可用。

生成文件的路径、链接、导航和记录结构通过校验后才会变为可读。只要 Markdown 和字段值安全，可选或格式错误的 OKF 元数据仍然不会阻塞文件。来源正文中的失效链接可以继续显示，方便读者回到来源材料修正。

大规模知识库中的目录导航和 JSON 资源始终保持有界，并在需要时使用续页或 `-part-NNNN` 文件。系统不要求使用一个 Markdown 页面列出全部文档。
