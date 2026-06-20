---
title: Demo Agent Result
---

# Demo Agent Result

This example shows a third-party Agent using a Focowiki-backed demo service to answer questions from a legal knowledge base.

The demo service keeps the Focowiki OpenAPI key on the backend. The Skill sends HTTP requests to the demo service, searches the configured knowledge base, reads matching files, and uses the retrieved evidence to answer.

## Research Notes

After repeated tuning with real legal documents, Focowiki shows a clear improvement over a traditional RAG-style knowledge base in exploration depth and answer accuracy. The main improvement comes from giving the Agent a file-first knowledge space with indexes, metadata, graph files, related links, and readable source pages. The Agent can inspect the corpus, expand leads, read complete files, compare evidence, and then answer with cited sources.

The current bottleneck has moved from chunking and recombining knowledge to how the Agent organizes its exploration Loop. A shallow Loop usually stops after one or two files and produces a narrow answer. A complete Loop starts from the question, derives search phrases, reads the index and schema, opens relevant files, extracts new leads from the content, searches again, compares multiple sources, and only then closes the answer. When this Loop is well organized, the answer is more precise and more complete.

We started by testing RAG-style search and found that chunk recall often missed document-level context, cross-file relations, update status, and legal structure. Through this exploration, we moved away from a traditional RAG knowledge base. RAG systems often require repeated tuning of embeddings, rerankers, and chunking strategies for different datasets. This made debugging tedious and made it harder to keep the knowledge base stable and explorable. We then moved the core representation to Markdown files, preserved metadata, generated index files, added graph and related-link files, and designed Skills that guide the Agent to explore in cycles. This approach keeps the knowledge base auditable for people and navigable for Agents, and reduces reliance on fixed retrieval fragments to express the whole corpus.

## English Session

![Demo Agent result in English, part 1](/images/demo-agent-en-us-1.png)

![Demo Agent result in English, part 2](/images/demo-agent-en-us-2.png)

## What This Confirms

- The Skill can guide the Agent to search the configured knowledge base before answering.
- The demo service can expose a small read-only HTTP interface for third-party Agent clients.
- The Agent can continue from search results to file reading and then produce an evidence-based answer.
