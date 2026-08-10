import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  fallbackProductVersion,
  readProductReleaseVersion
} from "../../../apps/api/src/release-version.js";

const repoRoot = process.cwd();
const docsRoot = path.join(repoRoot, "docs");
const contractPath = path.join(docsRoot, "public", "openapi", "focowiki-openapi.json");
const componentPath = path.join(
  docsRoot,
  ".vitepress",
  "theme",
  "components",
  "SwaggerApiExplorer.vue"
);
const configModulePath = path.join(
  docsRoot,
  ".vitepress",
  "theme",
  "swagger-api-explorer-config.ts"
);
const searchModulePath = path.join(
  docsRoot,
  ".vitepress",
  "theme",
  "swagger-api-explorer-search.ts"
);
const explorerStylesPath = path.join(
  docsRoot,
  ".vitepress",
  "theme",
  "swagger-api-explorer.css"
);
const localizationModulePath = path.join(
  docsRoot,
  ".vitepress",
  "theme",
  "swagger-api-explorer-localization.ts"
);
const pages = [
  {
    label: "English",
    path: path.join(docsRoot, "openapi", "explorer.md"),
    route: "/openapi/explorer",
    title: "API Explorer"
  },
  {
    label: "Simplified Chinese",
    path: path.join(docsRoot, "zh-CN", "openapi", "explorer.md"),
    route: "/zh-CN/openapi/explorer",
    title: "API 交互文档"
  }
];

test("both locale routes and sidebars expose the API Explorer", async () => {
  const vitePressConfig = await fs.readFile(path.join(docsRoot, ".vitepress", "config.ts"), "utf8");

  assert.match(vitePressConfig, /rel:\s*"icon"/);
  assert.match(vitePressConfig, /href:\s*"\/logo\.svg"/);
  for (const page of pages) {
    const content = await fs.readFile(page.path, "utf8");
    assert.match(content, new RegExp(`title:\\s*${page.title}`));
    assert.match(content, /<SwaggerApiExplorer/);
    assert.match(vitePressConfig, new RegExp(`link:\\s*"${page.route}"`));
  }
});

