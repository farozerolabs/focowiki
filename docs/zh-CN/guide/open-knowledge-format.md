---
title: Google OKF 规范
---

# Google OKF 规范与 Agent 可读知识库

Open Knowledge Format，简称 OKF，是 Google 在 2026 年公开提出的一套知识表示规范。它选择了非常朴素的材料：Markdown 文件、YAML frontmatter、普通链接、目录索引和更新日志。这些材料看起来像文档工程，实际触及的是 AI 系统使用知识的基础问题。

过去几年里，很多团队把 RAG 当成知识库的默认方案。文档被切成片段，片段被向量化，用户提问时系统召回若干片段，再交给模型生成回答。RAG 适合客服问答、常识补充、资料检索等场景，也推动了很多 AI 应用落地。局限也很明显：模型实际看到的内容由召回结果决定，完整文档、上下文关系、更新历史和领域结构经常被压缩成几个片段。

OKF 代表了另一种知识库思路。知识先以文件形式存在，每个文件保留标题、摘要、来源、标签、时间和领域元数据。Agent 可以查看目录，打开文件，沿链接继续阅读，在需要时读取整篇文档。知识库从一个检索黑盒变成一个可浏览、可审计、可引用的知识空间。

## 官方与研究参考

- [Google Cloud 公告：Introducing the Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [GoogleCloudPlatform knowledge-catalog OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [OpenAI：Introducing ChatGPT](https://openai.com/index/chatgpt/)
- [OpenAI DevDay：GPT-4 Turbo with 128K context and Assistants API](https://openai.com/index/new-models-and-developer-products-announced-at-devday/)
- [Anthropic：Claude 2.1 with 200K context](https://www.anthropic.com/news/claude-2-1)
- [Google：Gemini 1.5 Pro with 1M context preview](https://blog.google/innovation-and-ai/products/google-gemini-next-generation-model-february-2024/)
- [OpenAI：GPT-4.1 with up to 1M context](https://openai.com/index/gpt-4-1/)
- [OpenAI：Introducing GPT-5.5](https://openai.com/index/introducing-gpt-5-5/)
- [OpenAI：Introducing GPT-5.3-Codex](https://openai.com/index/introducing-gpt-5-3-codex/)
- [Anthropic：Claude Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7)
- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)

## 模型变迁推动知识库形态变化

ChatGPT 在 2022 年把大模型带入普通用户视野。它的核心体验是对话：用户提出问题，模型回答，用户继续追问，模型在短对话上下文里调整回答。这一阶段的知识库设计仍然围绕“给模型补一点外部资料”展开。模型上下文较短，工程上自然会把文档切成片段，通过检索把少量内容送进 prompt。

2023 年以后，模型能力开始沿着两个方向变化。一个方向是上下文窗口变长。OpenAI 在 DevDay 发布 GPT-4 Turbo，提供 128K context；Anthropic 随后发布 Claude 2.1，提供 200K token context，并把长文档、合同、财报、代码库作为典型使用场景。另一个方向是工具使用能力成熟。OpenAI 同期推出 Assistants API，把 code interpreter、retrieval、function calling 和 persistent threads 放到同一个开发框架里。模型从“回答一句话”的系统，逐渐变成能调用工具、保留任务状态、处理文件和外部接口的 assistant。

2024 年，Google 发布 Gemini 1.5 Pro，把 1M token context 放入开发者和企业预览，并展示长视频、长音频、大型代码库和长文档理解能力。2025 年，OpenAI 发布 GPT-4.1 系列，API 中同样提供最高 1M token context，并强调 long-context comprehension。上下文长度的提升让知识库设计出现新的空间：系统可以把更多原始材料直接交给模型，也可以让 Agent 分步骤打开完整文件。

这些变化反过来推动知识库从“片段召回”走向“结构化暴露”。早期 RAG 的合理性来自较小的模型窗口、有限的单次阅读材料和不成熟的工具调用能力。今天的模型可以处理更长材料，也可以通过工具主动探索文件树、打开文档、读取链接、比较多个来源。知识库继续只暴露 top-k chunks，会限制模型已经具备的阅读能力。

长上下文没有消除知识组织需求。上下文越长，越需要清晰的目录、稳定路径、metadata、引用和更新记录。Agent 需要知道有哪些文件、每个文件是什么、哪些文件相关、哪个版本可信。OKF-style 文件规范正好提供这层结构。模型能力提升以后，知识库的关键任务从“压缩材料给模型”扩展为“把可读知识空间交给 Agent”。

2026 年的模型变化已经不止停留在上下文长度。OpenAI 的 GPT-5.5 发布说明把重点放在 agentic coding、computer use、knowledge work 和 scientific research 上。官方描述里，模型可以写代码、调试、在线研究、分析数据、生成文档和表格、操作软件，并在多个工具之间移动，直到任务完成。Codex 也从代码助手走向更完整的工作环境：模型能看屏幕、点击、输入、浏览界面、运行命令、检查测试结果和继续修改。

Anthropic 的 Claude Opus 4.7 也显示了同样方向。Claude Code 已经成为围绕终端、文件系统、代码库和长期任务运转的 Agent 产品。Opus 4.7 的发布信息强调 long-running workflows、agent-team workflows、computer-use agents、文件系统记忆和复杂工具链协作。模型开始在真实工作环境中承担持续执行，聊天框里的建议只是一部分能力。

这种产品形态会改变知识库的角色。桌面型 Agent 需要可以持续读取和操作的资料环境。它会打开文件，查目录，搜索引用，读取网页，运行脚本，比较版本，生成新文档，再回到知识库确认来源。知识系统如果只提供几个召回片段，Agent 的工作路径会被截断。知识系统提供文件树、metadata、稳定路径和链接关系时，Agent 可以把知识当成工作环境的一部分。

OKF-style 规范与 2026 年 Agent 产品方向相互呼应。Claude Code 和 Codex 证明了模型正在进入操作系统、开发环境和业务流程。知识库也需要从“回答问题的资料库”升级为“Agent 可以探索和使用的知识文件系统”。RAG 仍然适合搜索入口，完整文件和结构化目录会成为 Agent 完成专业任务的基础。

## 知识库首先是知识表示问题

RAG 原始论文把 retrieval 看作外部记忆。模型在推理时访问一个可更新、可检查的知识源，用召回内容补充自身参数里的知识。这一方向解决了纯模型记忆难更新、难追溯的问题。

真正部署到产品里以后，retrieval 会成为新的边界。系统需要在模型推理前选出若干片段。选择一旦出错，模型后续推理再强，也只能基于残缺的材料继续生成。检索漏掉关键段落、排序偏向局部信息、chunk 边界切断定义与例外、交叉引用没有进入上下文，都会让回答看起来合理但结论不完整。

专业知识往往不按片段工作。法律文本要看条文之间的关系，医学指南要看适用人群和禁忌条件，合同要看定义和附件，学术论文要看方法、假设和限制。文档的顺序、层级、引用、版本和语气本身就是知识的一部分。把这些结构提前切碎，再期待召回系统完整还原，天然会产生信息损耗。

OKF 的价值在这里出现。它把知识先保存为可以被人和 Agent 共同读取的文件。一个 concept 对应一个 Markdown 文件，结构化信息放在 frontmatter，文档关系通过 Markdown links 呈现，`index.md` 提供目录式浏览，`log.md` 记录变更。检索可以继续存在，知识暴露责任不需要全部压在检索链路上。

## RAG 为什么容易给出片面信息

RAG 的优势来自筛选。大语料无法全部进入模型上下文，系统通过 embedding、关键词匹配、rerank 或混合检索，把看似相关的内容取出来。筛选提高了效率，也把知识库变成了 query-dependent 的视图。

用户换一种问法，召回结果可能变化。文档中关键内容使用了不同术语，召回结果可能偏离。答案依赖多个远距离段落，top-k 可能只覆盖其中一部分。专业结论依赖定义、例外和更新记录，召回片段可能只命中定义，漏掉例外和更新。

这类失败很容易被误解。用户上传了一整篇文档，心理预期是 AI 已经“读过这篇文档”。系统实际交给模型的可能只有几个片段。模型在有限片段上生成的回答并非无源之水，却仍然可能脱离整篇文档的真实含义。

Chunking 进一步放大了这个问题。切分策略通常围绕 token 长度、标题层级或固定窗口设计。它服务于索引效率，却未必尊重专业文本结构。法律条文中的定义和例外可能被切到不同片段；医学指南中的适应证和禁忌证可能分离；文章风格中的开头、转折和结尾可能散落在多个 chunk 里。局部片段保留了文字，整体文档的组织关系已经改变。

因此，RAG 需要大量 benchmark。团队要测召回率、排序质量、引用准确性、答案忠实度和端到端成功率。这些评估工作很必要，原因在于知识库通过检索行为间接暴露。评估的核心问题是系统能不能在某个 query 下召回正确片段。

文件化知识库把评估重心前移。知识本身先以可检查的形式存在，Agent 能读取多少、怎样读取、是否沿着链接继续探索，更多取决于 Agent 的工具使用能力和模型的长上下文能力。知识库仍然需要质量检查，top-k 召回无需承担全部正确性压力。

## 文件规范给 Agent 带来的变化

Agent 使用知识的方式接近一个研究助理。它会先了解目录，再打开相关材料，记录证据，比较相邻文件，在必要时继续追溯来源。文件化知识库给了 Agent 这样的工作路径。

`index.md` 提供渐进式阅读入口。Agent 可以先看一个目录下有哪些文件，再判断下一步打开哪一个。Frontmatter 提供类型、标题、摘要、来源、标签和时间，帮助 Agent 过滤和排序。Markdown links 给出显式关系，Agent 可以从一篇法规跳到解释文件，从一个指标跳到源表，从一个 runbook 跳到回滚指南。

Focowiki 还会在 `_graph/` 下发布文件优先图关系。source-backed pages 可以包含稳定的 `fileId` 和指向 `_graph/by-file/{fileId}.json` 的 `graph` 引用。Agent 可以从一个完整 Markdown 页面进入有界的相关页面列表，无需读取整个 corpus，也无需依赖内部图数据库。

完整文件也改变了上下文粒度。Agent 可以读取整篇材料，理解结构后再回答。对于长上下文模型，它可以把完整文档放入上下文。对于上下文较小的模型，它也可以分段读取，分段动作由 Agent 围绕文件结构执行，避免完全依赖离线 chunking 预先决定。

文件模式可以保留搜索能力。搜索适合作为入口，用于在大量文件中找到候选材料。搜索结果之后仍然可以回到完整文件和链接图谱。Agent 不必停留在片段层面。

## 适合 OKF-style 规范的专业场景

### 法律与监管

法律材料经常需要整篇阅读。一个问题可能涉及定义条款、适用范围、例外情况、生效日期、修订状态和相关法规。RAG 可以召回包含关键词的条文，但漏掉例外条款时，回答会出现方向性错误。

OKF-style bundle 可以把每部法规、解释、指南和相关材料表示成文件。Agent 读取法规正文时可以同时看到 metadata、更新日志和相关链接。最终答案可以引用稳定路径，评审人员也能回到原文件检查。

### 医学与临床知识

医学信息高度依赖适用条件。年龄、妊娠状态、合并症、剂量、禁忌证、证据等级和更新时间都会影响结论。一个局部段落在某个场景下正确，在另一个场景下可能带来风险。

文件化知识库更适合保存完整指南、临床路径、药品说明和证据引用。Agent 可以先阅读完整材料，再结合问题判断哪些条件相关。临床场景仍然需要专业人员审核，知识层本身应该尽量保持完整和可追溯。

### 政策、合规与审计

合规答案通常需要证明来源。只给出一句被召回文本，审计人员很难判断版本、适用范围、例外路径和证据链。政策文件、控制项、审计记录和更新日志更适合以文件形式保存。

Agent 在文件结构下可以沿着 policy、control、evidence 和 log 逐步读取。回答中的引用可以落到具体文件和路径，便于复核。

### 合同审查

合同条款之间存在大量依赖。责任限制可能依赖定义、服务范围、附件、违约条款和适用法律。把合同切成 chunks 后，某个条款看起来完整，实际结论仍然需要其他部分支持。

文件模式让 Agent 先读合同整体，再沿链接检查附件和模板。合同审查更关注结构关系，文件表示天然更贴近合同审查流程。

### 学术研究与文献综述

论文阅读依赖完整论证。摘要、方法、实验设置、结果、限制和引用之间互相支撑。少量相似片段可以帮助找到主题，难以支持严肃综述。

OKF-style corpus 可以把论文、笔记、实验记录和引用关系组织起来。Agent 可以按研究问题打开多篇材料，比较假设和方法，再生成综述或研究备忘录。

### 文章仿写与风格迁移

文章仿写很难依靠 RAG 完成。风格不只存在于几个高相似句子里，也存在于整篇文章的结构、节奏、段落长度、转折方式、例子安排和收束方式里。

如果 Agent 只能拿到局部片段，它通常只能模仿局部措辞。完整文章作为文件提供后，Agent 可以先观察文章结构，再抽取写作模式，最后根据新主题生成更接近原文风格的内容。

### 数据目录与指标知识

数据团队经常需要解释表、字段、指标、血缘、join path 和业务口径。一个指标定义可能依赖源表、过滤条件、使用场景和废弃说明。孤立片段容易给出表面解释。

OKF 与数据目录天然接近。表、指标、runbook、dashboard 和引用资料可以形成 linked concepts。Agent 可以沿指标找到源表和相关说明，减少对相似片段的单点依赖。

### 工程 Runbook

运维步骤讲究顺序。某一步是否执行，取决于前置检查、当前状态、监控结果和回滚路径。RAG 可能召回某个步骤，却缺少整个流程。

Runbook 以文件形式存在时，Agent 能看到完整流程，并通过 links 打开服务文档、监控面板说明、回滚指南和事故复盘。

## Benchmark 回到模型和 Agent 工作流

RAG 时代的知识库评估重点经常落在 retrieval pipeline。系统要证明 chunking 合理、embedding 有效、rerank 正确、query rewriting 有帮助。知识库的表现与检索链路绑定在一起。

文件规范带来了不同的评估对象。知识库需要证明文件结构清晰、metadata 完整、链接可用、引用可信、更新日志可追溯。Agent 工作流则需要证明它会使用这些文件：能找到正确目录，能打开相关文件，能判断是否需要阅读全文，能沿链接继续探索，能在证据不足时表达不确定。

这样的 benchmark 更接近真实知识工作。研究者回答专业问题时，除了检查某个搜索引擎的 top-k 结果，也会评估自己是否读到了关键材料、是否漏掉重要引用、是否理解了文档上下文。文件化知识库把这套工作方式交给 Agent。

## Focowiki 的落点

Focowiki 采用文件化知识库思路来组织产品能力。输入保持为 Markdown，frontmatter 中的安全字段会被解析和保留。系统生成 `index.md`、`log.md`、`schema.md`、Markdown pages、tree、search、manifest、links 等 JSON indexes，以及 `_graph/` 关系文件。源文件和生成文件保存到 S3-compatible storage。PostgreSQL 与 Redis 负责知识库、来源文件处理记录、graph nodes、graph edges、文件、发布、游标和 API keys 等持久化流程。

Focowiki 的设计先保证知识可读、可审计、可链接，再通过 Developer OpenAPI 暴露给开发者系统和 Agent。搜索能力可以作为入口存在，生成文件本身保留为 canonical knowledge object。开发者可以把它接入自己的后端，也可以让 Agent 通过接口读取文件树、文件内容、图关系文件、来源文件处理状态和 webhook 事件。

Focowiki 的目标并不在于替代所有 RAG 系统。更合理的产品架构是把文件化知识作为 source layer，把 RAG 作为可选 access layer。需要语义召回时，可以从 OKF-style bundle 构建向量索引；需要完整阅读、审计和引用时，Agent 回到文件本身。

## 选择建议

当任务依赖整篇文档、强引用、领域 metadata、跨文档关系、人工审阅或 Agent 主动探索时，OKF-style 文件知识库更适合成为基础设施。法律、医学、政策、合规、合同、学术、文章仿写和工程 runbook 都属于这类高上下文场景。

当任务主要是从大量资料中快速找到若干相关片段，并且答案通常可以由这些片段支撑时，RAG 仍然是有效方案。客服问答、知识搜索、资料推荐和轻量问答都可以继续使用检索增强。

更稳妥的长期架构，是先建立可读、可治理、可版本化的知识源，再根据产品需要增加搜索、向量召回、Agent 工具和界面。OKF 提供了这样的 source format。Focowiki 围绕这一方向，把 Markdown 知识转换成可以被人、应用和 Agent 共同使用的文件化知识库。
