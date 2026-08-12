import fs from "node:fs";
import path from "node:path";

import { buildDeveloperOpenApiInventory } from "./comprehensive-openapi-inventory.mjs";
import { createOpenApiRuntimeResponseValidator } from "./openapi-runtime-response-validator.mjs";

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);
const EVIDENCE_FILES = Object.freeze({
  lifecycle: "developer-openapi-43-operation-lifecycle-after-security-fixes.json",
  security: "developer-openapi-security-after-proxy-fix.json",
  boundaries: "developer-openapi-field-boundaries.json",
  rateLimit: "developer-openapi-rate-limit-sweep.json",
  host: "production-host-sweep.json"
});

export function buildOpenApiDocumentationReview(input) {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const document = input.document;
  const inventory = buildDeveloperOpenApiInventory(document);
  const operations = collectOperations(document);
  const evidence = input.evidence ?? readEvidence(input.evidenceDirectory);
  const explorer = readExplorerState(repositoryRoot, document, operations);
  const validator = createOpenApiRuntimeResponseValidator(document);
  const failures = [];
  const pages = [];
  const reviewedOperations = [];

  for (const operation of operations) {
    const operationInventory = inventory.filter((item) => item.operationId === operation.operationId);
    const evidenceState = reviewOperationEvidence(operation, operationInventory, evidence);
    for (const [name, passed] of Object.entries(evidenceState)) {
      if (!passed) {
        failures.push({
          id: `evidence:${operation.operationId}:${name}`,
          message: `${operation.operationId} is missing passing ${name} evidence.`
        });
      }
    }
    const exampleFailures = validateOperationExamples(document, operation, validator);
    failures.push(...exampleFailures);
    reviewedOperations.push({
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      parameterCount: operationInventory.filter((item) => item.kind === "parameter").length,
      requestFieldCount: operationInventory.filter((item) => item.kind === "request-field").length,
      responseFieldCount: operationInventory.filter((item) => item.kind === "response-field").length,
      responseStatuses: operationInventory
        .filter((item) => item.kind === "response-status")
        .map((item) => item.status),
      responseHeaderCount: operationInventory.filter((item) => item.kind === "response-header").length,
      exampleCount: operationInventory.filter((item) => item.kind === "example").length,
      exampleValidated: exampleFailures.length === 0,
      explorerPresent: explorer.operationIds.has(operation.operationId),
      ...evidenceState
    });

    for (const locale of ["en", "zh-CN"]) {
      const page = reviewOperationPage({
        repositoryRoot,
        operation,
        operationInventory,
        locale
      });
      pages.push(page);
      failures.push(...page.failures);
    }
  }

  if (!explorer.contractReferenced) {
    failures.push({ id: "explorer:contract", message: "Swagger Explorer does not load the exported contract." });
  }
  if (!explorer.readOnly) {
    failures.push({ id: "explorer:read-only", message: "Swagger Explorer is not configured as read-only." });
  }
  for (const operation of reviewedOperations) {
    if (!operation.explorerPresent) {
      failures.push({
        id: `explorer:${operation.operationId}`,
        message: `${operation.operationId} is missing from the Explorer contract.`
      });
    }
  }

  const pageByOperationLocale = new Map(
    pages.map((page) => [`${page.operationId}:${page.locale}`, page])
  );
  const responseItems = inventory
    .filter((item) => ["response-field", "response-header", "response-status"].includes(item.kind))
    .map((item) => {
      const englishPage = pageByOperationLocale.get(`${item.operationId}:en`);
      const chinesePage = pageByOperationLocale.get(`${item.operationId}:zh-CN`);
      return {
        ...item,
        contractPresent: true,
        explorerPresent: explorer.operationIds.has(item.operationId),
        englishRepresentation: responseItemRepresentation(item, englishPage?.content ?? ""),
        chineseRepresentation: responseItemRepresentation(item, chinesePage?.content ?? "")
      };
    });

  return {
    kind: "focowiki-comprehensive-openapi-documentation-review",
    version: 1,
    ok: failures.length === 0,
    operationCount: operations.length,
    inventoryCount: inventory.length,
    operations: reviewedOperations,
    pages: pages.map(({ content, failures: pageFailures, ...page }) => ({
      ...page,
      failureCount: pageFailures.length
    })),
    responseItems,
    explorerEntries: operations.map((operation) => ({
      operationId: operation.operationId,
      present: explorer.operationIds.has(operation.operationId)
    })),
    failures
  };
}