test("the explorer is generated-contract-only and read-only", async () => {
  const moduleUrl = pathToFileURL(configModulePath).href;
  const { createSwaggerApiExplorerConfig } = (await import(moduleUrl)) as {
    createSwaggerApiExplorerConfig: (input: {
      domNode: HTMLElement;
      spec: Record<string, unknown>;
    }) => Record<string, unknown>;
  };
  const config = createSwaggerApiExplorerConfig({
    domNode: {} as HTMLElement,
    spec: { openapi: "3.1.0" }
  });

  assert.deepEqual(config.supportedSubmitMethods, []);
  assert.equal(config.persistAuthorization, false);
  assert.equal(config.validatorUrl, null);
  assert.equal(config.deepLinking, true);
  assert.equal(config.filter, false);
  assert.equal(config.docExpansion, "none");
  assert.equal(config.tryItOutEnabled, false);
  assert.equal(Array.isArray(config.plugins), true);
  const readOnlyPlugin = (
    config.plugins as Array<() => {
      components: Record<string, () => null>;
    }>
  )[0]?.();
  assert.equal(readOnlyPlugin?.components.ServersContainer(), null);
  const styles = await fs.readFile(explorerStylesPath, "utf8");
  assert.match(
    styles,
    /\.swagger-explorer-shell \.swagger-ui \.scheme-container\s*\{\s*display:\s*none/
  );
});

test("operation search covers summaries, tags, paths, methods, and operation identifiers", async () => {
  const moduleUrl = pathToFileURL(searchModulePath).href;
  const { searchSwaggerOperations } = (await import(moduleUrl)) as {
    searchSwaggerOperations: (
      spec: Record<string, unknown>,
      query: string
    ) => Array<{ operationId: string }>;
  };
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8")) as Record<string, unknown>;

  for (const query of [
    "Create a knowledge base",
    "Knowledge Bases",
    "/openapi/v2/knowledge-bases",
    "POST",
    "createKnowledgeBase"
  ]) {
    const results = searchSwaggerOperations(contract, query);
    assert.ok(
      results.some((result) => result.operationId === "createKnowledgeBase"),
      `Operation search did not find createKnowledgeBase for ${query}.`
    );
  }
});

test("the Chinese explorer localizes display copy without changing the source contract", async () => {
  const moduleUrl = pathToFileURL(localizationModulePath).href;
  const { localizeSwaggerSpec } = (await import(moduleUrl)) as {
    localizeSwaggerSpec: (
      spec: Record<string, unknown>,
      copy: Record<string, unknown>
    ) => Record<string, unknown>;
  };
  const source = JSON.parse(await fs.readFile(contractPath, "utf8")) as Record<
    string,
    unknown
  >;
  const localeCopies = JSON.parse(
    await fs.readFile(
      path.join(docsRoot, ".vitepress", "openapi-locales.json"),
      "utf8"
    )
  ) as Record<string, Record<string, unknown>>;
  const localized = localizeSwaggerSpec(source, localeCopies["zh-CN"]) as {
    tags: Array<{ name: string; description: string }>;
    paths: Record<
      string,
      Record<
        string,
        {
          summary: string;
          description: string;
          tags: string[];
          parameters: Array<{ name: string; description: string }>;
        }
      >
    >;
  };
  const searchOperation =
    localized.paths["/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search"].get;

  assert.equal(localized.tags.find((tag) => tag.name === "文件")?.description, "读取已发布文件树、正文、搜索结果和文件关系。");
  assert.equal(
    localized.tags.find((tag) => tag.name === "文件和目录变更")?.description,
    "查看文件和目录移动、替换及删除的处理进度与结果。"
  );
  assert.equal(searchOperation.summary, "搜索文件");
  assert.match(searchOperation.description, /完整自然语言问题/);
  assert.deepEqual(searchOperation.tags, ["文件"]);
  assert.match(
    searchOperation.parameters.find((parameter) => parameter.name === "query")
      ?.description ?? "",
    /完整独立的自然语言问题/
  );
  assert.equal(
    (source.tags as Array<{ name: string }>)[0]?.name,
    "Metadata",
    "Localization must not mutate the downloadable contract."
  );
});

test("documentation releases use an explicit version and local builds use a stable fallback", () => {
  assert.equal(readProductReleaseVersion({}), fallbackProductVersion);
  assert.equal(
    readProductReleaseVersion({ FOCOWIKI_RELEASE_VERSION: "1.2.3" }),
    "1.2.3"
  );
});

test("Swagger UI is exact-pinned and uses the approved open-source license", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8")
  ) as { devDependencies: Record<string, string> };
  const swaggerPackage = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, "node_modules", "swagger-ui-dist", "package.json"),
      "utf8"
    )
  ) as { version: string; license: string };

  assert.equal(packageJson.devDependencies["swagger-ui-dist"], swaggerPackage.version);
  assert.match(packageJson.devDependencies["swagger-ui-dist"], /^\d+\.\d+\.\d+$/);
  assert.equal(swaggerPackage.license, "Apache-2.0");
});

test("the component provides localized loading, failure, and contract download states", async () => {
  const component = await fs.readFile(componentPath, "utf8");

  assert.match(component, /\/openapi\/focowiki-openapi\.json/);
  assert.match(component, /locale/);
  assert.match(component, /localizeSwaggerSpec/);
  assert.match(component, /loadingText/);
  assert.match(component, /failureText/);
  assert.match(component, /downloadText/);
  assert.match(component, /aria-live="polite"/);
  assert.match(
    component,
    /import\(\s*"swagger-ui-dist\/swagger-ui-es-bundle\.js"\s*\)/
  );
  assert.match(component, /\/vendor\/swagger-ui\/swagger-ui\.css/);
  assert.match(component, /stylesheetElement\?\.remove\(\)/);
});

test("every OpenAPI operation retains one Markdown page per locale", async () => {
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const operationIds = new Set(
    Object.values(contract.paths).flatMap((pathItem) =>
      Object.values(pathItem)
        .map((operation) => operation.operationId)
        .filter((operationId): operationId is string => typeof operationId === "string")
    )
  );

  for (const operationsDir of [
    path.join(docsRoot, "openapi", "operations"),
    path.join(docsRoot, "zh-CN", "openapi", "operations")
  ]) {
    const files = (await fs.readdir(operationsDir)).filter((file) => file.endsWith(".md") && file !== "index.md");
    const pageOperationIds = new Set<string>();
    for (const file of files) {
      const content = await fs.readFile(path.join(operationsDir, file), "utf8");
      const operationId = content.match(/^operationId:\s*"([^"]+)"/m)?.[1];
      if (operationId) {
        pageOperationIds.add(operationId);
      }
    }
    assert.deepEqual(pageOperationIds, operationIds);
  }
});

