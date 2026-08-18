---
title: Agent-assisted Deployment
---

# Agent-assisted Deployment

If you use Codex, Claude Code, or a similar coding Agent, you can ask the Agent to read the repository and help deploy Focowiki with Docker Compose.

Recommended prompt:

```text
Review the farozerolabs/focowiki repository:
https://github.com/farozerolabs/focowiki

Read README.md and help me deploy Focowiki with Docker Compose.
```

Before running the deployment, prepare the server, domain names, `.env` file, external S3-compatible storage, Docker Engine, and Docker Compose. After startup, review document processing, generated knowledge-base, maintenance, search, graph, and optional model settings in [Admin Settings](./admin-settings.md).

Related deployment guide:

- [Docker Compose Deployment](./docker-compose.md)
- [Environment Configuration](./environment.md)
- [Admin Settings](./admin-settings.md)
