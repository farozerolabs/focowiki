---
title: Demo 运行测试结果示例
---

# Demo 运行测试结果示例

这个示例展示第三方 Agent 通过 Focowiki demo 服务读取法律知识库，并基于知识库内容回答问题。

Demo 服务把 Focowiki OpenAPI key 保存在后端。Skill 通过 HTTP 请求访问 demo 服务，搜索已配置的知识库，读取命中的文件，并基于读取到的证据生成回答。

## 中文会话

![Demo Agent 中文运行结果，第 1 部分](/images/demo-agent-zh-cn-1.png)

![Demo Agent 中文运行结果，第 2 部分](/images/demo-agent-zh-cn-2.png)

## 这个示例说明什么

- Skill 可以引导 Agent 在回答前先查询配置好的知识库。
- Demo 服务可以为第三方 Agent 客户端提供一个小型只读 HTTP 接口。
- Agent 可以从搜索结果继续读取文件，并基于证据生成回答。
