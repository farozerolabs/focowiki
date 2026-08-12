import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export function buildAdminApiInventory(repositoryRoot) {
  const apiRoot = path.join(repositoryRoot, "apps/api/src");
  const uiRoot = path.join(repositoryRoot, "apps/admin/src");
  const items = [];

  for (const filePath of walkFiles(apiRoot, (value) => value.endsWith(".ts"))) {
    const source = fs.readFileSync(filePath, "utf8");
    if (!source.includes("/admin/api") && !filePath.includes(`${path.sep}admin${path.sep}`)) continue;
    const relative = relativePath(repositoryRoot, filePath);
    const constants = readStringConstants(source);
    const routePattern = /app\.(get|post|put|patch|delete)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))/gmu;
    for (const match of source.matchAll(routePattern)) {
      const method = match[1].toUpperCase();
      const rawPath = match[2] ?? match[3] ?? match[4] ?? constants.get(match[5]) ?? match[5];
      const routePath = resolveTemplate(rawPath, constants);
      add(items, record(`admin-api:route:${method}:${routePath}`, "route", relative, {
        method,
        path: routePath,
        authentication: routeWindow(source, match.index).includes("requireAuth"),
        writeProtection: routeWindow(source, match.index).includes("requireWriteProtection")
      }));
    }

    for (const match of source.matchAll(/context\.req\.(query|param|header)\(\s*["']([^"']+)["']\s*\)/gmu)) {
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "request-field", `${match[1]}:${match[2]}`));
    }
    for (const match of source.matchAll(/\bbody\.([A-Za-z_$][\w$]*)/gmu)) {
      if (match[1] === "trim") continue;
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "body-field", match[1]));
    }
    for (const match of source.matchAll(/\bcode:\s*["']([A-Z][A-Z0-9_]+)["']/gmu)) {
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "error", match[1]));
    }
    for (const match of source.matchAll(/\b(requireAuth|requireWriteProtection|limitLogin|limitOpenApi|trustedOrigin|allowedHost)\b/gmu)) {
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "security-rule", match[1]));
    }
  }

  for (const filePath of walkFiles(uiRoot, (value) => value.endsWith(".ts") || value.endsWith(".tsx"))) {
    if (filePath.includes(`${path.sep}components${path.sep}ui${path.sep}`)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const consumer of buildUiApiConsumers({
      repositoryRoot,
      filePath,
      source
    })) {
      add(items, consumer);
    }
  }

  return sortItems(items);
}

export function buildAdminUiInventory(repositoryRoot) {
  const uiRoot = path.join(repositoryRoot, "apps/admin/src");
  const items = [];
  const interactiveTag = /^(?:Button|button|Input|input|Select|SelectTrigger|Checkbox|Textarea|textarea|Dialog|AlertDialog|DropdownMenuItem|TabsTrigger|Pagination|SidebarTrigger|CollapsibleTrigger|TableHead|a)$/u;
  const displayTag = /^(?:Card|CardTitle|CardDescription|Table|TableHeader|TableBody|TableRow|TableCell|Alert|AlertTitle|AlertDescription|DialogTitle|DialogDescription|Skeleton|Badge|Toast)$/u;

  for (const filePath of walkFiles(uiRoot, (value) => value.endsWith(".tsx"))) {
    if (filePath.includes(`${path.sep}components${path.sep}ui${path.sep}`)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/<([A-Za-z][\w.]*)\b/gmu)) {
      if (interactiveTag.test(match[1])) {
        add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "control", match[1]));
      } else if (displayTag.test(match[1])) {
        add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "display", match[1]));
      }
    }
    for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']/gmu)) {
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "i18n", match[1]));
    }
    for (const match of source.matchAll(/const\s+\[([A-Za-z_$][\w$]*),\s*set[A-Za-z_$][\w$]*\]\s*=\s*useState/gmu)) {
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "state", match[1]));
    }
    for (const match of source.matchAll(/(?:aria-label|data-testid|placeholder)=\{?(["'][^"']+["']|t\([^\n]+\))/gmu)) {
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "accessibility", match[1]));
    }
  }

  for (const filePath of walkFiles(uiRoot, (value) => value.endsWith(".ts") || value.endsWith(".tsx"))) {
    if (filePath.includes(`${path.sep}components${path.sep}ui${path.sep}`)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    if (!/navigate|navigation|pathname|page|section/iu.test(source)) continue;
    add(items, record(`admin-ui:route-source:${relativePath(repositoryRoot, filePath)}`, "route-source", relativePath(repositoryRoot, filePath)));
  }
  return sortItems(items);
}

