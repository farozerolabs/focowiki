---
title: Agent Integration
---

# Agent Integration

Focowiki exposes knowledge-base data through Developer OpenAPI. Agent products usually add an application backend that stores the Focowiki OpenAPI key, selects the knowledge base, and exposes a small read-focused interface for Agent access.

This section explains two integration modes:

| Mode | When to use | Agent access shape |
| --- | --- | --- |
| Own Agent client | You control the Agent runtime and can register built-in tools. | The Agent calls developer-registered tools such as `list_tree`, `read_file`, `get_file`, and `search_files`. |
| Third-party Agent client | The Agent client supports instructions and HTTP access, but cannot register your built-in tools. | The Skill sends HTTP requests to a developer-provided read-only knowledge endpoint. |

## Recommended Architecture

```mermaid
flowchart LR
  OwnAgent["Own Agent client"] --> Tools["Built-in knowledge tools"]
  ThirdParty["Third-party Agent Skill"] --> Endpoint["Read-only knowledge endpoint"]
  Tools --> Backend["Developer backend"]
  Endpoint --> Backend
  Backend --> OpenAPI["Focowiki Developer OpenAPI"]
  OpenAPI --> Bundle["Generated knowledge-base bundle"]
```

The backend is the control point. It stores the Developer OpenAPI base URL and key, maps product users to allowed knowledge bases, and decides which read operations are available to the Agent.

The Agent, Skill, or built-in tool should call only the developer-controlled interface. The Focowiki OpenAPI key stays in the backend.

## What The Backend Uses

The backend usually calls these Focowiki interfaces:

| Purpose | Developer OpenAPI operation |
| --- | --- |
| Resolve available knowledge bases | `listKnowledgeBases` |
| Create and maintain knowledge bases | `createKnowledgeBase`, `deleteKnowledgeBase` |
| Upload Markdown files | `uploadMarkdownFiles` |
| Observe source-file processing | `listKnowledgeBaseSourceFiles`, `getKnowledgeBaseSourceFile`, `listKnowledgeBaseSourceFileEvents`, `retryKnowledgeBaseSourceFile` |
| Read the generated file tree | `listKnowledgeBaseTree` |
| Read file metadata | `getFileById` |
| Read file content by stable identifier | `getFileContentById` |
| Read file content by logical path | `getFileContentByPath` |
| Delete generated files | `deleteFileById`, `deleteFileByPath` |
| Manage webhooks | `listWebhooks`, `createWebhook`, `deleteWebhook`, `listWebhookDeliveries`, `redeliverWebhook` |

These operations are for the developer backend and product workflows. The Agent-facing interface should stay read-focused by default. Expose write or delete capabilities to an Agent only when the product explicitly needs Agent-driven maintenance.

## What The Backend Exposes To The Agent

A minimal Agent-facing backend can expose these operations. In an own Agent client, these are built-in tools. In a third-party Agent client, these are HTTP endpoints on a read-only knowledge base URL.

| Agent-facing operation | Purpose |
| --- | --- |
| `list_tree` | Return paginated generated file entries for one selected knowledge base. |
| `read_file` | Return Markdown content by `fileId` or logical `path`. |
| `get_file` | Return safe metadata for a file. |
| `search_files` | Optional operation backed by your own search layer or by generated index files. |

Keep this interface small. Agents work better when they can discover a file tree, read one file, follow links, and repeat the loop.

## Mode-specific Shape

| Mode | Interface example |
| --- | --- |
| Own Agent client | `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "limit=50"`, `curl -sS "$KNOWLEDGE_BASE_URL/files/{fileId}/content"` |
| Third-party Agent client | `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`, `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=..."` |

## Exploration Flow

1. Start with `index.md` to understand the knowledge base.
2. Read `schema.md` to understand generated file conventions and metadata fields.
3. List the file tree with pagination.
4. Read the most relevant page by `fileId` or `path`.
5. Follow Markdown links and metadata relationships to related files.
6. Avoid fetching every file unless the task explicitly needs a full export.

This keeps requests predictable and limits memory, CPU, and token usage.

## Next Steps

- [Backend Adapter](./backend-adapter.md)
- [Own Agent Client Tools Design](./own-agent-client/tools-design.md)
- [Own Agent Client Skill Design](./own-agent-client/skill-design.md)
- [Third-party Agent Client Skill Design](./third-party-agent-client/skill-design.md)