test("source change operation pages explain when and how developers use them", async () => {
  const expectedDescriptions = [
    {
      path: path.join(
        docsRoot,
        "openapi",
        "operations",
        "list-resource-operations.md"
      ),
      description:
        "List file and directory changes for a knowledge base, including moves, renames, content replacements, and deletions. Results can be filtered by processing status."
    },
    {
      path: path.join(
        docsRoot,
        "openapi",
        "operations",
        "get-resource-operation.md"
      ),
      description:
        "Use the `operationId` returned by a change request to read its processing state, final result, and error details."
    },
    {
      path: path.join(
        docsRoot,
        "zh-CN",
        "openapi",
        "operations",
        "list-resource-operations.md"
      ),
      description:
        "分页查看知识库中的文件和目录变更，包括移动、重命名、替换正文和删除，并可按处理状态筛选。"
    },
    {
      path: path.join(
        docsRoot,
        "zh-CN",
        "openapi",
        "operations",
        "get-resource-operation.md"
      ),
      description:
        "使用变更接口返回的 `operationId`，查询一次文件或目录变更的处理进度、最终结果和错误信息。"
    }
  ];

  for (const item of expectedDescriptions) {
    const content = await fs.readFile(item.path, "utf8");
    assert.ok(
      content.includes(item.description),
      `${item.path} is missing its developer-facing usage description.`
    );
  }
});

test("the runtime OpenAPI contract remains behind Developer OpenAPI authentication", async () => {
  const routes = await fs.readFile(
    path.join(repoRoot, "apps", "api", "src", "developer-openapi", "routes.ts"),
    "utf8"
  );
  const authIndex = routes.indexOf('app.use("/openapi/v2/*", requireAuth)');
  const contractIndex = routes.indexOf('app.get("/openapi/v2/openapi.json"');

  assert.ok(authIndex >= 0, "Developer OpenAPI authentication middleware is missing.");
  assert.ok(contractIndex > authIndex, "The runtime contract route must remain authenticated.");
});

