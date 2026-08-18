---
title: 来源文件证据与文档关系
---

# 来源文件证据与文档关系

Focowiki 始终把上传的 Markdown 作为权威证据，并在可读取文档之间建立轻量关系图。搜索、嵌入、GraphRAG 和关系记录用于发现相关文件；Agent 回答前仍应读取来源 Markdown。

这张图连接的是文档，不是独立的实体管理图，也不会替代文件树。

## 关系来源

文档关系可以来自：

- 来源正文中的 Markdown 链接。
- 支持的元数据中可安全解析的本地引用。
- 文档索引过程中经过确认的内容候选。

只有关系两端都能解析到可读取文档时，关系才会发布。宽泛标签、常见状态、通用类型或相似标题本身不足以建立关系。

生成页面可以包含使用普通相对 Markdown 链接的 `Related` 部分。新增、替换、重命名、移动或删除文档时，受影响的链接和关系文件会一起更新；处理期间不相关的文档仍然可用。

## 可移植文件

关系文件和发现文件通过路径指向 `pages/` 下可读取的 Markdown。

```text
index.md
log.md
pages/
  index.md
  index-directory-leaf-<stable-id>.md
  guides/
    index.md
    index-directory-leaf-<stable-id>.md
    install.md
_index/
  index.md
  index-extension-leaf-<stable-id>.md
  catalog.json
  pages/
    index.md
    index-extension-leaf-<stable-id>.md
    index.json
    all-documents.json
    guides/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      guides-documents.json
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
    guides/
      index.md
      index-extension-leaf-<stable-id>.md
      index.json
      guides-relationships.json
  by-file/
    index.md
    index-extension-leaf-<stable-id>.md
    guides/
      index.md
      index-extension-leaf-<stable-id>.md
      install.json
```

这是一份结构示例。`pages/` 与上传目录一致；`_index/pages/` 和 `_graph/` 的两个分支只镜像适用的 `pages/` 目录。每个非空生成目录都有 `index.md` 和一个或多个稳定导航页。可读文档目录使用 `index-directory-leaf-<stable-id>.md`，`_index/` 和 `_graph/` 目录使用 `index-extension-leaf-<stable-id>.md`。

每个机器可读目录使用 `index.json` 作为路由。文档记录使用 `all-documents.json` 或 `<目录名>-documents.json` 等语义化名称；关系记录使用 `<目录名>-relationships.json`。需要分片时追加 `-part-NNNN`。逐文件关系记录镜像可读页面路径，但去掉 `pages/` 前缀和 `.md` 后缀，例如 `pages/guides/install.md` 对应 `_graph/by-file/guides/install.json`。

系统只生成当前确实存在的目录和数据。只有包含对应文字的词项时才生成该文字类别目录。没有已接受关系时，不生成 `_graph/by-directory/`、`_graph/by-file/` 及其导航页；没有关系的单个文档也不会生成逐文件关系 JSON。

| 资源 | 用途 |
| --- | --- |
| `pages/**/*.md` | 完整可读文档，也是最终引用证据。 |
| `_index/pages/**` | 有界的目录和文档发现记录。 |
| `_index/terms/**` | 有界的多语言导航词项，不是完整全文索引。 |
| `_graph/by-directory/**` | 按可读文档目录分组的关系。 |
| `_graph/by-file/**` | 单个可读文档的有界相邻关系。 |
| `index-*-leaf-<stable-id>.md` | 由同目录 `index.md` 进入的有界 Markdown 导航页。 |

生成的 JSON 使用相对于知识库根目录的文档路径，生成的 Markdown 使用相对链接。可移植文件不会暴露数据库 ID、模型名称、服务 URL、存储键或处理标识。

## 关系字段

关系记录使用面向使用者的文档字段：

| 字段 | 含义 |
| --- | --- |
| `path`、`from`、`to`、`targetPath` | 当前可读取的 `pages/*.md` 路径。 |
| `title`、`fromTitle`、`toTitle`、`targetTitle` | 被连接文档的标题。 |
| `relationType` | 方向性来源证据使用 `references`，已接受的关联使用 `related`。 |
| `direction` | 相对于当前文档的 `outgoing` 或 `incoming`。 |
| `weight` | `0` 到 `1` 之间的关系优先级。 |
| `reason` | 说明文档为何相关的安全解释。 |

## 在线 Agent 读取流程

Agent 通过 Developer OpenAPI 读取时：

1. 使用完整用户问题调用文件搜索。省略 `mode` 即使用 `hybrid`。
2. 把返回条目视为候选。
3. 跟随返回的读取链接，读取完整 Markdown 文件。
4. 证据仍不完整时，使用返回的 `fileId` 调用相关文件接口或图扩展。
5. 读取返回的相关 Markdown 文件后，才能把其内容作为证据。
6. 文件已经覆盖问题，或没有新的有效候选时停止。

图扩展要求一个当前可读取的 `fileId`，不能使用自由文本查询、节点 ID 或边 ID 作为起点。

搜索模式的公开含义如下：

| 模式 | 用途 |
| --- | --- |
| `hybrid` | 推荐的默认模式，组合可用的文件发现和关系发现。 |
| `file` | 侧重正文、标题、路径、元数据和正文嵌入。 |
| `graph` | 侧重文档关系和图关系信号。 |

搜索结果、摘要、分数、关系说明和重排输出只用于导航。提供事实性回答前，应读取返回的 Markdown。

## 静态知识库读取流程

只有复制后的知识库目录或静态 HTTP 服务时：

1. 从 `index.md` 开始。
2. 通过目录索引浏览 `pages/`。
3. 需要补充发现时，只读取 `_index/catalog.json` 声明的页面或词项路径。
4. 沿普通 Markdown 链接或对应的 `_graph/by-file/**` 记录继续。
5. 读取目标 `pages/*.md` 文件，并引用这些文件。

词项索引有明确容量限制。在线全文搜索和混合检索应使用 Developer OpenAPI。

## 文档可用状态

每个上传文档独立索引。同一次上传中的其他文件仍在处理时，已经完成的文档可以先变为可用。

使用公开的 `state` 判断生命周期：

- `waiting`：已经接受，等待开始。
- `processing`：正在索引。
- `available`：当前文档可读取、可搜索。
- `error`：处理以安全错误结束，并可能返回允许的重试操作。
- `deleting`：正在删除。

替换失败时，`generatedOutputStatus=previous_available` 可以让之前的可读内容继续生效。首次上传失败的文件不会出现在文件树、内容、关系或搜索结果中。

大批量导入应从文档给出的默认配置开始。只有在观察管理后台处理状态、外部模型延迟、搜索延迟、CPU 和内存后，再提高并发。
