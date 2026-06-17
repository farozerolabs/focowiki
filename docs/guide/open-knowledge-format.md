---
title: Open Knowledge Format
---

# Google OKF And Agent-Readable Knowledge Bases

Google introduced the Open Knowledge Format, or OKF, in 2026 as a specification for representing curated knowledge. Its materials are intentionally simple: Markdown files, YAML frontmatter, standard links, directory indexes, and update logs. That choice looks like documentation engineering, yet it addresses a core question for AI systems: how should knowledge be represented before a model uses it.

Many teams have treated RAG as the default knowledge-base pattern. Documents are split into chunks, chunks are embedded, a user query retrieves a small set of passages, and the model generates an answer from those passages. This works well for support answers, search experiences, and lightweight knowledge lookup. It also creates a clear limit: the model sees the world through retrieval results. Full documents, context structure, update history, and domain relationships often collapse into a few fragments.

OKF points to a different product shape. Knowledge exists first as files. Each file can keep its title, summary, source, tags, timestamp, and domain metadata. An agent can inspect the directory, open a file, follow links, and read a full document when the task requires it. The knowledge base becomes a browsable, auditable, and citable knowledge space.

## References

- [Google Cloud announcement: Introducing the Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [GoogleCloudPlatform knowledge-catalog OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [OpenAI: Introducing ChatGPT](https://openai.com/index/chatgpt/)
- [OpenAI DevDay: GPT-4 Turbo with 128K context and Assistants API](https://openai.com/index/new-models-and-developer-products-announced-at-devday/)
- [Anthropic: Claude 2.1 with 200K context](https://www.anthropic.com/news/claude-2-1)
- [Google: Gemini 1.5 Pro with 1M context preview](https://blog.google/innovation-and-ai/products/google-gemini-next-generation-model-february-2024/)
- [OpenAI: GPT-4.1 with up to 1M context](https://openai.com/index/gpt-4-1/)
- [OpenAI: Introducing GPT-5.5](https://openai.com/index/introducing-gpt-5-5/)
- [OpenAI: Introducing GPT-5.3-Codex](https://openai.com/index/introducing-gpt-5-3-codex/)
- [Anthropic: Claude Opus 4.7](https://www.anthropic.com/news/claude-opus-4-7)
- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)

## Model Progress Changed Knowledge-Base Design

ChatGPT brought large language models into everyday use in 2022 through a conversational interface. The early product pattern was simple: a user asked, the model answered, the user followed up, and the model adjusted within a short dialogue context. Knowledge-base engineering around that period naturally focused on adding a small amount of outside material to the prompt. Short context windows made chunking and retrieval the practical path.

After 2023, model capability moved along two visible tracks. Context windows became longer. OpenAI announced GPT-4 Turbo with 128K context at DevDay. Anthropic released Claude 2.1 with a 200K token context window and described long documents, contracts, financial filings, and codebases as natural use cases. Tool use also became more mature. OpenAI's Assistants API brought code interpreter, retrieval, function calling, and persistent threads into one developer framework. The model experience started moving from a conversational answer engine toward an assistant that can call tools, keep task state, process files, and use external interfaces.

In 2024, Google introduced Gemini 1.5 Pro with a 1M token context preview for developers and enterprise customers, showing long-video, long-audio, large-codebase, and long-document understanding. In 2025, OpenAI introduced GPT-4.1 models with up to 1M tokens of context in the API and improved long-context comprehension. These changes gave knowledge-base design more room. A system can pass larger source materials to the model, and an agent can open complete files step by step when a task calls for it.

This model evolution pushes knowledge bases beyond fragment retrieval. Early RAG was a reasonable response to small context windows and immature tool use. Current models can handle longer material and can explore a file tree through tools. A knowledge base that only exposes top-k chunks can underuse the model's reading capability.

Long context still needs structure. Larger windows increase the value of directories, stable paths, metadata, citations, and update history. An agent needs to know which files exist, what each file represents, how files relate, and which version is trustworthy. OKF-style file conventions provide that layer. As models improve, the knowledge-base task expands from compressing material into a prompt to exposing a readable knowledge space for agents.

By 2026, model progress was no longer only about context length. OpenAI's GPT-5.5 release focused on agentic coding, computer use, knowledge work, and scientific research. The model was described as capable of writing and debugging code, researching online, analyzing data, creating documents and spreadsheets, operating software, and moving across tools until a task is finished. Codex also moved beyond code assistance into a fuller work environment where the model can see the screen, click, type, navigate interfaces, run commands, inspect test results, and continue editing.

Anthropic's Claude Opus 4.7 points in the same direction. Claude Code is now an agent product built around terminals, file systems, codebases, and long-running tasks. The Opus 4.7 release emphasizes long-running workflows, agent-team workflows, computer-use agents, file-system memory, and complex tool coordination. The model is becoming an execution system inside real work environments, not only a suggestion engine inside a chat box.

This product shape changes the role of the knowledge base. A desktop agent needs a material environment it can keep reading and operating on. It opens files, checks directories, searches citations, reads webpages, runs scripts, compares versions, creates new documents, and returns to the knowledge base to verify sources. A knowledge system that only returns a few retrieved fragments interrupts that workflow. A knowledge system with file trees, metadata, stable paths, and links becomes part of the agent's working environment.

OKF-style conventions line up with this 2026 agent direction. Claude Code and Codex show models entering operating systems, development environments, and business workflows. The knowledge base now needs to evolve from a question-answering resource into a knowledge file system that agents can explore and use. RAG remains useful as a search entry point. Complete files and structured directories become the foundation for professional agent work.

## Knowledge Representation Comes First

The original RAG paper treats retrieval as access to external memory. A model can consult an updatable and inspectable knowledge source at inference time, then use the retrieved material while generating. This direction solved important weaknesses of pure model memory, especially freshness and provenance.

In real products, retrieval becomes a gate. The system chooses a small set of fragments before the model reasons over the task. If the retriever misses an important paragraph, ranks a partial passage too highly, cuts through a definition and its exception, or loses a cross-reference, the model receives a distorted view of the source.

Professional knowledge rarely behaves like isolated fragments. Legal text depends on relationships between clauses. Medical guidance depends on populations, contraindications, and evidence levels. Contracts depend on definitions and schedules. Academic papers depend on methods, assumptions, and limitations. Document order, hierarchy, citations, versioning, and tone are part of the knowledge.

OKF gives that structure a file-level representation. A concept maps to a Markdown file. Frontmatter stores structured metadata. Markdown links preserve visible relationships. `index.md` gives a directory-level entry point. `log.md` records changes. Search can still be added, while the corpus remains available as a readable object.

## Why RAG Often Produces Partial Context

RAG gains efficiency through selection. A large corpus cannot enter the model context in full, so the system uses embeddings, keyword matching, reranking, or hybrid retrieval to choose likely relevant passages. This selection turns the corpus into a query-dependent view.

Different wording can produce different results. Domain terminology may not match the user's query. A correct answer may require several distant passages, while top-k retrieval covers only one of them. A professional conclusion may depend on a definition, an exception, and an update note, while the retrieved passage contains only the definition.

Users often believe that an uploaded document has been read by the AI system. In many RAG pipelines, the model receives only selected chunks from that document. The answer may be grounded in retrieved text and still miss the meaning of the whole document.

Chunking deepens the problem. A chunking strategy usually optimizes for token size, headings, or fixed windows. It serves indexing efficiency, but professional documents have their own structure. Legal definitions and exceptions can land in separate chunks. Medical indications and contraindications can separate. An article's opening, transition, and conclusion can scatter across multiple chunks. Local text survives, while document-level organization changes.

This explains why RAG needs extensive benchmarking. Teams evaluate recall, ranking quality, citation accuracy, faithfulness, and end-to-end success. The knowledge base is exposed indirectly through retrieval behavior, so the central question becomes whether the right query retrieves the right fragments.

File-based knowledge moves part of that evaluation upstream. The corpus is inspectable before retrieval. The agent's ability to read, navigate, follow links, and manage context becomes a primary evaluation target. Retrieval can remain useful, but top-k recall no longer carries the entire burden of knowledge exposure.

## What A File Specification Gives Agents

An agent uses knowledge more like a research assistant than a search box. It can check a table of contents, open a candidate source, record evidence, compare related files, and follow citations. A file-based knowledge base gives the agent that path.

`index.md` provides a gradual entry point. The agent can first see what exists in a directory, then decide which file to open. Frontmatter provides type, title, description, source, tags, and timestamp. Markdown links expose relationship paths. A regulation can link to an interpretation, a metric can link to its source table, and a runbook can link to a rollback guide.

Full files also change the context unit. The agent can read the complete source when needed. Long-context models can receive the whole document. Smaller-context models can still read in parts, with segmentation driven by the agent's task and the document structure rather than by a fixed offline chunking policy.

Search remains useful as an entry point. It can help the agent find candidate files in a large bundle. After search, the agent can return to the complete file and its link graph.

## Professional Scenarios

### Law And Regulation

Legal work often requires a full reading of the source. A question may depend on definitions, scope, exceptions, effective dates, amendment status, and related rules. RAG can retrieve a clause with the apparent answer while missing the exception that changes the conclusion.

An OKF-style legal bundle can represent statutes, interpretations, guidance, and related documents as files. The agent can read the full text, inspect metadata such as issuer and effective date, follow related links, and cite stable file paths.

### Medical And Clinical Knowledge

Medical information is highly context-sensitive. Age, pregnancy, comorbidities, dosage, contraindications, evidence level, and update time can all change the answer. A local paragraph may be correct for one patient group and unsafe for another.

A file-based bundle is better suited to complete guidelines, clinical pathways, drug labels, evidence notes, and citations. Human oversight remains essential in clinical settings, and the knowledge layer should preserve source structure and traceability.

### Policy, Compliance, And Audit

Compliance answers usually need proof. A reviewer needs the policy source, control, version, scope, exception path, and evidence record. One retrieved paragraph rarely gives enough audit context.

Files can represent policies, controls, evidence notes, and logs. The agent can read across that structure and produce answers with paths that reviewers can inspect.

### Contract Review

Contracts contain dense dependencies. A liability clause may rely on definitions, exclusions, governing law, schedules, and service levels. Chunk-level retrieval can miss that dependency chain.

With files, the agent can read the contract as a document, inspect schedules, compare templates, and preserve the legal structure during review.

### Academic Research

Research work depends on full argument structure. Abstracts, methods, experiments, results, limitations, and citations support each other. A few semantically similar chunks may help locate a topic, while a serious literature review requires broader reading.

An OKF-style corpus can organize papers, notes, experiment records, and citation relationships as linked concepts. The agent can compare assumptions and methods before drafting a review.

### Writing Imitation And Style Transfer

Writing imitation often fails with pure retrieval. Style lives in article-level structure, rhythm, paragraph length, transitions, examples, and endings. Retrieved chunks expose local phrases, but they rarely expose the macro pattern.

When full articles are available as files, the agent can study structure before drafting. It can observe how the source opens, develops evidence, shifts sections, and closes.

### Data Catalogs And Metric Knowledge

Data teams need definitions, lineage, joins, schemas, dashboard usage, and business meaning. A metric definition may depend on source tables, filters, caveats, and deprecation notes.

OKF is closely aligned with this data-context problem. Tables, metrics, runbooks, dashboards, and citations can become linked Markdown concepts. The agent can follow the graph from a metric to its sources and caveats.

### Engineering Runbooks

Operational procedures depend on order. A step may require previous checks, current status, monitoring results, or rollback conditions. Retrieval can surface one step without the flow around it.

A runbook file gives the agent the full procedure. Links can connect service docs, dashboards, rollback guides, and postmortems.

## Benchmarking Moves Toward Agent Workflow

RAG evaluation often centers on the retrieval pipeline. Teams validate chunking, embeddings, reranking, query rewriting, and answer faithfulness. The knowledge base's behavior is tied to retrieval behavior.

File-based knowledge changes the evaluation target. The corpus should have clear structure, complete metadata, valid links, reliable citations, and traceable updates. The agent workflow should show that it can find the right directory, open relevant files, decide when a full document is needed, follow links, cite stable paths, and express uncertainty when evidence is absent.

This form of evaluation resembles real knowledge work. A researcher answering a professional question does not judge only the top search results. The researcher also asks whether the key materials were read, whether important citations were missed, and whether the document context was understood.

## How Focowiki Applies This Direction

Focowiki organizes knowledge around this file-based model. Markdown is the input. Safe frontmatter fields are parsed and preserved. The generated bundle includes `index.md`, `log.md`, `schema.md`, Markdown pages, and JSON indexes for tree, search, manifest, and links. Source and generated files live in S3-compatible storage. PostgreSQL and Redis coordinate knowledge bases, upload tasks, files, releases, cursors, and API keys.

The system first keeps knowledge readable, auditable, and linkable. Developer OpenAPI then exposes that corpus to external systems and agents. Search can act as an entry point, while the generated files remain the canonical knowledge object. Developers can integrate it through their own backend or let agents read file trees, file content, task state, and webhook events through APIs.

Focowiki does not need to replace every RAG system. A stronger architecture uses file-based knowledge as the source layer and RAG as an optional access layer. When semantic recall is useful, vectors can be built from the OKF-style bundle. When full reading, audit, and citation matter, the agent returns to the files.

## Choosing The Right Pattern

OKF-style file knowledge is a better foundation for tasks that depend on full-document understanding, strong citations, domain metadata, cross-document relationships, human review, or agent-led exploration. Law, medicine, policy, compliance, contracts, academic research, editorial work, and engineering runbooks are typical high-context domains.

RAG remains effective for fast semantic recall across large corpora, especially when answers usually depend on a few passages. Support QA, document search, lightweight knowledge lookup, and recommendation workflows can continue to benefit from retrieval augmentation.

The long-term architecture can combine both patterns. Start with a readable, governable, versioned source layer. Add search, vectors, agent tools, and interfaces according to product needs. OKF provides that source format, and Focowiki turns Markdown knowledge into a file-based corpus that people, applications, and agents can share.
