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

Before running the deployment, prepare the server, domain names, `.env` file, external S3-compatible storage, model configuration, and Docker Compose runtime.

Related deployment guide:

- [Docker Compose Deployment](./docker-compose.md)
