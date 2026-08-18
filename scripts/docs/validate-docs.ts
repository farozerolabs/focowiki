import fs from "node:fs/promises";
import path from "node:path";
import { createDeveloperOpenApiDocument } from "../../apps/api/src/developer-openapi/openapi-document.js";

type OpenApiDocument = ReturnType<typeof createDeveloperOpenApiDocument> & {
  info: { version: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

const repoRoot = process.cwd();
const docsRoot = path.join(repoRoot, "docs");
const vitePressConfigPath = path.join(docsRoot, ".vitepress", "config.ts");
const publicOpenApiDir = path.join(docsRoot, "public", "openapi");
const contractPath = path.join(publicOpenApiDir, "focowiki-openapi.json");
const deploymentEnvTemplatePath = path.join(repoRoot, ".env.example");
const swaggerUiStylesheetPath = path.join(
  docsRoot,
  "public",
  "vendor",
  "swagger-ui",
  "swagger-ui.css"
);
const localeCopyPath = path.join(docsRoot, ".vitepress", "openapi-locales.json");
const httpMethods = new Set(["get", "post", "put", "patch", "delete"]);
const locales = [
  {
    name: "English",
    projectPage: path.join(docsRoot, "index.md"),
    deploymentPages: [
      path.join(docsRoot, "deployment", "docker-compose.md"),
      path.join(docsRoot, "deployment", "agent-deployment.md")
    ],
    openApiPage: path.join(docsRoot, "openapi", "index.md"),
    explorerPage: path.join(docsRoot, "openapi", "explorer.md"),
    explorerRoute: "/openapi/explorer",
    explorerLabel: "API Explorer",
    guidePages: [
      path.join(docsRoot, "guide", "open-knowledge-format.md"),
      path.join(docsRoot, "guide", "file-first-graph.md"),
      path.join(docsRoot, "guide", "file-cleaning-ingestion.md")
    ],
    agentIntegrationPages: [
      path.join(docsRoot, "agent-integration", "index.md"),
      path.join(docsRoot, "agent-integration", "backend-adapter.md"),
      path.join(docsRoot, "agent-integration", "own-agent-client", "tools-design.md"),
      path.join(docsRoot, "agent-integration", "own-agent-client", "skill-design.md"),
      path.join(docsRoot, "agent-integration", "third-party-agent-client", "skill-design.md")
    ],
    operationsDir: path.join(docsRoot, "openapi", "operations")
  },
  {
    name: "Simplified Chinese",
    projectPage: path.join(docsRoot, "zh-CN", "index.md"),
    deploymentPages: [
      path.join(docsRoot, "zh-CN", "deployment", "docker-compose.md"),
      path.join(docsRoot, "zh-CN", "deployment", "agent-deployment.md")
    ],
    openApiPage: path.join(docsRoot, "zh-CN", "openapi", "index.md"),
    explorerPage: path.join(docsRoot, "zh-CN", "openapi", "explorer.md"),
    explorerRoute: "/zh-CN/openapi/explorer",
    explorerLabel: "API 交互文档",
    guidePages: [
      path.join(docsRoot, "zh-CN", "guide", "open-knowledge-format.md"),
      path.join(docsRoot, "zh-CN", "guide", "file-first-graph.md"),
      path.join(docsRoot, "zh-CN", "guide", "file-cleaning-ingestion.md")
    ],
    agentIntegrationPages: [
      path.join(docsRoot, "zh-CN", "agent-integration", "index.md"),
      path.join(docsRoot, "zh-CN", "agent-integration", "backend-adapter.md"),
      path.join(docsRoot, "zh-CN", "agent-integration", "own-agent-client", "tools-design.md"),
      path.join(docsRoot, "zh-CN", "agent-integration", "own-agent-client", "skill-design.md"),
      path.join(docsRoot, "zh-CN", "agent-integration", "third-party-agent-client", "skill-design.md")
    ],
    operationsDir: path.join(docsRoot, "zh-CN", "openapi", "operations")
  }
];
const forbiddenPatterns = [
  { name: "local user path", pattern: /\/Users\// },
  { name: "raw OpenAPI key", pattern: /fwok_[A-Za-z0-9]/ },
  { name: "raw webhook secret", pattern: /fwwh_[A-Za-z0-9]/ },
  { name: "provider key", pattern: /sk-[A-Za-z0-9]{16,}/ },
  { name: "S3 secret assignment", pattern: /S3_SECRET_ACCESS_KEY\s*=/ },
  { name: "model key assignment", pattern: /MODEL_API_KEY\s*=/ }
];
const forbiddenArchitecturePatterns = [
  { name: "upload-generation setting", pattern: /upload generation|上传生成/i },
  { name: "legacy worker database pool", pattern: /^WORKER_DATABASE_POOL_MAX=/m },
  { name: "release-scoped generated data", pattern: /release-scoped/i },
  { name: "legacy active release", pattern: /active release|活动版本/i },
  { name: "legacy release activation", pattern: /release activation|版本激活/i }
];

async function main() {
  const markdownFiles = await listMarkdownFiles(docsRoot);
  const openApiDocument = createDeveloperOpenApiDocument() as OpenApiDocument;
  await validateLocaleStructure();
  await validateSwaggerUiStaticAsset();
  await validateGuideNavigation();
  await validateDeploymentNavigation();
  await validateDeploymentDocumentation();
  await validateOpenApiExplorer();
  await validateGeneratedOpenApiContractVersion(openApiDocument);
  await validateOpenApiLocaleCopy(openApiDocument);
  await validateOperationCoverage(openApiDocument);
  await validateOpenApiContractExamples(openApiDocument);
  await validateGeneratedOperationExamples(openApiDocument);
  await validateGeneratedOperationTables();
  await validatePublicOpenApiCopy();
  await validateDocumentedRuntimeFacts();
  await validateAdminConfigurationDocumentation();
  await validateAgentSearchGuidance();
  await validateAgentIntegrationContracts(openApiDocument);
  await validateAgentSkillLanguage();
  await validateHandwrittenDocumentationBoundaries(markdownFiles);
  await validateMarkdownLinks(markdownFiles);
  await validateLanguageStyle(markdownFiles);
  await validateCurrentArchitectureLanguage(markdownFiles);
  await validateSensitiveContent(markdownFiles);
  validateSafeContent("Developer OpenAPI contract", JSON.stringify(openApiDocument));
  console.log("Documentation validation passed.");
}

async function validateAgentIntegrationContracts(document: OpenApiDocument) {
  const operationIds = collectOperationIds(document);
  const requiredOperationIds = [
    "uploadSessionEntryContent",
    "getKnowledgeBaseSourceFile",
    "listKnowledgeBaseTree",
    "getFileContentByPath",
    "searchGeneratedFiles",
    "expandGraph"
  ];

  for (const operationId of requiredOperationIds) {
    if (!operationIds.has(operationId)) {
      throw new Error(`Agent integration requires missing OpenAPI operation ${operationId}.`);
    }
  }

  for (const locale of locales) {
    const content = (await Promise.all(
      locale.agentIntegrationPages.map((file) => fs.readFile(file, "utf8"))
    )).join("\n");
    const required = locale.name === "Simplified Chinese"
      ? ["每个文档独立索引", "activeContentRevision", "uploadSessionEntryContent"]
      : ["indexed independently", "activeContentRevision", "uploadSessionEntryContent"];
    assertRequiredDocumentationPhrases(
      `${locale.name} Agent integration pages`,
      content,
      required
    );
    assertForbiddenDocumentationPhrases(
      `${locale.name} Agent integration pages`,
      content,
      ["uploadSessionContentBatch"]
    );
  }
}

async function validateAgentSkillLanguage() {
  const agentAnsweringSkillPages = [
    path.join(docsRoot, "agent-integration", "own-agent-client", "skill-design.md"),
    path.join(docsRoot, "agent-integration", "third-party-agent-client", "skill-design.md"),
    path.join(docsRoot, "zh-CN", "agent-integration", "own-agent-client", "skill-design.md"),
    path.join(docsRoot, "zh-CN", "agent-integration", "third-party-agent-client", "skill-design.md")
  ];
  const skillPages = [
    ...agentAnsweringSkillPages,
    path.join(docsRoot, "guide", "file-cleaning-ingestion.md"),
    path.join(docsRoot, "zh-CN", "guide", "file-cleaning-ingestion.md")
  ];
  const forbiddenSkillDetails = [
    "Focowiki",
    "OpenAPI",
    "activeContentRevision",
    "generatedOutputStatus",
    "sourceFileId",
    "semanticStatus",
    "evidenceStatus",
    "rerankerStatus",
    "graphStatus",
    "readActions",
    "_index/",
    "_graph/"
  ];

  for (const file of skillPages) {
    const content = await fs.readFile(file, "utf8");
    for (const block of fencedBlocks(content)) {
      if (file.includes(`${path.sep}zh-CN${path.sep}`) && /[\u3400-\u9fff]/u.test(block)) {
        throw new Error(`Skill package content must stay English in ${relative(file)}.`);
      }
      if (!agentAnsweringSkillPages.includes(file)) {
        continue;
      }
      for (const detail of forbiddenSkillDetails) {
        if (block.includes(detail)) {
          throw new Error(
            `Skill package content exposes backend detail ${detail} in ${relative(file)}.`
          );
        }
      }
    }
  }
}

function fencedBlocks(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let fenceLength = 0;
  let current: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(`{3,})(?:[A-Za-z0-9_-]+)?\s*$/u);
    if (fenceLength === 0) {
      if (match) {
        fenceLength = match[1].length;
        current = [];
      }
      continue;
    }
    if (match && match[1].length >= fenceLength) {
      blocks.push(current.join("\n"));
      fenceLength = 0;
      current = [];
      continue;
    }
    current.push(line);
  }

  return blocks;
}

async function validateAdminConfigurationDocumentation() {
  const englishAdminPath = path.join(docsRoot, "deployment", "admin-settings.md");
  const chineseAdminPath = path.join(docsRoot, "zh-CN", "deployment", "admin-settings.md");
  const englishDockerPath = path.join(docsRoot, "deployment", "docker-compose.md");
  const chineseDockerPath = path.join(docsRoot, "zh-CN", "deployment", "docker-compose.md");
  const chineseOpenApiPath = path.join(docsRoot, "zh-CN", "openapi", "index.md");
  const englishAdmin = await fs.readFile(englishAdminPath, "utf8");
  const chineseAdmin = await fs.readFile(chineseAdminPath, "utf8");
  const englishDocker = await fs.readFile(englishDockerPath, "utf8");
  const chineseDocker = await fs.readFile(chineseDockerPath, "utf8");
  const chineseOpenApi = await fs.readFile(chineseOpenApiPath, "utf8");

  assertRequiredDocumentationPhrases(englishAdminPath, englishAdmin, [
    "Model configuration",
    "GraphRAG adapter timeout milliseconds",
    "Embedding Models",
    "Reranker Models"
  ]);
  assertRequiredDocumentationPhrases(chineseAdminPath, chineseAdmin, [
    "模型配置",
    "GraphRAG 适配器超时毫秒",
    "嵌入模型",
    "重排模型"
  ]);

  const staleEnglishSettings = [
    "Knowledge-base maintenance mode",
    "Automatic maintenance interval seconds",
    "Knowledge-base maintenance concurrency",
    "Storage deletion batch size",
    "Storage cleanup grace seconds",
    "Generated-content repair concurrency",
    "Search rebuild concurrency",
    "Incomplete index retention hours",
    "Maximum community partitions",
    "Community adapter timeout milliseconds",
    "own Settings tab",
    "Reranker Settings tab"
  ];
  const staleChineseSettings = [
    "知识库维护模式",
    "自动维护间隔秒数",
    "知识库维护并发",
    "存储删除批次大小",
    "存储清理宽限秒数",
    "生成内容修复并发",
    "搜索重建并发",
    "未完成索引保留小时数",
    "最大社区分区数",
    "社区适配器超时毫秒",
    "向量模型",
    "查询向量"
  ];

  assertForbiddenDocumentationPhrases(englishAdminPath, englishAdmin, staleEnglishSettings);
  assertForbiddenDocumentationPhrases(chineseAdminPath, chineseAdmin, staleChineseSettings);
  assertForbiddenDocumentationPhrases(chineseDockerPath, chineseDocker, ["在设置中分别创建", "向量模型"]);
  assertForbiddenDocumentationPhrases(chineseOpenApiPath, chineseOpenApi, ["向量模型配置"]);
  assertRequiredDocumentationPhrases(englishDockerPath, englishDocker, [
    "Model configuration",
    "Upload completion requires both configurations."
  ]);
  assertRequiredDocumentationPhrases(chineseDockerPath, chineseDocker, [
    "模型配置",
    "完成上传需要这两项配置。"
  ]);
  assertForbiddenDocumentationPhrases(englishDockerPath, englishDocker, [
    "No model credentials are required for the base file-first workflow."
  ]);
  assertForbiddenDocumentationPhrases(chineseDockerPath, chineseDocker, [
    "基础文件优先流程不要求模型凭据。"
  ]);
}

function assertRequiredDocumentationPhrases(file: string, content: string, phrases: string[]) {
  for (const phrase of phrases) {
    if (!content.includes(phrase)) {
      throw new Error(`Documentation is missing ${phrase} in ${relative(file)}.`);
    }
  }
}

function assertForbiddenDocumentationPhrases(file: string, content: string, phrases: string[]) {
  for (const phrase of phrases) {
    if (content.includes(phrase)) {
      throw new Error(`Documentation contains stale phrase ${phrase} in ${relative(file)}.`);
    }
  }
}

async function validateAgentSearchGuidance() {
  for (const locale of locales) {
    const adminSettingsPage = locale.name === "Simplified Chinese"
      ? path.join(docsRoot, "zh-CN", "deployment", "admin-settings.md")
      : path.join(docsRoot, "deployment", "admin-settings.md");
    const content = (await Promise.all([
      locale.openApiPage,
      adminSettingsPage,
      ...locale.agentIntegrationPages
    ].map((file) => fs.readFile(file, "utf8")))).join("\n");
    const required = locale.name === "Simplified Chinese"
      ? ["完整独立问题", "最多执行两轮", "来源 Markdown", "rerankTopK",
          "rerankScoreThreshold", "余弦"]
      : ["standalone natural-language question", "at most two", "source Markdown",
          "rerankTopK", "rerankScoreThreshold", "cosine"];
    for (const phrase of required) {
      if (!content.includes(phrase)) {
        throw new Error(
          `${locale.name} Agent search guidance is missing ${phrase}.`
        );
      }
    }
    for (const stale of [
      "Do not send the full user question",
      "one phrase at a time",
      "Repeat breadth and depth while new evidence"
    ]) {
      if (content.includes(stale)) {
        throw new Error(
          `${locale.name} Agent search guidance retains stale phrase ${stale}.`
        );
      }
    }
  }
}

async function validateHandwrittenDocumentationBoundaries(markdownFiles: string[]) {
  const englishAdminPath = path.join(docsRoot, "deployment", "admin-settings.md");
  const chineseAdminPath = path.join(docsRoot, "zh-CN", "deployment", "admin-settings.md");
  const englishGraphPath = path.join(docsRoot, "guide", "file-first-graph.md");
  const chineseGraphPath = path.join(docsRoot, "zh-CN", "guide", "file-first-graph.md");
  const [englishAdmin, chineseAdmin, englishGraph, chineseGraph] = await Promise.all([
    englishAdminPath,
    chineseAdminPath,
    englishGraphPath,
    chineseGraphPath
  ].map((file) => fs.readFile(file, "utf8")));

  assertRequiredDocumentationPhrases(englishAdminPath, englishAdmin, [
    "Completing an upload requires both one active generation model and one active, validated embedding configuration."
  ]);
  assertRequiredDocumentationPhrases(chineseAdminPath, chineseAdmin, [
    "完成上传需要一个生效生成模型和一个已经验证并生效的嵌入模型配置"
  ]);
  assertRequiredDocumentationPhrases(englishGraphPath, englishGraph, [
    "requires one current readable `fileId`",
    "does not accept a free-text query, node ID, or edge ID",
    "index-directory-leaf-<stable-id>.md",
    "index-extension-leaf-<stable-id>.md",
    "_graph/by-file/guides/install.json"
  ]);
  assertRequiredDocumentationPhrases(chineseGraphPath, chineseGraph, [
    "要求一个当前可读取的 `fileId`",
    "不能使用自由文本查询、节点 ID 或边 ID",
    "index-directory-leaf-<stable-id>.md",
    "index-extension-leaf-<stable-id>.md",
    "_graph/by-file/guides/install.json"
  ]);

  const allDocumentation = (await Promise.all(
    markdownFiles.map((file) => fs.readFile(file, "utf8"))
  )).join("\n");
  assertForbiddenDocumentationPhrases("handwritten documentation", allDocumentation, [
    "schema.md",
    "r-terms.json",
    "uploadSessionContentBatch",
    "_graph/by-file/pages/",
    "file, node, edge, or query seed",
    "文件、节点、边或查询作为起点"
  ]);

  const guideContent = [englishGraph, chineseGraph].join("\n");
  assertForbiddenDocumentationPhrases("file relationship guides", guideContent, [
    "PostgreSQL stores relationship facts",
    "Redis coordinates",
    "generation-scoped durable facts",
    "projection scope",
    "PostgreSQL 保存关系事实",
    "Redis 协调",
    "按生成版本保存的持久化事实",
    "投影范围"
  ]);

  const chineseProse = (await Promise.all(
    markdownFiles
      .filter((file) => file.includes(`${path.sep}zh-CN${path.sep}`))
      .map(async (file) => stripInlineCode(stripCodeBlocks(await fs.readFile(file, "utf8"))))
  )).join("\n");
  assertForbiddenDocumentationPhrases("Simplified Chinese prose", chineseProse, [
    "登录 session",
    "兼容 bucket",
    "要求的 region",
    "OpenSearch heap",
    "OpenSearch endpoint",
    "Meilisearch snapshot",
    "OpenSearch snapshot",
    "HTTPS origins",
    "API 接受的 hostnames",
    "健康检查 hostname",
    "OpenSearch 的 demo 安装程序",
    "兼容的 Meilisearch snapshot",
    "OpenSearch snapshot",
    "OpenSearch heap",
    "S3 兼容 bucket",
    "要求的 region",
    "独立 bucket",
    "path style",
    "canonical URL",
    "cookie banner",
    "独立行、sheet",
    "语言文字 bucket 路由",
    "多语言 postings",
    "Compose project name",
    "分页读取 cursor",
    "全部 hostname",
    "输入的 hash",
    "| 隐私 | secrets"
  ]);
}

async function validateCurrentArchitectureLanguage(markdownFiles: string[]) {
  for (const file of markdownFiles) {
    const content = await fs.readFile(file, "utf8");
    for (const forbidden of forbiddenArchitecturePatterns) {
      if (forbidden.pattern.test(content)) {
        throw new Error(`Documentation contains ${forbidden.name} in ${relative(file)}.`);
      }
    }
  }
}

async function validateSwaggerUiStaticAsset() {
  await assertFileExists(swaggerUiStylesheetPath, "Swagger UI stylesheet is missing");
  const stylesheet = await fs.readFile(swaggerUiStylesheetPath, "utf8");
  if (!stylesheet.includes(".swagger-ui")) {
    throw new Error("Swagger UI stylesheet does not contain the expected scoped styles.");
  }
}

async function validateOpenApiLocaleCopy(document: OpenApiDocument) {
  const copies = readRecord(JSON.parse(await fs.readFile(localeCopyPath, "utf8")));
  const operationIds = collectOperationIds(document);
  const fieldNames = collectOpenApiFieldNames(document);
  const contractStrings = collectOpenApiStrings(document);
  const tags = new Set(
    collectOperations(document).flatMap(({ operation }) =>
      readArray(operation.tags).filter((tag): tag is string => typeof tag === "string")
    )
  );

  for (const localeName of ["en-US", "zh-CN"]) {
    const copy = readRecord(copies[localeName]);
    const summaries = readRecord(copy.operationSummaries);
    const descriptions = readRecord(copy.operationDescriptions);
    const successDescriptions = readRecord(copy.successResponseDescriptions);
    const tagLabels = readRecord(copy.tagLabels);
    const fieldDescriptions = readRecord(copy.fieldDescriptions);
    const translatedDescriptions = readRecord(copy.descriptions);
    const missingSummaries = [...operationIds].filter((operationId) => typeof summaries[operationId] !== "string");
    const missingDescriptions = [...operationIds].filter((operationId) => typeof descriptions[operationId] !== "string");
    const missingSuccessDescriptions = [...operationIds].filter(
      (operationId) => typeof successDescriptions[operationId] !== "string"
    );
    const staleSummaries = Object.keys(summaries).filter((operationId) => !operationIds.has(operationId));
    const staleDescriptions = Object.keys(descriptions).filter((operationId) => !operationIds.has(operationId));
    const staleFieldDescriptions = Object.keys(fieldDescriptions).filter(
      (fieldName) => !fieldNames.has(fieldName)
    );
    const staleTranslatedDescriptions = Object.keys(translatedDescriptions).filter(
      (description) => !contractStrings.has(description)
    );
    const missingTags = [...tags].filter((tag) => typeof tagLabels[tag] !== "string");

    if (
      missingSummaries.length > 0 ||
      missingDescriptions.length > 0 ||
      missingSuccessDescriptions.length > 0 ||
      staleSummaries.length > 0 ||
      staleDescriptions.length > 0 ||
      staleFieldDescriptions.length > 0 ||
      staleTranslatedDescriptions.length > 0 ||
      missingTags.length > 0
    ) {
      throw new Error(
        [
          `Incomplete ${localeName} OpenAPI copy.`,
          missingSummaries.length > 0 ? `Missing summaries: ${missingSummaries.join(", ")}.` : "",
          missingDescriptions.length > 0 ? `Missing descriptions: ${missingDescriptions.join(", ")}.` : "",
          missingSuccessDescriptions.length > 0
            ? `Missing success descriptions: ${missingSuccessDescriptions.join(", ")}.`
            : "",
          staleSummaries.length > 0 ? `Stale summaries: ${staleSummaries.join(", ")}.` : "",
          staleDescriptions.length > 0 ? `Stale descriptions: ${staleDescriptions.join(", ")}.` : "",
          staleFieldDescriptions.length > 0
            ? `Stale field descriptions: ${staleFieldDescriptions.join(", ")}.`
            : "",
          staleTranslatedDescriptions.length > 0
            ? `Stale translated descriptions: ${staleTranslatedDescriptions.join(", ")}.`
            : "",
          missingTags.length > 0 ? `Missing tag labels: ${missingTags.join(", ")}.` : ""
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
  }
}

function collectOpenApiFieldNames(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectOpenApiFieldNames(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;

  const record = value as Record<string, unknown>;
  const properties = readRecord(record.properties);
  for (const fieldName of Object.keys(properties)) result.add(fieldName);
  if (typeof record.name === "string") result.add(record.name);
  for (const nested of Object.values(record)) collectOpenApiFieldNames(nested, result);
  return result;
}

function collectOpenApiStrings(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    result.add(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOpenApiStrings(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectOpenApiStrings(nested, result);
  }
  return result;
}

async function validatePublicOpenApiCopy() {
  const deprecatedOperationIds = [
    "uploadMarkdownFiles",
    "deleteKnowledgeBaseSourceFileTasks",
    "deleteFileById",
    "deleteFileByPath"
  ];
  const forbiddenOpenApiSnippets = [
    "docs.example.com",
    "pnpm docs:generate-api",
    "pages/遵义市城镇燃气安全管理条例.md",
    "items[0].fileId",
    "items[0].path"
  ];

  for (const locale of locales) {
    const publicPages = [locale.openApiPage, ...locale.agentIntegrationPages];
    for (const file of publicPages) {
      const content = await fs.readFile(file, "utf8");
      for (const operationId of deprecatedOperationIds) {
        if (content.includes(operationId)) {
          throw new Error(`Deprecated operationId ${operationId} remains in ${relative(file)}.`);
        }
      }
    }

    const overview = await fs.readFile(locale.openApiPage, "utf8");
    for (const snippet of forbiddenOpenApiSnippets) {
      if (overview.includes(snippet)) {
        throw new Error(`Public OpenAPI overview contains forbidden snippet ${snippet} in ${relative(locale.openApiPage)}.`);
      }
    }

    const operationFiles = (await listMarkdownFiles(locale.operationsDir)).filter(
      (file) => path.basename(file) !== "index.md"
    );
    for (const file of operationFiles) {
      const content = await fs.readFile(file, "utf8");
      const forbiddenHeadings = locale.name === "Simplified Chinese"
        ? ["## 错误响应示例", "## 流程连续性"]
        : ["## Error Response Example", "## Workflow Continuity"];
      for (const heading of forbiddenHeadings) {
        if (content.includes(heading)) {
          throw new Error(`Redundant section ${heading} remains in ${relative(file)}.`);
        }
      }
      const pageHeading = content.match(/^# (.+)$/m)?.[1] ?? "";
      if (locale.name === "Simplified Chinese" && pageHeading && !/[\u3400-\u9fff]/u.test(pageHeading)) {
        throw new Error(`English operation heading remains in ${relative(file)}.`);
      }
      if (/^\| `[^`]+` .*\|\s*\|$/m.test(content)) {
        throw new Error(`OpenAPI field description is empty in ${relative(file)}.`);
      }
    }
    const retryPage = await fs.readFile(
      path.join(locale.operationsDir, "retry-knowledge-base-source-file.md"),
      "utf8"
    );
  }
}

async function validateDocumentedRuntimeFacts() {
  for (const file of [
    path.join(docsRoot, "openapi", "webhook-delivery.md"),
    path.join(docsRoot, "zh-CN", "openapi", "webhook-delivery.md")
  ]) {
    const content = await fs.readFile(file, "utf8");
    if (/10 seconds|10 秒/u.test(content)) {
      throw new Error(`Webhook documentation hard-codes a deployment-controlled timeout in ${relative(file)}.`);
    }
    for (const eventType of [
      "document.waiting",
      "document.processing",
      "document.available",
      "document.error",
      "document.deleting"
    ]) {
      if (!new RegExp(`${eventType.replace(".", "\\.")}[^\\n]+sourceFileId`, "u").test(content)) {
        throw new Error(`Webhook document payload omits sourceFileId in ${relative(file)}.`);
      }
    }
    if (/sourceRevisionId/u.test(content)) {
      throw new Error(`Webhook documentation exposes internal sourceRevisionId in ${relative(file)}.`);
    }
    if (!/Automatic retry|自动重试/u.test(content)) {
      throw new Error(`Webhook automatic retry behavior is missing in ${relative(file)}.`);
    }
  }
}

async function validateGeneratedOpenApiContractVersion(document: OpenApiDocument) {
  const generated = readRecord(JSON.parse(await fs.readFile(contractPath, "utf8")));
  const expectedVersion = document.info.version;
  const generatedVersion = readRecord(generated.info).version;

  if (generatedVersion !== expectedVersion) {
    throw new Error(
      `Generated OpenAPI contract version ${String(generatedVersion)} does not match ${expectedVersion}.`
    );
  }

  const paths = readRecord(generated.paths);
  const versionOperation = readRecord(readRecord(paths["/openapi/v2/version"]).get);
  const versionResponse = readRecord(readRecord(versionOperation.responses)["200"]);
  const versionExample = readRecord(readJsonContentExample(versionResponse));
  if (versionExample.version !== expectedVersion || versionExample.apiVersion !== "v2") {
    throw new Error("Generated version response example does not match release metadata.");
  }

  const contractOperation = readRecord(readRecord(paths["/openapi/v2/openapi.json"]).get);
  const contractResponse = readRecord(readRecord(contractOperation.responses)["200"]);
  const contractExample = readRecord(readJsonContentExample(contractResponse));
  if (readRecord(contractExample.info).version !== expectedVersion) {
    throw new Error("Generated OpenAPI contract example does not match release metadata.");
  }
}

async function validateOperationCoverage(document: OpenApiDocument) {
  const expected = collectOperationIds(document);
  const perLocaleOperationIds: Array<{ name: string; operationIds: Set<string> }> = [];

  for (const locale of locales) {
    const actual = new Set<string>();
    const files = await listMarkdownFiles(locale.operationsDir);

    for (const file of files) {
      if (path.basename(file) === "index.md") {
        continue;
      }
      const content = await fs.readFile(file, "utf8");
      const operationId = content.match(/^operationId:\s*["']?([^"'\n]+)["']?/m)?.[1];
      if (!operationId) {
        throw new Error(`Missing operationId frontmatter in ${relative(file)}.`);
      }
      actual.add(operationId);
    }

    const missing = [...expected].filter((operationId) => !actual.has(operationId));
    const unknown = [...actual].filter((operationId) => !expected.has(operationId));
    if (missing.length > 0 || unknown.length > 0) {
      throw new Error(
        [
          `OpenAPI documentation coverage failed for ${locale.name}.`,
          missing.length > 0 ? `Missing pages: ${missing.join(", ")}` : "",
          unknown.length > 0 ? `Unknown operation pages: ${unknown.join(", ")}` : ""
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
    perLocaleOperationIds.push({ name: locale.name, operationIds: actual });
  }

  const [first, ...rest] = perLocaleOperationIds;
  for (const locale of rest) {
    const missing = [...first.operationIds].filter((operationId) => !locale.operationIds.has(operationId));
    const extra = [...locale.operationIds].filter((operationId) => !first.operationIds.has(operationId));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        [
          `OpenAPI locale coverage differs between ${first.name} and ${locale.name}.`,
          missing.length > 0 ? `Missing in ${locale.name}: ${missing.join(", ")}` : "",
          extra.length > 0 ? `Extra in ${locale.name}: ${extra.join(", ")}` : ""
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
  }
}

async function validateOpenApiContractExamples(document: OpenApiDocument) {
  for (const { method, path: apiPath, operation } of collectOperations(document)) {
    if (operation["x-request-example"] === undefined) {
      throw new Error(`Missing x-request-example for ${method.toUpperCase()} ${apiPath}.`);
    }

    const requestBody = readRecord(operation.requestBody);
    if (Object.keys(requestBody).length > 0 && !hasAnyContentExample(requestBody)) {
      throw new Error(`Missing request body example for ${method.toUpperCase()} ${apiPath}.`);
    }
    for (const [contentType, mediaValue] of Object.entries(readRecord(requestBody.content))) {
      const media = readRecord(mediaValue);
      for (const [exampleName, example] of readMediaExamples(media)) {
        validateSchemaValue(
          document,
          readRecord(media.schema),
          example,
          `${method.toUpperCase()} ${apiPath} request body (${contentType}, ${exampleName})`
        );
      }
    }

    const responses = readRecord(operation.responses);
    const successResponses = Object.entries(responses).filter(([status]) => status.startsWith("2"));
    if (successResponses.length === 0) {
      throw new Error(`Missing successful response for ${method.toUpperCase()} ${apiPath}.`);
    }

    for (const [status, response] of successResponses) {
      const responseRecord = readRecord(response);
      const contentExample = readAnyContentExample(responseRecord);
      if (contentExample.example === undefined) {
        throw new Error(`Missing ${status} success example for ${method.toUpperCase()} ${apiPath}.`);
      }
      if (contentExample.contentType === "application/json") {
        validateExampleShape(document, method, apiPath, status, responseRecord, contentExample.example);
        validateContractExampleContent(method, apiPath, contentExample.example);
      } else {
        const media = readRecord(
          readRecord(responseRecord.content)[contentExample.contentType ?? ""]
        );
        validateSchemaValue(
          document,
          readRecord(media.schema),
          contentExample.example,
          `${method.toUpperCase()} ${apiPath} ${status}`
        );
      }
      validateSafeContent(
        `${method.toUpperCase()} ${apiPath} ${status} example`,
        JSON.stringify(contentExample.example)
      );
    }

    for (const [status, responseValue] of Object.entries(responses).filter(
      ([status]) => !status.startsWith("2")
    )) {
      const response = readRecord(responseValue);
      const example = readJsonContentExample(response);
      if (!example) {
        throw new Error(`Missing ${status} error example for ${method.toUpperCase()} ${apiPath}.`);
      }
      validateExampleShape(document, method, apiPath, status, response, example);
      validateSafeContent(`${method.toUpperCase()} ${apiPath} ${status} example`, JSON.stringify(example));
    }
  }
}

function validateContractExampleContent(method: string, apiPath: string, example: unknown) {
  if (method !== "get" || apiPath !== "/openapi/v2/openapi.json") {
    return;
  }

  const paths = readRecord(readRecord(example).paths);
  if (!paths["/openapi/v2/knowledge-bases"]) {
    throw new Error("OpenAPI contract success example must include a representative non-empty paths object.");
  }
}

async function validateGeneratedOperationExamples(document: OpenApiDocument) {
  const operations = collectOperations(document);
  const expected = new Set(operations.map((item) => item.operationId));
  const operationById = new Map(operations.map((item) => [item.operationId, item.operation]));
  for (const locale of locales) {
    const files = (await listMarkdownFiles(locale.operationsDir)).filter((file) => path.basename(file) !== "index.md");
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      const operationId = content.match(/^operationId:\s*["']?([^"'\n]+)["']?/m)?.[1];
      if (!operationId || !expected.has(operationId)) {
        continue;
      }
      const requiredSnippets = locale.name === "Simplified Chinese"
        ? ["## 请求示例", "## 成功响应示例"]
        : ["## Request Example", "## Success Response Example"];
      for (const snippet of requiredSnippets) {
        if (!content.includes(snippet)) {
          throw new Error(`Missing ${snippet} in ${relative(file)}.`);
        }
      }
      if (!content.includes("curl ") || !content.includes("Authorization: Bearer <openapi-key>")) {
        throw new Error(`Missing copyable curl request example in ${relative(file)}.`);
      }
      const operation = readRecord(operationById.get(operationId));
      for (const parameterValue of readArray(operation.parameters)) {
        const parameter = readRecord(parameterValue);
        if (parameter.in !== "header" || parameter.required !== true || typeof parameter.name !== "string") {
          continue;
        }
        if (!content.includes(`-H \"${parameter.name}: `)) {
          throw new Error(`Missing required ${parameter.name} header in ${relative(file)} curl example.`);
        }
      }
    }
  }
}

async function validateGeneratedOperationTables() {
  for (const locale of locales) {
    const files = (await listMarkdownFiles(locale.operationsDir)).filter((file) => path.basename(file) !== "index.md");
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      for (const table of extractMarkdownTables(content)) {
        const seen = new Set<string>();
        for (const row of table) {
          const firstCell = row.split("|")[1]?.trim() ?? "";
          const field = firstCell.match(/^`([^`]+)`$/)?.[1];
          if (!field) {
            continue;
          }
          if (seen.has(field)) {
            throw new Error(`Duplicate field row \`${field}\` in ${relative(file)}.`);
          }
          seen.add(field);
        }
      }
    }
  }
}

async function validateLocaleStructure() {
  for (const locale of locales) {
    for (const file of [
      locale.projectPage,
      ...locale.deploymentPages,
      locale.openApiPage,
      locale.explorerPage,
      ...locale.guidePages,
      ...locale.agentIntegrationPages
    ]) {
      await assertFileExists(file, `${locale.name} documentation page is missing`);
    }
    await assertFileExists(path.join(locale.operationsDir, "index.md"), `${locale.name} operation index is missing`);
  }
}

async function validateOpenApiExplorer() {
  const config = await fs.readFile(vitePressConfigPath, "utf8");
  const componentPath = path.join(
    docsRoot,
    ".vitepress",
    "theme",
    "components",
    "SwaggerApiExplorer.vue"
  );
  const component = await fs.readFile(componentPath, "utf8");
  const contractUrl = "/openapi/focowiki-openapi.json";

  if (!component.includes(contractUrl)) {
    throw new Error(`Swagger API Explorer component is missing ${contractUrl}.`);
  }

  for (const locale of locales) {
    const page = await fs.readFile(locale.explorerPage, "utf8");
    const overview = await fs.readFile(locale.openApiPage, "utf8");
    for (const snippet of ["pageClass: api-explorer-page", "<SwaggerApiExplorer"]) {
      if (!page.includes(snippet)) {
        throw new Error(`${locale.name} API Explorer is missing ${snippet}.`);
      }
    }
    if (!config.includes(`text: "${locale.explorerLabel}", link: "${locale.explorerRoute}"`)) {
      throw new Error(`${locale.name} API Explorer sidebar entry is missing.`);
    }
    if (!overview.includes("./explorer.md")) {
      throw new Error(`${locale.name} OpenAPI overview does not link to the API Explorer.`);
    }
  }
}

async function validateGuideNavigation() {
  const config = await fs.readFile(vitePressConfigPath, "utf8");
  assertOrderedSnippets(config, [
    'text: "Open Knowledge Format", link: "/guide/open-knowledge-format"',
    'text: "Source Evidence and Graph", link: "/guide/file-first-graph"',
    'text: "File Cleaning and Ingestion Guide", link: "/guide/file-cleaning-ingestion"'
  ], "English guide sidebar");
  assertOrderedSnippets(config, [
    'text: "Google OKF 规范", link: "/zh-CN/guide/open-knowledge-format"',
    'text: "来源证据与图关系", link: "/zh-CN/guide/file-first-graph"',
    'text: "文件清洗入库指南", link: "/zh-CN/guide/file-cleaning-ingestion"'
  ], "Simplified Chinese guide sidebar");
}

async function validateDeploymentNavigation() {
  const config = await fs.readFile(vitePressConfigPath, "utf8");
  assertOrderedSnippets(config, [
    'text: "Docker Compose", link: "/deployment/docker-compose"',
    'text: "Agent-assisted Deployment", link: "/deployment/agent-deployment"'
  ], "English deployment sidebar");
  assertOrderedSnippets(config, [
    'text: "Docker Compose", link: "/zh-CN/deployment/docker-compose"',
    'text: "使用 Agent 部署", link: "/zh-CN/deployment/agent-deployment"'
  ], "Simplified Chinese deployment sidebar");
}

async function validateDeploymentDocumentation() {
  const envTemplate = await fs.readFile(deploymentEnvTemplatePath, "utf8");
  const documentedEnvKeys = Array.from(
    envTemplate.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu),
    (match) => match[1] ?? ""
  ).filter(Boolean);
  const deploymentLocales = [
    {
      environment: path.join(docsRoot, "deployment", "environment.md"),
      compose: path.join(docsRoot, "deployment", "docker-compose.md"),
      settings: path.join(docsRoot, "deployment", "admin-settings.md"),
      agent: path.join(docsRoot, "deployment", "agent-deployment.md"),
      privateInfrastructureText: "PostgreSQL and Redis are not published to host ports",
      settingsSections: {
        "API Rate Limits": 6,
        Worker: 4,
        "Generated Knowledge Base": 5,
        Graph: 9,
        Maintenance: 10,
        Search: 12,
        "Semantic Search": 7,
        "Embedding Models": 14,
        Models: 11
      }
    },
    {
      environment: path.join(docsRoot, "zh-CN", "deployment", "environment.md"),
      compose: path.join(docsRoot, "zh-CN", "deployment", "docker-compose.md"),
      settings: path.join(docsRoot, "zh-CN", "deployment", "admin-settings.md"),
      agent: path.join(docsRoot, "zh-CN", "deployment", "agent-deployment.md"),
      privateInfrastructureText: "PostgreSQL 和 Redis 不会映射到宿主机端口",
      settingsSections: {
        "API 限流": 6,
        Worker: 4,
        生成知识库: 5,
        图关系: 9,
        维护: 10,
        搜索: 12,
        语义搜索: 7,
        嵌入模型: 14,
        模型: 11
      }
    }
  ];
  const forbiddenImplementationLanguage = [
    /storage[- ]vnext/iu,
    /active\/candidate release roots|活动与候选发布根/iu,
    /bounded audit evidence|有界审计证据/iu,
    /scoped coordination|范围协调/iu,
    /content-addressed generated|内容寻址的生成/iu,
    /\bprojection(?:s| objects?| validation| partitions?| impacts?| repair| compaction)?\b|投影(?:对象|校验|分区|影响|修复|压缩)?/iu,
    /candidate release|candidate generation|active root|候选发布|候选 generation|活动发布根/iu,
    /authoritative markdown|权威 Markdown/iu,
    /object ownership|对象所有权/iu,
    /write-capable role|可写角色/iu,
    /backup manifest|备份 manifest/iu,
    /publication pressure|发布压力/iu,
    /\bbounded\b|有界/iu
  ];

  for (const localOrUnusedKey of [
    "ADMIN_UI_HOST",
    "VITE_ADMIN_API_BASE_URL",
    "POSTGRES_PORT",
    "REDIS_PORT",
    "CORS_ORIGINS"
  ]) {
    if (new RegExp(`^${localOrUnusedKey}=`, "mu").test(envTemplate)) {
      throw new Error(`Production environment template exposes ${localOrUnusedKey}.`);
    }
  }

  for (const locale of deploymentLocales) {
    const environment = await fs.readFile(locale.environment, "utf8");
    const compose = await fs.readFile(locale.compose, "utf8");
    const settings = await fs.readFile(locale.settings, "utf8");
    const agent = await fs.readFile(locale.agent, "utf8");

    for (const key of documentedEnvKeys) {
      if (!environment.includes(`\`${key}\``)) {
        throw new Error(`Environment documentation is missing ${key} in ${relative(locale.environment)}.`);
      }
    }
    for (const requiredText of [
      "LOG_FILE_MAX_TOTAL_BYTES",
      "LOG_FILE_RETENTION_DAYS",
      "10m",
      locale.privateInfrastructureText
    ]) {
      if (!environment.includes(requiredText)) {
        throw new Error(`Environment documentation is missing ${requiredText} in ${relative(locale.environment)}.`);
      }
    }

    for (const [heading, expectedRows] of Object.entries(locale.settingsSections)) {
      const actualRows = countFirstTableRowsInSection(settings, heading);
      if (actualRows !== expectedRows) {
        throw new Error(
          `Admin settings section ${heading} has ${actualRows} documented fields; expected ${expectedRows} in ${relative(locale.settings)}.`
        );
      }
    }

    for (const file of [locale.environment, locale.compose, locale.settings, locale.agent]) {
      const content = file === locale.environment
        ? environment
        : file === locale.compose
          ? compose
          : file === locale.settings
            ? settings
            : agent;
      for (const pattern of forbiddenImplementationLanguage) {
        if (pattern.test(content)) {
          throw new Error(`Deployment documentation contains internal implementation language in ${relative(file)}.`);
        }
      }
    }
  }
}

