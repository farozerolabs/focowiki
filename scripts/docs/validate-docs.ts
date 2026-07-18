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
  await validateGuideNavigation();
  await validateDeploymentNavigation();
  await validateGeneratedOpenApiContractVersion(openApiDocument);
  await validateOpenApiLocaleCopy(openApiDocument);
  await validateOperationCoverage(openApiDocument);
  await validateOpenApiContractExamples(openApiDocument);
  await validateGeneratedOperationExamples(openApiDocument);
  await validateGeneratedOperationTables();
  await validatePublicOpenApiCopy();
  await validateMarkdownLinks(markdownFiles);
  await validateLanguageStyle(markdownFiles);
  await validateCurrentArchitectureLanguage(markdownFiles);
  await validateSensitiveContent(markdownFiles);
  validateSafeContent("Developer OpenAPI contract", JSON.stringify(openApiDocument));
  console.log("Documentation validation passed.");
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

async function validateOpenApiLocaleCopy(document: OpenApiDocument) {
  const copies = readRecord(JSON.parse(await fs.readFile(localeCopyPath, "utf8")));
  const operationIds = collectOperationIds(document);
  const tags = new Set(
    collectOperations(document).flatMap(({ operation }) =>
      readArray(operation.tags).filter((tag): tag is string => typeof tag === "string")
    )
  );

  for (const localeName of ["en-US", "zh-CN"]) {
    const copy = readRecord(copies[localeName]);
    const summaries = readRecord(copy.operationSummaries);
    const descriptions = readRecord(copy.operationDescriptions);
    const tagLabels = readRecord(copy.tagLabels);
    const missingSummaries = [...operationIds].filter((operationId) => typeof summaries[operationId] !== "string");
    const missingDescriptions = [...operationIds].filter((operationId) => typeof descriptions[operationId] !== "string");
    const staleSummaries = Object.keys(summaries).filter((operationId) => !operationIds.has(operationId));
    const staleDescriptions = Object.keys(descriptions).filter((operationId) => !operationIds.has(operationId));
    const missingTags = [...tags].filter((tag) => typeof tagLabels[tag] !== "string");

    if (
      missingSummaries.length > 0 ||
      missingDescriptions.length > 0 ||
      staleSummaries.length > 0 ||
      staleDescriptions.length > 0 ||
      missingTags.length > 0
    ) {
      throw new Error(
        [
          `Incomplete ${localeName} OpenAPI copy.`,
          missingSummaries.length > 0 ? `Missing summaries: ${missingSummaries.join(", ")}.` : "",
          missingDescriptions.length > 0 ? `Missing descriptions: ${missingDescriptions.join(", ")}.` : "",
          staleSummaries.length > 0 ? `Stale summaries: ${staleSummaries.join(", ")}.` : "",
          staleDescriptions.length > 0 ? `Stale descriptions: ${staleDescriptions.join(", ")}.` : "",
          missingTags.length > 0 ? `Missing tag labels: ${missingTags.join(", ")}.` : ""
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
  }
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
        validateExampleShape(document, method, apiPath, status, responseRecord, readRecord(contentExample.example));
        validateContractExampleContent(method, apiPath, contentExample.example);
      }
      validateSafeContent(
        `${method.toUpperCase()} ${apiPath} ${status} example`,
        JSON.stringify(contentExample.example)
      );
    }

    for (const status of ["401", "500"]) {
      const response = readRecord(responses[status]);
      const example = readJsonContentExample(response);
      if (!example) {
        throw new Error(`Missing ${status} error example for ${method.toUpperCase()} ${apiPath}.`);
      }
      validateExampleShape(document, method, apiPath, status, response, readRecord(example));
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
      ...locale.guidePages,
      ...locale.agentIntegrationPages
    ]) {
      await assertFileExists(file, `${locale.name} documentation page is missing`);
    }
    await assertFileExists(path.join(locale.operationsDir, "index.md"), `${locale.name} operation index is missing`);
  }
}

async function validateGuideNavigation() {
  const config = await fs.readFile(vitePressConfigPath, "utf8");
  assertOrderedSnippets(config, [
    'text: "Open Knowledge Format", link: "/guide/open-knowledge-format"',
    'text: "File-first Graph", link: "/guide/file-first-graph"',
    'text: "File Cleaning and Ingestion Guide", link: "/guide/file-cleaning-ingestion"'
  ], "English guide sidebar");
  assertOrderedSnippets(config, [
    'text: "Google OKF 规范", link: "/zh-CN/guide/open-knowledge-format"',
    'text: "文件优先图关系", link: "/zh-CN/guide/file-first-graph"',
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
  return Object.values(content).some((entry) => readRecord(entry).example !== undefined);
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
  example: Record<string, unknown>
) {
  const schema = resolveSchema(document, readRecord(readRecord(readRecord(response.content)["application/json"]).schema));
  const properties = collectSchemaProperties(document, schema);
  const required = readArray(schema.required).map(String);
  for (const key of Object.keys(example)) {
    if (!properties.has(key)) {
      throw new Error(`Unknown example field \`${key}\` for ${method.toUpperCase()} ${apiPath} ${status}.`);
    }
  }
  for (const key of required) {
    if (!(key in example)) {
      throw new Error(`Missing required example field \`${key}\` for ${method.toUpperCase()} ${apiPath} ${status}.`);
    }
  }
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