test("generated operation pages preserve non-JSON schemas, response headers, and search errors", async () => {
  const englishSourceContent = await fs.readFile(
    path.join(docsRoot, "openapi", "operations", "get-source-file-content.md"),
    "utf8"
  );
  const chineseSourceContent = await fs.readFile(
    path.join(docsRoot, "zh-CN", "openapi", "operations", "get-source-file-content.md"),
    "utf8"
  );
  const chineseSearch = await fs.readFile(
    path.join(docsRoot, "zh-CN", "openapi", "operations", "search-generated-files.md"),
    "utf8"
  );

  assert.match(englishSourceContent, /Schema type: `string`/);
  assert.match(englishSourceContent, /#### Response Headers/);
  assert.match(englishSourceContent, /`ETag`/);
  assert.match(chineseSourceContent, /数据结构: `string`/);
  assert.match(chineseSourceContent, /#### 响应头/);
  assert.doesNotMatch(chineseSourceContent, /Schema type:/);
  assert.match(chineseSearch, /`SEARCH_UNAVAILABLE`/);
  assert.match(chineseSearch, /`SEARCH_OVERLOADED`/);
  assert.match(chineseSearch, /`SEARCH_TIMEOUT`/);
  assert.equal(
    chineseSearch.match(/DATABASE_REPOSITORY_UNAVAILABLE/g)?.length,
    1
  );
});

test("every generated operation page lists every documented error exactly once", async () => {
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8")) as {
    paths: Record<
      string,
      Record<
        string,
        {
          operationId?: string;
          responses?: Record<
            string,
            {
              "x-error-codes"?: string[];
            }
          >;
        }
      >
    >;
  };
  const operationsById = new Map(
    Object.values(contract.paths).flatMap((pathItem) =>
      Object.values(pathItem)
        .filter((operation) => typeof operation.operationId === "string")
        .map((operation) => [operation.operationId as string, operation] as const)
    )
  );
  const defaultErrorCodeByStatus: Record<string, string> = {
    "400": "BAD_REQUEST",
    "401": "UNAUTHORIZED",
    "404": "NOT_FOUND",
    "409": "CONFLICT",
    "413": "PAYLOAD_TOO_LARGE",
    "422": "VALIDATION_ERROR",
    "429": "RATE_LIMITED",
    "500": "INTERNAL_ERROR",
    "503": "DATABASE_REPOSITORY_UNAVAILABLE",
    "504": "SEARCH_TIMEOUT"
  };

  for (const operationsDir of [
    path.join(docsRoot, "openapi", "operations"),
    path.join(docsRoot, "zh-CN", "openapi", "operations")
  ]) {
    const files = (await fs.readdir(operationsDir)).filter(
      (file) => file.endsWith(".md") && file !== "index.md"
    );
    for (const file of files) {
      const content = await fs.readFile(path.join(operationsDir, file), "utf8");
      const operationId = content.match(/^operationId:\s*"([^"]+)"/m)?.[1];
      assert.ok(operationId, `${file} is missing operationId frontmatter.`);
      const operation = operationsById.get(operationId);
      assert.ok(operation, `${file} references unknown operation ${operationId}.`);
      const expectedRows = Object.entries(operation.responses ?? {})
        .filter(([status]) => Number(status) >= 400)
        .flatMap(([status, response]) => {
          const codes = response["x-error-codes"]?.length
            ? response["x-error-codes"]
            : [defaultErrorCodeByStatus[status] ?? `HTTP_${status}`];
          return codes.map((code) => `${status} ${code}`);
        });
      const actualRows = Array.from(
        content.matchAll(/^\| (\d{3}) \| `([^`]+)` \|/gm),
        (match) => `${match[1]} ${match[2]}`
      );
      assert.deepEqual(
        actualRows,
        expectedRows,
        `${file} does not list the complete error contract for ${operationId}.`
      );
      assert.equal(
        new Set(actualRows).size,
        actualRows.length,
        `${file} contains duplicate error rows.`
      );
    }
  }
});

test("every generated operation page lists its validation detail codes exactly once", async () => {
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8")) as {
    paths: Record<
      string,
      Record<
        string,
        {
          operationId?: string;
          "x-validation-detail-codes"?: string[];
        }
      >
    >;
  };
  const validationCodesByOperationId = new Map(
    Object.values(contract.paths).flatMap((pathItem) =>
      Object.values(pathItem)
        .filter(
          (operation) =>
            typeof operation.operationId === "string"
            && (operation["x-validation-detail-codes"]?.length ?? 0) > 0
        )
        .map(
          (operation) =>
            [operation.operationId as string, operation["x-validation-detail-codes"] ?? []] as const
        )
    )
  );

  for (const operationsDir of [
    path.join(docsRoot, "openapi", "operations"),
    path.join(docsRoot, "zh-CN", "openapi", "operations")
  ]) {
    for (const file of (await fs.readdir(operationsDir)).filter((name) => name.endsWith(".md"))) {
      const content = await fs.readFile(path.join(operationsDir, file), "utf8");
      const operationId = content.match(/^operationId:\s*"([^"]+)"/m)?.[1];
      if (!operationId) continue;
      for (const code of validationCodesByOperationId.get(operationId) ?? []) {
        assert.equal(
          content.split(`\`${code}\``).length - 1,
          1,
          `${file} must list validation detail code ${code} exactly once.`
        );
      }
    }
  }
});

test("search operation pages explain every search-specific error", async () => {
  for (const operationsDir of [
    path.join(docsRoot, "openapi", "operations"),
    path.join(docsRoot, "zh-CN", "openapi", "operations")
  ]) {
    const content = await fs.readFile(
      path.join(operationsDir, "search-generated-files.md"),
      "utf8"
    );
    for (const code of [
      "DATABASE_REPOSITORY_UNAVAILABLE",
      "SEARCH_UNAVAILABLE",
      "SEARCH_OVERLOADED",
      "SEARCH_TIMEOUT"
    ]) {
      assert.equal(
        content.split(`\`${code}\``).length - 1,
        1,
        `search-generated-files.md must list ${code} exactly once.`
      );
    }
  }
});