function countFirstTableRowsInSection(content: string, heading: string): number {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  if (start === -1) return 0;
  const next = content.indexOf("\n## ", start + marker.length);
  const section = content.slice(start, next === -1 ? content.length : next);
  const table = extractMarkdownTables(section)[0] ?? [];
  return Math.max(0, table.length - 2);
}

function assertOrderedSnippets(content: string, snippets: string[], label: string) {
  let previousIndex = -1;
  for (const snippet of snippets) {
    const index = content.indexOf(snippet);
    if (index === -1) {
      throw new Error(`${label} is missing sidebar item: ${snippet}`);
    }
    if (index <= previousIndex) {
      throw new Error(`${label} sidebar items are not in the expected order.`);
    }
    previousIndex = index;
  }
}

async function validateMarkdownLinks(files: string[]) {
  const existing = new Set(await listFiles(docsRoot));

  for (const file of files) {
    const content = stripCodeBlocks(await fs.readFile(file, "utf8"));
    for (const link of extractMarkdownLinks(content)) {
      const target = link.split(/[?#]/)[0] ?? "";
      if (isExternalLink(target) || target === "" || target.startsWith("#")) {
        continue;
      }
      const candidates = linkCandidates(file, target);
      if (!candidates.some((candidate) => existing.has(candidate))) {
        throw new Error(`Broken Markdown link in ${relative(file)}: ${link}`);
      }
    }
  }
}

async function validateLanguageStyle(files: string[]) {
  for (const file of files) {
    const content = stripCodeBlocks(await fs.readFile(file, "utf8"));
    if (/不是[\s\S]{0,80}而是/.test(content)) {
      throw new Error(`Documentation uses a rejected contrast phrase in ${relative(file)}.`);
    }
  }
}

async function validateSensitiveContent(files: string[]) {
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    validateSafeContent(relative(file), content);
  }
}

function validateSafeContent(label: string, content: string) {
  for (const { name, pattern } of forbiddenPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Documentation contains ${name} in ${label}.`);
    }
  }
}

function collectOperationIds(document: OpenApiDocument): Set<string> {
  const operationIds = new Set<string>();
  for (const pathItem of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (httpMethods.has(method) && typeof operation.operationId === "string") {
        operationIds.add(operation.operationId);
      }
    }
  }
  return operationIds;
}

function collectOperations(document: OpenApiDocument) {
  return Object.entries(document.paths).flatMap(([apiPath, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => httpMethods.has(method))
      .map(([method, operation]) => ({
        method,
        path: apiPath,
        operation,
        operationId: String(operation.operationId)
      }))
  );
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files = await listFiles(root);
  return files.filter((file) => file.endsWith(".md"));
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => !shouldSkip(entry.name))
      .map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return listFiles(fullPath);
        }
        return [fullPath];
      })
  );
  return files.flat();
}

async function assertFileExists(file: string, message: string) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      throw new Error(message);
    }
  } catch {
    throw new Error(`${message}: ${relative(file)}`);
  }
}

function shouldSkip(name: string): boolean {
  return name === "node_modules" || name === "dist" || name === "cache";
}

function extractMarkdownLinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of content.matchAll(regex)) {
    links.push(match[1].trim());
  }
  return links;
}

function linkCandidates(file: string, target: string): string[] {
  const decoded = decodeURIComponent(target);
  const base = decoded.startsWith("/")
    ? path.join(docsRoot, decoded.slice(1))
    : path.resolve(path.dirname(file), decoded);
  const extension = path.extname(base);
  const publicBase = decoded.startsWith("/")
    ? path.join(docsRoot, "public", decoded.slice(1))
    : undefined;
  if (extension) {
    return publicBase ? [base, publicBase] : [base];
  }
  const candidates = [base, `${base}.md`, path.join(base, "index.md")];
  if (publicBase) {
    candidates.push(publicBase, `${publicBase}.md`, path.join(publicBase, "index.md"));
  }
  return candidates;
}

function isExternalLink(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}

function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "");
}

function stripInlineCode(content: string): string {
  return content.replace(/`[^`\n]*`/g, "");
}

function extractMarkdownTables(content: string): string[][] {
  const tables: string[][] = [];
  let current: string[] = [];
  for (const line of content.split("\n")) {
    if (/^\|.*\|$/.test(line.trim())) {
      current.push(line.trim());
      continue;
    }
    if (current.length > 0) {
      tables.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    tables.push(current);
  }
  return tables;
}

function hasAnyContentExample(requestBody: Record<string, unknown>): boolean {
  const content = readRecord(requestBody.content);
  return Object.values(content).some((entry) =>
    readMediaExamples(readRecord(entry)).length > 0
  );
}

function readMediaExamples(media: Record<string, unknown>): Array<[string, unknown]> {
  if (media.example !== undefined) {
    return [["example", media.example]];
  }
  return Object.entries(readRecord(media.examples))
    .flatMap(([name, exampleValue]) => {
      const example = readRecord(exampleValue).value;
      return example === undefined ? [] : [[name, example] as [string, unknown]];
    });
}

function readJsonContentExample(response: Record<string, unknown>): unknown {
  const content = readRecord(response.content);
  return readRecord(content["application/json"]).example;
}

function readAnyContentExample(response: Record<string, unknown>): {
  contentType: string | null;
  example: unknown;
} {
  const content = readRecord(response.content);
  for (const [contentType, media] of Object.entries(content)) {
    const example = readRecord(media).example;
    if (example !== undefined) return { contentType, example };
  }
  return { contentType: null, example: undefined };
}

function validateExampleShape(
  document: OpenApiDocument,
  method: string,
  apiPath: string,
  status: string,
  response: Record<string, unknown>,
  example: unknown
) {
  const schema = readRecord(
    readRecord(readRecord(response.content)["application/json"]).schema
  );
  validateSchemaValue(
    document,
    schema,
    example,
    `${method.toUpperCase()} ${apiPath} ${status}`
  );
}

function validateSchemaValue(
  document: OpenApiDocument,
  schemaInput: Record<string, unknown>,
  value: unknown,
  label: string
): void {
  const schema = resolveSchema(document, schemaInput);
  const declaredTypes = readArray(schema.type).filter(
    (item): item is string => typeof item === "string"
  );
  if (declaredTypes.length > 0) {
    const failures: string[] = [];
    for (const declaredType of declaredTypes) {
      try {
        validateSchemaValue(
          document,
          { ...schema, type: declaredType },
          value,
          label
        );
        return;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`${label} does not match any documented type: ${failures.join(" | ")}`);
  }
  const variants = [
    ...readArray(schema.anyOf),
    ...readArray(schema.oneOf)
  ].map((variant) => readRecord(variant));
  if (variants.length > 0) {
    const failures: string[] = [];
    for (const variant of variants) {
      try {
        validateSchemaValue(document, variant, value, label);
        return;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`${label} does not match any documented schema variant: ${failures.join(" | ")}`);
  }

  const type = schema.type;
  if (type === "null") {
    if (value !== null) throw new Error(`${label} must be null.`);
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${label} must be a string.`);
    validateEnum(schema, value, label);
    return;
  }
  if (type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
    validateEnum(schema, value, label);
    return;
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number.`);
    }
    validateEnum(schema, value, label);
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    const itemSchema = readRecord(schema.items);
    value.forEach((item, index) =>
      validateSchemaValue(document, itemSchema, item, `${label}[${index}]`)
    );
    return;
  }

  const properties = collectSchemaProperties(document, schema);
  if (type === "object" || properties.size > 0 || readArray(schema.allOf).length > 0) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object.`);
    }
    const record = value as Record<string, unknown>;
    const required = collectSchemaRequired(document, schema);
    for (const key of required) {
      if (!(key in record)) {
        throw new Error(`${label} is missing required field \`${key}\`.`);
      }
    }
    if (hasClosedObjectSchema(document, schema)) {
      for (const key of Object.keys(record)) {
        if (!properties.has(key)) {
          throw new Error(`${label} contains unknown field \`${key}\`.`);
        }
      }
    }
    for (const [key, propertySchema] of properties) {
      if (key in record) {
        validateSchemaValue(
          document,
          readRecord(propertySchema),
          record[key],
          `${label}.${key}`
        );
      }
    }
    return;
  }

  validateEnum(schema, value, label);
}

