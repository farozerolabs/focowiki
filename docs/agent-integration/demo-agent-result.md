---
title: Demo Agent Result
---

# Demo Agent Result

This example shows a third-party Agent using a Focowiki-backed demo service to answer questions from a legal knowledge base.

The demo service keeps the Focowiki OpenAPI key on the backend. The Skill sends HTTP requests to the demo service, searches the configured knowledge base, reads matching files, and uses the retrieved evidence to answer.

## English Session

![Demo Agent result in English, part 1](/images/demo-agent-en-us-1.png)

![Demo Agent result in English, part 2](/images/demo-agent-en-us-2.png)

## What This Confirms

- The Skill can guide the Agent to search the configured knowledge base before answering.
- The demo service can expose a small read-only HTTP interface for third-party Agent clients.
- The Agent can continue from search results to file reading and then produce an evidence-based answer.

