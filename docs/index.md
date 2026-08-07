---
title: Project Introduction
---

# Focowiki

Focowiki is a lightweight Markdown knowledge-base system for developers and product managers. It accepts cleaned `.md` files, extracts Markdown frontmatter and document signals, generates an OKF-style file knowledge base, stores source and generated files in S3-compatible storage, and exposes knowledge-base workflows through Admin UI, Admin API, and Developer OpenAPI.

Focowiki is useful for teams that already have Markdown knowledge assets and want a small self-hosted service that produces file-based knowledge for people, applications, and agents.

![Focowiki architecture](/images/focowiki-architecture.png)

## What Focowiki Provides

Focowiki takes Markdown files and folders and turns them into a knowledge base that people, applications, and AI agents can explore.

- **Upload documents and folders.** Add individual Markdown files or complete folder trees. Focowiki keeps their paths, names, metadata, links, and content.
- **Browse organized knowledge.** Open documents from a file tree, move or rename files and folders, replace content, and remove outdated material.
- **Find relevant documents.** Search file content, browse directory indexes, follow related documents, and explore relationships through the knowledge graph.
- **Connect applications and AI agents.** Use the Developer OpenAPI to upload content, browse the file tree, read full Markdown files, search, follow graph relationships, and manage document changes.
- **Manage the system from the Admin UI.** Create knowledge bases, monitor file processing, configure models and runtime settings, and manage API keys.
- **Deploy on your own infrastructure.** Run Focowiki with Docker Compose, PostgreSQL, Redis, OpenSearch or Meilisearch, and S3-compatible storage.

## Admin UI Preview

![Focowiki Admin UI knowledge base detail](/images/focowiki-admin-detail.png)

## Open Knowledge Format

[Google's Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/) describes OKF as an open, portable, human-readable, and agent-readable way to represent knowledge with Markdown files and YAML frontmatter.

The [pinned OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md) defines field conventions and a portable directory structure. Focowiki uses the same practical model: Markdown pages, YAML frontmatter, links, indexes, and a stable file tree.

## Markdown Upload Format

Uploads accept `.md` files. Each file can include YAML frontmatter followed by Markdown body content.

```md
---
type: "page"
title: "Customer Support Playbook"
description: "How the support team handles priority customer requests."
resource: "https://example.com/docs/support-playbook"
tags:
  - support
  - operations
timestamp: "2026-06-16T00:00:00Z"
owner: "Support Operations"
sourceSystem: "company-wiki"
---

# Customer Support Playbook

Use this playbook when a priority customer request arrives.

## Intake

Record the customer, request summary, severity, and expected response time.

## Related Documents

- [Escalation rules](./escalation-rules.md)
- [Incident handoff](./incident-handoff.md)
```

Common OKF-style fields:

| Field | Purpose |
| --- | --- |
| `type` | Content kind, such as `page`. |
| `title` | Display title for the generated page. |
| `description` | Short summary for readers and search. |
| `resource` | Source URL or canonical reference when one exists. |
| `tags` | Searchable tags. |
| `timestamp` | Source, publication, or update timestamp. |

Additional safe frontmatter fields can be preserved. Domain-specific fields such as owner, region, product, version, source system, official identifier, status, or category can pass through when they are present in the uploaded Markdown.

Markdown links are the primary relationship mechanism. Links in body content help readers and agents move from one generated page to related pages.

## Product Flow

1. Configure PostgreSQL, Redis, the selected search provider, S3-compatible storage, Admin credentials, bootstrap settings, and service ports.
2. Start Focowiki with Docker Compose or local development commands.
3. Open Admin UI, review runtime settings, and create a knowledge base.
4. Upload one or more cleaned Markdown files.
5. Watch source-file processing until each file ends.
6. Read generated knowledge-base files through Admin UI or Developer OpenAPI.
7. Use Developer OpenAPI keys for application integration and agent-facing backends.

## Next Steps

- [Understand Open Knowledge Format](./guide/open-knowledge-format.md)
- [Understand file-first graph relationships](./guide/file-first-graph.md)
- [Deploy with Docker Compose](./deployment/docker-compose.md)
- [Use Developer OpenAPI](./openapi/index.md)
- [Connect Agents](./agent-integration/index.md)