function validateEnum(
  schema: Record<string, unknown>,
  value: unknown,
  label: string
): void {
  const allowed = readArray(schema.enum);
  if (allowed.length > 0 && !allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.map(String).join(", ")}.`);
  }
}

function collectSchemaRequired(
  document: OpenApiDocument,
  schema: Record<string, unknown>,
  seen = new Set<Record<string, unknown>>()
): Set<string> {
  const resolved = resolveSchema(document, schema);
  if (seen.has(resolved)) return new Set();
  seen.add(resolved);
  const required = new Set(readArray(resolved.required).map(String));
  for (const item of readArray(resolved.allOf)) {
    for (const key of collectSchemaRequired(document, readRecord(item), seen)) {
      required.add(key);
    }
  }
  return required;
}

function hasClosedObjectSchema(
  document: OpenApiDocument,
  schema: Record<string, unknown>,
  seen = new Set<Record<string, unknown>>()
): boolean {
  const resolved = resolveSchema(document, schema);
  if (seen.has(resolved)) return false;
  seen.add(resolved);
  if (resolved.additionalProperties === false) return true;
  return readArray(resolved.allOf).some((item) =>
    hasClosedObjectSchema(document, readRecord(item), seen)
  );
}

function collectSchemaProperties(
  document: OpenApiDocument,
  schema: Record<string, unknown>,
  seen = new Set<Record<string, unknown>>()
): Map<string, unknown> {
  const resolved = resolveSchema(document, schema);
  const properties = new Map<string, unknown>();
  if (seen.has(resolved)) {
    return properties;
  }
  seen.add(resolved);
  for (const item of readArray(resolved.allOf)) {
    for (const [key, value] of collectSchemaProperties(document, readRecord(item), seen)) {
      properties.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(readRecord(resolved.properties))) {
    properties.set(key, value);
  }
  return properties;
}

function resolveSchema(document: OpenApiDocument, schema: Record<string, unknown>): Record<string, unknown> {
  const reference = schema.$ref;
  if (typeof reference !== "string") {
    return schema;
  }
  const schemaName = reference.replace("#/components/schemas/", "");
  return document.components.schemas[schemaName] ?? schema;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function relative(file: string): string {
  return path.relative(repoRoot, file);
}

await main();
