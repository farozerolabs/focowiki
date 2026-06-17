# Focowiki

[中文](./README.zh-CN.md) | English

Focowiki is an open-source Markdown knowledge-base platform for developers and product managers. It accepts cleaned `.md` files, generates an OKF-style knowledge bundle, stores source and generated files in S3-compatible storage, and provides an Admin UI for managing knowledge bases.

The project is designed for teams that want a small self-hosted system for file-based knowledge. Generated bundles can be read by people, applications, and agents through documented product interfaces.

![Focowiki architecture](./docs/public/images/focowiki-architecture.png)

## Documentation

Full documentation is available at [docs.focowiki.com](https://docs.focowiki.com).

Use the documentation for:

- [Project introduction](https://docs.focowiki.com/)
- [Docker Compose deployment](https://docs.focowiki.com/deployment/docker-compose)
- [Developer OpenAPI](https://docs.focowiki.com/openapi/)
- [Agent integration](https://docs.focowiki.com/agent-integration/)
- [Open Knowledge Format guide](https://docs.focowiki.com/guide/open-knowledge-format)

## Project Origin

Focowiki is inspired by Google's Open Knowledge Format work.

[Google's Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/) describes a portable way to represent knowledge as Markdown files with YAML frontmatter. The [OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) defines conventions for metadata, Markdown pages, links, indexes, and update logs.

Focowiki uses this model as a practical product direction. Uploaded Markdown files become an OKF-style public bundle with stable Markdown pages, metadata, links, indexes, and a file tree that can be browsed from the Admin UI and consumed through the documented Developer OpenAPI.

## What Focowiki Provides

- Markdown-only upload workflow for `.md` files.
- YAML frontmatter and Markdown structure extraction.
- OKF-style generated bundle with `index.md`, `log.md`, `schema.md`, `pages/*.md`, and `_index/*.json`.
- PostgreSQL-backed records for knowledge bases, tasks, releases, files, and API keys.
- Redis-backed coordination for sessions, cursors, rate limits, and task state refresh.
- S3-compatible storage for uploaded source files and generated bundle files.
- Admin UI for login, knowledge-base management, uploads, file-tree browsing, task observation, and OpenAPI key management.
- Developer OpenAPI for backend integration. See the [Developer OpenAPI documentation](https://docs.focowiki.com/openapi/).

## Admin UI Preview

![Focowiki Admin UI knowledge base detail](./docs/public/images/focowiki-admin-detail.png)

## Markdown Input

Uploads currently accept `.md` files only. A Markdown file can include YAML frontmatter followed by Markdown body content.

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
---

# Customer Support Playbook

Use this playbook when a priority customer request arrives.
```

Additional safe frontmatter fields can be preserved as pass-through metadata. Detailed input guidance is documented in the [project introduction](https://docs.focowiki.com/).

## Docker Compose Deployment

The repository ships Docker Compose templates. Production deployment uses the published GitHub Container Registry images and your own PostgreSQL, Redis, and S3-compatible storage configuration.

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

Default production images:

- `ghcr.io/farozerolabs/focowiki-api:latest`
- `ghcr.io/farozerolabs/focowiki-admin:latest`

The Docker Compose template uses `latest` by default. To pin a release, set the image tag directly in `.env`:

```env
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.1.0
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.1.0
```

Production deployment requires:

- PostgreSQL for product records, tasks, releases, generated file records, API key records, and audit evidence.
- Redis for sessions, rate limits, cursors, coordination, locks, and short-lived task refresh state.
- External S3-compatible storage for uploaded source files and generated public bundles.
- HTTPS public origins for Admin UI, Admin API, and Developer OpenAPI behind your reverse proxy.

Docker Compose reads the root `.env` file by default. Keep real `docker-compose.yml`, `.env`, credentials, local paths, S3 keys, model keys, session secrets, and raw Markdown data out of git.

For configuration details and operating commands, read the [Docker Compose deployment guide](https://docs.focowiki.com/deployment/docker-compose).

## Local Development

Focowiki uses pnpm, TypeScript, Vite, React, Hono, PostgreSQL, Redis, and S3-compatible storage.

```bash
pnpm install
cp .env.dev.example .env
cp docker-compose.local.yml.example docker-compose.local.yml
docker compose -f docker-compose.local.yml up -d postgres redis
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

Local service URLs:

- Admin UI: `http://127.0.0.1:43100`
- Admin API: `http://127.0.0.1:43000`
- Developer OpenAPI: `http://127.0.0.1:43200`

Real upload parsing requires S3-compatible storage settings in `.env`.

## License

Focowiki is distributed under a modified Apache License 2.0. See [LICENSE](./LICENSE).

## References

- [Open Knowledge Format announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [Focowiki documentation](https://docs.focowiki.com)