test("generated Chinese operation pages avoid untranslated fallback descriptions", async () => {
  const operationsDir = path.join(docsRoot, "zh-CN", "openapi", "operations");
  const files = (await fs.readdir(operationsDir)).filter((file) => file.endsWith(".md"));
  const content = (
    await Promise.all(files.map((file) => fs.readFile(path.join(operationsDir, file), "utf8")))
  ).join("\n");

  assert.doesNotMatch(content, /这个接口接收或返回的字段值/);
  assert.doesNotMatch(content, /接口返回的值。/);
  assert.doesNotMatch(content, /Schema type:/);
  assert.doesNotMatch(content, /Search is temporarily unavailable/);
  assert.doesNotMatch(content, /The required data or search service is temporarily unavailable/);
  assert.doesNotMatch(content, /Search exceeded the configured response deadline/);
});

test("generated operation pages explain graph seed exclusivity", async () => {
  const englishGraph = await fs.readFile(
    path.join(docsRoot, "openapi", "operations", "expand-graph.md"),
    "utf8"
  );
  const chineseGraph = await fs.readFile(
    path.join(docsRoot, "zh-CN", "openapi", "operations", "expand-graph.md"),
    "utf8"
  );

  assert.match(englishGraph, /exactly one of fileId, nodeId, edgeId, or query/i);
  assert.match(chineseGraph, /必须提供文件、关系节点、关系边或简短查询中的一个起点/);
});

test("public OpenAPI prose avoids implementation jargon and defines public file concepts", async () => {
  const englishOperationsDir = path.join(docsRoot, "openapi", "operations");
  const chineseOperationsDir = path.join(
    docsRoot,
    "zh-CN",
    "openapi",
    "operations"
  );
  const englishOperationFiles = (await fs.readdir(englishOperationsDir)).filter(
    (file) => file.endsWith(".md")
  );
  const chineseOperationFiles = (await fs.readdir(chineseOperationsDir)).filter(
    (file) => file.endsWith(".md")
  );
  const englishContent = (
    await Promise.all([
      ...englishOperationFiles.map((file) =>
        fs.readFile(path.join(englishOperationsDir, file), "utf8")
      ),
      fs.readFile(path.join(docsRoot, "openapi", "index.md"), "utf8"),
      fs.readFile(path.join(docsRoot, "openapi", "webhook-delivery.md"), "utf8")
    ])
  ).join("\n");
  const chineseContent = (
    await Promise.all([
      ...chineseOperationFiles.map((file) =>
        fs.readFile(path.join(chineseOperationsDir, file), "utf8")
      ),
      fs.readFile(path.join(docsRoot, "zh-CN", "openapi", "index.md"), "utf8"),
      fs.readFile(
        path.join(docsRoot, "zh-CN", "openapi", "webhook-delivery.md"),
        "utf8"
      )
    ])
  ).join("\n");

  for (const phrase of [
    "database-backed read model",
    "source-backed",
    "bounded",
    "lifecycle",
    "continuation cursor",
    "revision protection",
    "safe result",
    "safe guidance"
  ]) {
    assert.doesNotMatch(
      englishContent,
      new RegExp(phrase, "i"),
      `English public documentation still contains internal phrase: ${phrase}`
    );
  }
  for (const phrase of [
    "有界",
    "生命周期",
    "不透明游标",
    "安全结果",
    "安全提示",
    "生效 generation",
    "发布范围",
    "终止状态",
    "终止失败",
    "异步来源变更"
  ]) {
    assert.doesNotMatch(
      chineseContent,
      new RegExp(phrase),
      `Chinese public documentation still contains internal phrase: ${phrase}`
    );
  }

  assert.match(
    englishContent,
    /A source file is the original Markdown file accepted by an upload or replacement request\./
  );
  assert.match(
    englishContent,
    /A generated file is a readable, published knowledge-base file produced from uploaded content or navigation data\./
  );
  assert.match(
    chineseContent,
    /来源文件是上传或替换接口接收的原始 Markdown 文件，接口使用 `sourceFileId` 标识这类已上传文件。/
  );
  assert.match(
    chineseContent,
    /生成文件是系统根据已上传内容或导航信息生成并发布的可读取知识库文件。/
  );
  assert.doesNotMatch(englishContent, /^# (?:List|Get|Move|Delete|Retry|Replace) source (?:file|directory)/im);
  assert.doesNotMatch(chineseContent, /^# (?:列出|获取|移动|删除|重试|替换)来源(?:文件|目录)/m);
});
