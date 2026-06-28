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

执行部署前，准备好服务器、域名、`.env` 文件、外部 S3-compatible storage 和 Docker Compose runtime。启动后，在 [Admin 配置](./admin-settings.md) 中检查 API 限流、Worker、发布、上传生成和可选模型配置。

相关部署指南：

- [Docker Compose 部署](./docker-compose.md)
- [环境变量配置](./environment.md)
- [Admin 配置](./admin-settings.md)