export function buildConfigurationInventory(repositoryRoot) {
  const items = [];
  const definitionFiles = [
    ".env.example",
    ".env.dev.example",
    "docker-compose.yml.example",
    "docker-compose.dev.yml.example",
    "docker-compose.local.yml.example"
  ];
  const productionSources = ["apps/api/src", "apps/admin/src"].flatMap((root) =>
    walkFiles(path.join(repositoryRoot, root), (value) => /\.(?:ts|tsx)$/u.test(value))
  );
  const productionText = productionSources.map((filePath) => fs.readFileSync(filePath, "utf8"));
  const envNames = new Set();

  for (const relative of definitionFiles) {
    const filePath = path.join(repositoryRoot, relative);
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/^(?:#\s*)?([A-Z][A-Z0-9_]+)=|\$\{([A-Z][A-Z0-9_]+)/gmu)) {
      const name = match[1] ?? match[2];
      envNames.add(name);
      add(items, record(`configuration:environment:${name}:${relative}`, "environment-field", relative, {
        name,
        consumerCount: 0
      }));
    }
  }
  for (const name of envNames) {
    const consumerCount = productionText.reduce((count, source) => count + countOccurrences(source, name), 0);
    add(items, record(`configuration:consumer:${name}`, "environment-consumer", "apps/", {
      name,
      consumerCount
    }));
  }

  const settingFiles = [
    "apps/api/src/config.ts",
    "apps/api/src/runtime-settings/types.ts",
    "apps/api/src/runtime-settings/revision-document.ts",
    "apps/api/src/semantic/embedding/configuration.ts",
    "apps/api/src/semantic/reranker/configuration.ts",
    "apps/admin/src/lib/admin-api.ts",
    "apps/admin/src/components/settings-panel.tsx",
    "apps/admin/src/components/embedding-settings-panel.tsx",
    "apps/admin/src/components/reranker-settings-panel.tsx"
  ].map((relative) => path.join(repositoryRoot, relative));
  for (const filePath of settingFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/^\s{2,}([a-z][A-Za-z0-9]*)\??:\s*[^=]/gmu)) {
      add(items, locatedRecord(repositoryRoot, filePath, source, match.index, "runtime-field", match[1], {
        consumerCount: productionText.reduce((count, value) => count + countOccurrences(value, match[1]), 0)
      }));
    }
  }
  return sortItems(items);
}

export function walkFiles(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(fullPath)) files.push(fullPath);
  }
  return files.sort();
}

export function record(id, kind, source, details = {}) {
  return { id, kind, source, manualRequired: true, ...details };
}

export function locatedRecord(repositoryRoot, filePath, source, index, kind, name, details = {}) {
  const relative = relativePath(repositoryRoot, filePath);
  const line = source.slice(0, index).split("\n").length;
  return record(`${kind}:${relative}:${line}:${name}`, kind, relative, { line, name, ...details });
}

export function sortItems(items) {
  return items.sort((left, right) => left.id.localeCompare(right.id));
}

function add(items, item) {
  if (!items.some((existing) => existing.id === item.id)) items.push(item);
}

function relativePath(repositoryRoot, filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function readStringConstants(source) {
  return new Map([...source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`]+)["'`]/gmu)]
    .map((match) => [match[1], match[2]]));
}

function resolveTemplate(value, constants) {
  return String(value).replace(/\$\{([A-Za-z_$][\w$]*)\}/gu, (_, name) => constants.get(name) ?? `:${name}`);
}

function routeWindow(source, index) {
  return source.slice(index, index + 800);
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function buildUiApiConsumers({ repositoryRoot, filePath, source }) {
  const relative = relativePath(repositoryRoot, filePath);
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const consumers = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const consumer = uiConsumerFromCall({ node, sourceFile, relative });
      if (consumer) consumers.push(consumer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return consumers;
}

function uiConsumerFromCall({ node, sourceFile, relative }) {
  const callName = expressionName(node.expression);
  const supported = new Set([
    "adminFetch",
    "fetch",
    "updateRuntimeSettings",
    "writeEmbeddingConfiguration",
    "writeRerankerConfiguration",
    "uploadSessionJsonRequest"
  ]);
  if (!supported.has(callName) || node.arguments.length === 0) return null;
  const pathValue = evaluateAdminPath(node.arguments[0]);
  if (!pathValue?.startsWith("/admin/api")) return null;
  const method = methodFromCall(node, callName);
  if (!method) return null;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return record(
    `ui-consumer:${relative}:${line}:${method}:${pathValue}`,
    "ui-consumer",
    relative,
    {
      line,
      name: pathValue,
      method,
      manualRequired: true
    }
  );
}

function methodFromCall(node, callName) {
  if (callName === "updateRuntimeSettings") return "PUT";
  if (callName === "writeEmbeddingConfiguration" || callName === "writeRerankerConfiguration") {
    return stringValue(node.arguments[1]);
  }
  const init = callName === "fetch" || callName === "adminFetch"
    || callName === "uploadSessionJsonRequest"
    ? node.arguments[1]
    : null;
  if (!init) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return null;
  const property = init.properties.find((item) =>
    ts.isPropertyAssignment(item) && propertyName(item.name) === "method");
  return property && ts.isPropertyAssignment(property)
    ? stringValue(property.initializer)
    : "GET";
}

function evaluateAdminPath(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) =>
      `${evaluatePathSegment(span.expression)}${span.literal.text}`).join("");
  }
  if (ts.isCallExpression(node)) {
    const name = expressionName(node.expression);
    if (name === "adminApiUrl") return evaluateAdminPath(node.arguments[0]);
    if (name === "uploadSessionBasePath") {
      return "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions";
    }
    if (name === "uploadSessionPath") {
      const action = node.arguments[1] ? evaluatePathSegment(node.arguments[1]) : null;
      return "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId"
        + (action ? `/${action}` : "");
    }
  }
  return null;
}

function evaluatePathSegment(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) =>
      `${evaluatePathSegment(span.expression)}${span.literal.text}`).join("");
  }
  if (ts.isConditionalExpression(node)) {
    return evaluatePathSegment(node.whenTrue) || evaluatePathSegment(node.whenFalse);
  }
  if (ts.isCallExpression(node)) {
    const pathValue = evaluateAdminPath(node);
    if (pathValue) return pathValue;
    return ":dynamic";
  }
  if (ts.isBinaryExpression(node)) {
    return `${evaluatePathSegment(node.left)}${evaluatePathSegment(node.right)}`;
  }
  return ":dynamic";
}

function expressionName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return "";
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return "";
}

function stringValue(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}
