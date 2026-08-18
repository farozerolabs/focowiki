---
title: Demo Agent Result
---

# Demo Agent Result

This example shows a third-party Agent using a Focowiki-backed demo service to answer questions from a legal knowledge base.

The demo service keeps the Focowiki OpenAPI key on the backend. The Skill sends HTTP requests to the demo service, searches the configured knowledge base, reads matching files, and uses the retrieved evidence to answer.

## Reading The Example

This recording demonstrates one evidence workflow with legal documents as test data. It does not claim a general accuracy comparison or make the knowledge base domain-specific.

The Agent sends the complete question to search, treats returned files as candidates, reads the useful Markdown files, and follows related files only when more evidence is needed. The final answer cites files that were actually read. Search excerpts and relationship summaries help discovery but are not used as answer evidence by themselves.

The same workflow applies to product documentation, manuals, research notes, policies, support content, and other Markdown collections. Answer quality still depends on the uploaded material, the question, the selected model, and the Agent's exploration limits.

## English Session

![Demo Agent result in English, part 1](/images/demo-agent-en-us-1.png)

![Demo Agent result in English, part 2](/images/demo-agent-en-us-2.png)

## What This Confirms

- The Skill can guide the Agent to search the configured knowledge base before answering.
- The demo service can expose a small read-only HTTP interface for third-party Agent clients.
- The Agent can continue from search results to file reading and then produce an evidence-based answer.
- Legal files in this recording are test data; the integration remains general purpose.