function reviewOperationPage(input) {
  const slug = toKebabCase(input.operation.operationId);
  const relativePath = input.locale === "en"
    ? `docs/openapi/operations/${slug}.md`
    : `docs/zh-CN/openapi/operations/${slug}.md`;
  const absolutePath = path.join(input.repositoryRoot, relativePath);
  const failures = [];
  if (!fs.existsSync(absolutePath)) {
    return {
      operationId: input.operation.operationId,
      locale: input.locale,
      source: relativePath,
      title: null,
      byteLength: 0,
      parameterCount: 0,
      responseStatusCount: 0,
      responseHeaderCount: 0,
      content: "",
      failures: [{
        id: `documentation:${input.operation.operationId}:${input.locale}:missing`,
        message: `${relativePath} is missing.`
      }]
    };
  }
  const content = fs.readFileSync(absolutePath, "utf8");
  const frontmatter = readFrontmatter(content);
  const expectedFrontmatter = {
    operationId: input.operation.operationId,
    method: input.operation.method,
    path: input.operation.path
  };
  const frontmatterValid = Object.entries(expectedFrontmatter).every(
    ([key, value]) => frontmatter[key] === value
  ) && Boolean(frontmatter.title);
  if (!frontmatterValid) {
    failures.push({
      id: `documentation:${input.operation.operationId}:${input.locale}:frontmatter`,
      message: `${relativePath} frontmatter does not match the exported operation.`
    });
  }
  const descriptionHeading = input.locale === "en" ? "Interface Description" : "接口说明";
  if (!readHeadingBody(content, descriptionHeading)) {
    failures.push({
      id: `documentation:${input.operation.operationId}:${input.locale}:description`,
      message: `${relativePath} has no operation description.`
    });
  }
  for (const item of input.operationInventory.filter((candidate) => candidate.kind === "parameter")) {
    if (!content.includes(`\`${item.name}\``)) {
      failures.push({
        id: `documentation:${input.operation.operationId}:${input.locale}:parameter:${item.name}`,
        message: `${relativePath} does not document parameter ${item.name}.`
      });
    }
  }
  for (const item of input.operationInventory.filter((candidate) => candidate.kind === "response-status")) {
    if (!containsResponseStatus(content, item.status)) {
      failures.push({
        id: `documentation:${input.operation.operationId}:${input.locale}:response:${item.status}`,
        message: `${relativePath} does not document response status ${item.status}.`
      });
    }
  }
  for (const item of input.operationInventory.filter((candidate) => candidate.kind === "response-header")) {
    if (!content.includes(`\`${item.name}\``)) {
      failures.push({
        id: `documentation:${input.operation.operationId}:${input.locale}:header:${item.status}:${item.name}`,
        message: `${relativePath} does not document response header ${item.name}.`
      });
    }
  }
  for (const item of input.operationInventory.filter(isTopLevelSuccessResponseField)) {
    if (responseItemRepresentation(item, content) !== "explicit") {
      failures.push({
        id: `documentation:${input.operation.operationId}:${input.locale}:field:${item.pointer}`,
        message: `${relativePath} does not document top-level success field ${item.pointer}.`
      });
    }
  }
  return {
    operationId: input.operation.operationId,
    locale: input.locale,
    source: relativePath,
    title: frontmatter.title ?? null,
    byteLength: Buffer.byteLength(content),
    parameterCount: input.operationInventory.filter((item) => item.kind === "parameter").length,
    responseStatusCount: input.operationInventory.filter((item) => item.kind === "response-status").length,
    responseHeaderCount: input.operationInventory.filter((item) => item.kind === "response-header").length,
    content,
    failures
  };
}

function reviewOperationEvidence(operation, operationInventory, evidence) {
  const lifecycle = evidence.lifecycle?.operationCoverage?.operations?.find(
    (item) => item.operationId === operation.operationId
  );
  const requestSurfaceCount = operationInventory.filter((item) =>
    ["parameter", "parameter-field", "request-field"].includes(item.kind)
  ).length;
  const boundaryRows = evidence.boundaries?.rows?.filter(
    (item) => item.operationId === operation.operationId && item.pass === true
  ) ?? [];
  return {
    lifecycleVerified: evidence.lifecycle?.ok === true
      && lifecycle?.authenticationVerified === true
      && lifecycle?.businessPathVerified === true,
    securityVerified: evidence.security?.ok === true
      && evidence.security?.rows?.some(
        (item) => item.operationId === operation.operationId && item.pass === true
      ) === true,
    boundaryVerified: evidence.boundaries?.ok === true
      && (requestSurfaceCount === 0 || boundaryRows.length > 0)
      && (evidence.boundaries?.coverage?.missing?.length ?? 0) === 0,
    rateLimitVerified: evidence.rateLimit?.ok === true
      && evidence.rateLimit?.rows?.some(
        (item) => item.operationId === operation.operationId
          && item.case === "rate-limited"
          && item.pass === true
      ) === true,
    hostVerified: evidence.host?.ok === true
      && evidence.host?.rows?.some(
        (item) => item.surface === "developer-openapi"
          && item.itemId === operation.operationId
          && item.case === "unexpected-host"
          && item.pass === true
      ) === true
  };
}

