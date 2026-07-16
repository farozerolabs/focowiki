import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type DefaultTheme } from "vitepress";

const configDir = path.dirname(fileURLToPath(import.meta.url));

function readOpenApiSidebar(locale: "root" | "zh-CN"): DefaultTheme.SidebarItem[] {
  const filename = locale === "root" ? "openapi-sidebar.json" : "openapi-sidebar.zh-CN.json";
  const sidebarPath = path.join(configDir, "generated", filename);
  if (!fs.existsSync(sidebarPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(sidebarPath, "utf8")) as DefaultTheme.SidebarItem[];
}

const sharedThemeConfig: DefaultTheme.Config = {
  logo: "/logo.svg",
  search: {
    provider: "local",
    options: {
      locales: {
        "zh-CN": {
          translations: {
            button: {
              buttonText: "搜索",
              buttonAriaLabel: "搜索"
            },
            modal: {
              displayDetails: "显示详情",
              resetButtonTitle: "重置搜索",
              backButtonTitle: "关闭搜索",
              noResultsText: "没有结果",
              footer: {
                selectText: "选择",
                navigateText: "切换",
                closeText: "关闭"
              }
            }
          }
        }
      }
    }
  },
  socialLinks: [{ icon: "github", link: "https://github.com/farozerolabs/focowiki" }]
};

function englishThemeConfig(): DefaultTheme.Config {
  return {
    ...sharedThemeConfig,
    nav: [
      { text: "Guide", link: "/" },
      { text: "Deploy", link: "/deployment/docker-compose" },
      { text: "OpenAPI", link: "/openapi/" },
      { text: "Agent Integration", link: "/agent-integration/" }
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Project Introduction", link: "/" },
          { text: "Open Knowledge Format", link: "/guide/open-knowledge-format" },
          { text: "File-first Graph", link: "/guide/file-first-graph" },
          { text: "Resource Management", link: "/guide/resource-management" },
          { text: "File Cleaning and Ingestion Guide", link: "/guide/file-cleaning-ingestion" }
        ]
      },
      {
        text: "Deployment",
        items: [
          { text: "Docker Compose", link: "/deployment/docker-compose" },
          { text: "Environment Configuration", link: "/deployment/environment" },
          { text: "Admin Settings", link: "/deployment/admin-settings" },
          { text: "Agent-assisted Deployment", link: "/deployment/agent-deployment" }
        ]
      },
      {
        text: "Developer OpenAPI",
        items: [{ text: "Overview", link: "/openapi/" }, ...readOpenApiSidebar("root")]
      },
      {
        text: "Agent Integration",
        items: [
          { text: "Overview", link: "/agent-integration/" },
          { text: "Backend Adapter", link: "/agent-integration/backend-adapter" },
          {
            text: "Own Agent Client Integration",
            collapsed: true,
            items: [
              { text: "Tools Design", link: "/agent-integration/own-agent-client/tools-design" },
              { text: "Skill Design", link: "/agent-integration/own-agent-client/skill-design" }
            ]
          },
          {
            text: "Third-party Agent Client Integration",
            collapsed: true,
            items: [
              { text: "Skill Design", link: "/agent-integration/third-party-agent-client/skill-design" }
            ]
          },
          { text: "Demo Agent Result", link: "/agent-integration/demo-agent-result" }
        ]
      }
    ]
  };
}

function chineseThemeConfig(): DefaultTheme.Config {
  return {
    ...sharedThemeConfig,
    nav: [
      { text: "指南", link: "/zh-CN/" },
      { text: "部署", link: "/zh-CN/deployment/docker-compose" },
      { text: "OpenAPI", link: "/zh-CN/openapi/" },
      { text: "Agent 接入", link: "/zh-CN/agent-integration/" }
    ],
    sidebar: [
      {
        text: "指南",
        items: [
          { text: "项目介绍", link: "/zh-CN/" },
          { text: "Google OKF 规范", link: "/zh-CN/guide/open-knowledge-format" },
          { text: "文件优先图关系", link: "/zh-CN/guide/file-first-graph" },
          { text: "知识库资源管理", link: "/zh-CN/guide/resource-management" },
          { text: "文件清洗入库指南", link: "/zh-CN/guide/file-cleaning-ingestion" }
        ]
      },
      {
        text: "部署",
        items: [
          { text: "Docker Compose", link: "/zh-CN/deployment/docker-compose" },
          { text: "环境变量配置", link: "/zh-CN/deployment/environment" },
          { text: "Admin 配置", link: "/zh-CN/deployment/admin-settings" },
          { text: "使用 Agent 部署", link: "/zh-CN/deployment/agent-deployment" }
        ]
      },
      {
        text: "Developer OpenAPI",
        items: [{ text: "概览", link: "/zh-CN/openapi/" }, ...readOpenApiSidebar("zh-CN")]
      },
      {
        text: "Agent 接入",
        items: [
          { text: "概览", link: "/zh-CN/agent-integration/" },
          { text: "后端适配", link: "/zh-CN/agent-integration/backend-adapter" },
          {
            text: "自有 Agent 客户端接入",
            collapsed: true,
            items: [
              { text: "Tools 设计", link: "/zh-CN/agent-integration/own-agent-client/tools-design" },
              { text: "Skill 设计", link: "/zh-CN/agent-integration/own-agent-client/skill-design" }
            ]
          },
          {
            text: "第三方 Agent 客户端接入",
            collapsed: true,
            items: [
              { text: "Skill 设计", link: "/zh-CN/agent-integration/third-party-agent-client/skill-design" }
            ]
          },
          { text: "Demo 运行测试结果示例", link: "/zh-CN/agent-integration/demo-agent-result" }
        ]
      }
    ]
  };
}

export default defineConfig({
  title: "Focowiki",
  description: "Markdown knowledge-base system with OKF-style bundles and Developer OpenAPI.",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: englishThemeConfig(),
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      title: "Focowiki",
      description: "Markdown knowledge-base system with OKF-style bundles and Developer OpenAPI.",
      themeConfig: englishThemeConfig()
    },
    "zh-CN": {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh-CN/",
      title: "Focowiki",
      description: "面向开发者和产品经理的 Markdown 知识库系统。",
      themeConfig: chineseThemeConfig()
    }
  }
});
