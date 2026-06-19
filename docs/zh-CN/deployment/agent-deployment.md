---
title: 使用 Agent 部署
---

# 使用 Agent 部署

如果使用 Codex、Claude Code 或类似的 coding Agent，可以让 Agent 阅读仓库并协助使用 Docker Compose 部署 Focowiki。

推荐提示词：

```text
查看 farozerolabs/focowiki 仓库：
https://github.com/farozerolabs/focowiki

阅读 README.md，帮我使用 Docker Compose 部署 Focowiki。
```

执行部署前，准备好服务器、域名、`.env` 文件、外部 S3-compatible storage、模型配置和 Docker Compose runtime。

相关部署指南：

- [Docker Compose 部署](./docker-compose.md)