function validateOperationExamples(document, operation, validator) {
  const failures = [];
  for (const [status, response] of Object.entries(operation.operation.responses ?? {})) {
    for (const [mediaType, media] of Object.entries(response?.content ?? {})) {
      for (const [exampleName, example] of readExamples(media)) {
        try {
          validator.validate({
            method: operation.method,
            pathname: concretePath(operation.path),
            status: Number(status),
            contentType: mediaType,
            body: example
          });
        } catch (error) {
          failures.push({
            id: `example:${operation.operationId}:${status}:${mediaType}:${exampleName}`,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }
  return failures;
}

function responseItemRepresentation(item, content) {
  if (item.kind === "response-status") {
    return containsResponseStatus(content, item.status) ? "explicit" : "missing";
  }
  if (item.kind === "response-header") {
    return content.includes(`\`${item.name}\``) ? "explicit" : "missing";
  }
  const field = responseFieldName(item.pointer);
  if (!field) return "schema-root";
  if (content.includes(`\`${field}\``) || content.includes(`\"${field}\"`)) {
    return "explicit";
  }
  if (!String(item.pointer).startsWith("response.2")) {
    return containsResponseStatus(content, String(item.pointer).split(".")[1])
      ? "shared-error-envelope"
      : "missing";
  }
  return "contract-explorer";
}

function isTopLevelSuccessResponseField(item) {
  if (item.kind !== "response-field" || !String(item.pointer).startsWith("response.2")) return false;
  const segments = String(item.pointer).split(".");
  if (segments.length !== 4) return false;
  const field = responseFieldName(item.pointer);
  return Boolean(field) && !field.startsWith("variant-");
}

function responseFieldName(pointer) {
  const segment = String(pointer).split(".").at(-1)?.replace(/\[\]$/u, "") ?? "";
  if (!segment || segment.includes("/") || /^variant-\d+$/u.test(segment)) return null;
  return segment;
}

function containsResponseStatus(content, status) {
  return new RegExp(`(?:^###\\s+${escapeRegularExpression(status)}\\s*$|^\\|\\s*${escapeRegularExpression(status)}\\s*\\|)`, "mu")
    .test(content);
}

function readExplorerState(repositoryRoot, document, operations) {
  const componentPath = path.join(
    repositoryRoot,
    "docs/.vitepress/theme/components/SwaggerApiExplorer.vue"
  );
  const content = fs.existsSync(componentPath) ? fs.readFileSync(componentPath, "utf8") : "";
  const operationIds = new Set(operations
    .filter((operation) => document.paths?.[operation.path]?.[operation.method.toLowerCase()]?.operationId)
    .map((operation) => operation.operationId));
  return {
    contractReferenced: content.includes("/openapi/focowiki-openapi.json"),
    readOnly: content.includes("createSwaggerApiExplorerConfig"),
    operationIds
  };
}

function readEvidence(evidenceDirectory) {
  if (!evidenceDirectory) throw new Error("OpenAPI documentation review evidence is required.");
  return Object.fromEntries(Object.entries(EVIDENCE_FILES).map(([key, file]) => {
    const target = path.join(path.resolve(evidenceDirectory), file);
    return [key, JSON.parse(fs.readFileSync(target, "utf8"))];
  }));
}

function collectOperations(document) {
  return Object.entries(document?.paths ?? {}).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem ?? {}).flatMap(([method, operation]) =>
      HTTP_METHODS.has(method) && operation?.operationId
        ? [{
            operationId: operation.operationId,
            method: method.toUpperCase(),
            path: routePath,
            operation
          }]
        : []
    )
  ).sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function readExamples(media) {
  if (media?.example !== undefined) return [["example", media.example]];
  return Object.entries(media?.examples ?? {}).flatMap(([name, value]) =>
    value?.value === undefined ? [] : [[name, value.value]]
  );
}

function concretePath(routePath) {
  return routePath.replace(/\{[^}]+\}/gu, "example");
}

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/u);
  if (!match) return {};
  return Object.fromEntries(match[1].split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator < 0) return [];
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/gu, "");
    return [[key, value]];
  }));
}

function readHeadingBody(content, heading) {
  const headingMatch = new RegExp(
    `^##\\s+${escapeRegularExpression(heading)}\\s*$`,
    "mu"
  ).exec(content);
  if (!headingMatch) return "";
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const nextHeading = content.indexOf("\n## ", bodyStart);
  return content.slice(bodyStart, nextHeading < 0 ? undefined : nextHeading).trim();
}

function toKebabCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
