import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { locatedRecord, record, sortItems, walkFiles } from "./comprehensive-code-inventory.mjs";

export function buildPostgresInventory(repositoryRoot) {
  const items = [];
  const migrationRoot = path.join(repositoryRoot, "apps/api/migrations");
  for (const filePath of walkFiles(migrationRoot, (value) => value.endsWith(".sql"))) {
    const source = fs.readFileSync(filePath, "utf8");
    const relative = relativePath(repositoryRoot, filePath);
    for (const tableDefinition of parseCreateTables(source)) {
      const table = tableDefinition.table;
      items.push(record(`postgres:table:${table}`, "table", relative, {
        table,
        ownershipBoundary: "schema:focowiki",
        lifecyclePhase: `migration:${path.basename(filePath)}`
      }));
      for (const column of splitTopLevel(tableDefinition.body)) {
        const match = /^([a-z_][a-z0-9_]*)\s+([\s\S]+)$/iu.exec(column.value.trim());
        if (!match || /^(?:constraint|primary|foreign|unique|check)$/iu.test(match[1])) continue;
        items.push(locatedRecord(repositoryRoot, filePath, source, column.offset + tableDefinition.bodyOffset, "column", `${table}.${match[1]}`, {
          table,
          column: match[1],
          definition: match[2].trim(),
          ownershipBoundary: "schema:focowiki",
          lifecyclePhase: `migration:${path.basename(filePath)}`
        }));
      }
    }
    for (const match of source.matchAll(/(?:CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+)?(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)\s*\(([^)]*)\)/gimu)) {
      const name = match[1] ?? `${match[2].toLowerCase().replaceAll(" ", "-")}:${match.index}`;
      items.push(locatedRecord(repositoryRoot, filePath, source, match.index, "constraint", name, {
        constraintType: match[2].toUpperCase(),
        columns: match[3].trim()
      }));
    }
    for (const match of source.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX(?: IF NOT EXISTS)?\s+([\w.]+)\s+ON\s+([\w.]+)/gimu)) {
      items.push(locatedRecord(repositoryRoot, filePath, source, match.index, "index", match[2], {
        table: match[3],
        unique: Boolean(match[1])
      }));
    }
  }
  for (const filePath of walkFiles(path.join(repositoryRoot, "apps/api/src"), (value) => {
    return value.endsWith(".ts") && !/\.(?:test|spec)\.ts$/u.test(value);
  })) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const statement of parseCriticalPostgresStatements(source)) {
      items.push(locatedRecord(
        repositoryRoot,
        filePath,
        source,
        statement.offset,
        "critical-query-path",
        `${statement.operation}:${statement.tables.join("+")}`,
        {
        tables: statement.tables,
        operation: statement.operation,
        queryClass: statement.queryClass,
        queryFingerprint: statement.queryShape.fingerprint,
        queryAnchorFingerprint: statement.queryShape.anchorFingerprint,
        queryAnchorTokenHashes: statement.queryShape.anchorTokenHashes,
        parameterCount: statement.queryShape.parameterCount,
        statementLine: source.slice(0, statement.offset).split("\n").length,
        ownershipBoundary: "schema:focowiki",
        lifecyclePhase: "runtime"
        }
      ));
    }
  }
  return sortItems(unique(items));
}

const CRITICAL_POSTGRES_TABLES = new Set([
  "active_snapshots",
  "admin_sessions",
  "cleanup_actions",
  "embedding_artifacts",
  "generated_artifacts",
  "knowledge_bases",
  "object_owners",
  "object_registrations",
  "openapi_keys",
  "operation_work_items",
  "operations",
  "release_candidates",
  "release_roots",
  "runtime_settings_revisions",
  "search_projections",
  "security_audit_events",
  "semantic_dirty_partitions",
  "semantic_generations",
  "semantic_stage_work_items",
  "semantic_vector_documents",
  "source_file_current_revisions",
  "source_files",
  "source_revisions",
  "upload_entries",
  "upload_sessions",
  "webhook_deliveries",
  "webhook_subscriptions"
]);

function parseCriticalPostgresStatements(source) {
  const statements = [];
  for (const template of extractPostgresTaggedTemplates(source)) {
    const body = template.body;
    const tables = [...new Set([...body.matchAll(/\bfocowiki\.([a-z_][a-z0-9_]*)\b/gimu)]
      .map((item) => item[1]))].sort();
    if (tables.length === 0
      || !tables.some((table) => CRITICAL_POSTGRES_TABLES.has(table))) continue;
    const normalized = body.replace(/\s+/gu, " ").trim().toUpperCase();
    const operation = normalized.includes("INSERT INTO ")
      ? "insert"
      : normalized.includes("DELETE FROM ")
        ? "delete"
        : normalized.includes("UPDATE ")
          ? "update"
          : "read";
    statements.push({
      offset: template.offset,
      tables,
      operation,
      queryClass: classifyCriticalPostgresStatement(normalized, tables),
      queryShape: createPostgresQueryShape(body)
    });
  }
  return statements;
}

export function extractPostgresTaggedTemplates(source) {
  const sourceFile = ts.createSourceFile(
    "postgres-inventory.ts",
    String(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const templates = [];
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node) && isPostgresTag(node.tag.getText(sourceFile))) {
      const start = node.template.getStart(sourceFile);
      const end = node.template.end;
      templates.push({
        offset: node.getStart(sourceFile),
        body: source.slice(start + 1, end - 1)
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return templates.sort((left, right) => left.offset - right.offset);
}

function isPostgresTag(value) {
  const tag = String(value).replace(/<[\s\S]*>$/u, "").trim();
  return tag === "sql" || tag === "transaction";
}

export function createPostgresQueryShape(source) {
  const withoutComments = String(source)
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\n\r]*/gu, " ");
  const withoutInterpolations = replaceTemplateInterpolations(withoutComments);
  const normalized = withoutInterpolations.value
    .replace(/'(?:''|[^'])*'/gu, "$?")
    .replace(/\$\d+\b/gu, "$?")
    .replace(/\b\d+(?:\.\d+)?\b/gu, "$?")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  const anchorNormalized = normalized
    .replace(/\$\?/gu, " ")
    .replace(/[(),;]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const anchorTokens = anchorNormalized.match(
    /[a-z_][a-z0-9_.]*|"(?:[^"]|"")*"|::|<=|>=|<>|!=|=/gu
  ) ?? [];
  return {
    normalized,
    anchorNormalized,
    fingerprint: sha256(normalized),
    anchorFingerprint: sha256(anchorNormalized),
    anchorTokenHashes: anchorTokens.map(sha256),
    parameterCount: (normalized.match(/\$\?/gu) ?? []).length
  };
}

function replaceTemplateInterpolations(source) {
  let value = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "$" || source[index + 1] !== "{") {
      value += source[index];
      index += 1;
      continue;
    }
    value += "$?";
    index = templateInterpolationEnd(source, index + 2);
  }
  return { value };
}

function templateInterpolationEnd(source, start) {
  let depth = 1;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("Unclosed PostgreSQL template interpolation");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function classifyCriticalPostgresStatement(source, tables) {
  if (source.includes("SKIP LOCKED")) return "lease-claim";
  if (source.includes("ON CONFLICT")) return "idempotent-write";
  if (source.includes("ORDER BY") && source.includes("LIMIT")) return "pagination";
  if (tables.some((table) => [
    "active_snapshots",
    "release_candidates",
    "release_roots",
    "search_projections",
    "semantic_generations"
  ].includes(table))) return "activation";
  if (tables.some((table) => ["object_owners", "object_registrations"].includes(table))) {
    return "ownership";
  }
  if (tables.some((table) => [
    "operation_work_items",
    "operations",
    "semantic_stage_work_items"
  ].includes(table))) return "workflow";
  if (tables.some((table) => [
    "admin_sessions",
    "openapi_keys",
    "security_audit_events"
  ].includes(table))) return "security";
  if (tables.some((table) => [
    "cleanup_actions",
    "semantic_dirty_partitions",
    "webhook_deliveries"
  ].includes(table))) return "retention";
  return "catalog";
}

export function buildSubsystemInventories(repositoryRoot) {
  return {
    redis: exportedInventory(repositoryRoot, ["apps/api/src/redis", "apps/api/src/security/rate-limit.ts"], "redis"),
    s3: buildS3Inventory(repositoryRoot),
    opensearch: exportedInventory(repositoryRoot, ["apps/api/src/infrastructure/opensearch"], "opensearch", true),
    meilisearch: exportedInventory(repositoryRoot, ["apps/api/src/infrastructure/meilisearch"], "meilisearch", true),
    vector: exportedInventory(repositoryRoot, [
      "apps/api/src/semantic/vector",
      "apps/api/src/semantic/embedding",
      "apps/api/src/semantic/infrastructure"
    ], "vector", true),
    workers: exportedInventory(repositoryRoot, [
      "apps/api/src/source-worker-main.ts",
      "apps/api/src/publication-worker-main.ts",
      "apps/api/src/maintenance-worker-main.ts",
      "apps/api/src/redis/worker-runtime.ts",
      "apps/api/src/semantic/application/community-stage-handler.ts",
      "apps/api/src/semantic/application/community-worker.ts",
      "apps/api/src/semantic/application/embedding-stage-handler.ts",
      "apps/api/src/semantic/application/extraction-stage-handler.ts",
      "apps/api/src/semantic/application/publication-stage-handler.ts",
      "apps/api/src/semantic/application/reconciliation-stage-handler.ts",
      "apps/api/src/semantic/application/stage-concurrency.ts",
      "apps/api/src/semantic/application/stage-metrics.ts",
      "apps/api/src/semantic/application/stage-orchestration.ts",
      "apps/api/src/semantic/application/stage-ports.ts",
      "apps/api/src/semantic/application/stage-role-runtime.ts",
      "apps/api/src/semantic/application/stage-worker.ts",
      "apps/api/src/semantic/application/vector-stage-handler.ts",
      "apps/api/src/semantic/graphrag/source-worker-runtime.ts",
      "apps/api/src/semantic/infrastructure/postgres-publication-coalescing-readiness.ts",
      "apps/api/src/semantic/infrastructure/postgres-publication-readiness.ts",
      "apps/api/src/semantic/infrastructure/postgres-stage-repository.ts",
      "apps/api/src/semantic/infrastructure/postgres-stage-source-ownership.ts",
      "apps/api/src/semantic/infrastructure/source-stage-production-runtime.ts",
      "apps/api/src/storage-vnext/source-processing/production-runtime.ts",
      "apps/api/src/storage-vnext/source-processing/worker.ts",
      "apps/api/src/storage-vnext/publication/processor.ts",
      "apps/api/src/storage-vnext/publication/production-runtime.ts",
      "apps/api/src/storage-vnext/publication/role-runtime.ts",
      "apps/api/src/storage-vnext/publication/worker.ts",
      "apps/api/src/storage-vnext/maintenance/automatic-scheduler.ts",
      "apps/api/src/storage-vnext/maintenance/candidate-object-cleanup-worker.ts",
      "apps/api/src/storage-vnext/maintenance/maintenance-coordinator.ts",
      "apps/api/src/storage-vnext/maintenance/phase-runner.ts",
      "apps/api/src/storage-vnext/maintenance/postgres-due.ts",
      "apps/api/src/storage-vnext/maintenance/postgres-repository.ts",
      "apps/api/src/storage-vnext/maintenance/production-runtime.ts",
      "apps/api/src/storage-vnext/maintenance/status.ts",
      "apps/api/src/storage-vnext/deletion/deletion-worker.ts",
      "apps/api/src/storage-vnext/search/provider-index-cleanup-worker.ts",
      "apps/api/src/storage-vnext/webhook/worker.ts",
      "apps/api/src/storage-vnext/workflow/postgres-contract.ts",
      "apps/api/src/storage-vnext/workflow/postgres-repository.ts",
      "apps/api/src/dispatch"
    ], "worker", true),
    generated: exportedInventory(repositoryRoot, [
      "apps/api/src/okf",
      "apps/api/src/publication",
      "apps/api/src/public-generated-path.ts",
      "apps/api/src/tree-entry-filters.ts"
    ], "generated", true)
  };
}

function buildS3Inventory(repositoryRoot) {
  const contractRoots = [
    "apps/api/src/storage",
    "apps/api/src/application/ports/immutable-object-repository.ts",
    "apps/api/src/application/ports/immutable-object-lock.ts",
    "apps/api/src/application/ports/generation-object-reference-repository.ts"
  ];
  const directS3Sources = walkFiles(
    path.join(repositoryRoot, "apps/api/src"),
    (value) => value.endsWith(".ts")
  ).filter((filePath) => fs.readFileSync(filePath, "utf8")
    .includes('from "@aws-sdk/client-s3"'))
    .map((filePath) => relativePath(repositoryRoot, filePath));
  return sortItems(unique(exportedInventory(
    repositoryRoot,
    [...contractRoots, ...directS3Sources],
    "s3"
  )));
}

export function buildDockerInventory(repositoryRoot) {
  const items = [];
  for (const relative of [
    "docker-compose.yml.example",
    "docker-compose.dev.yml.example",
    "docker-compose.local.yml.example"
  ]) {
    const source = fs.readFileSync(path.join(repositoryRoot, relative), "utf8");
    let inServices = false;
    for (const [index, line] of source.split("\n").entries()) {
      if (line === "services:") {
        inServices = true;
        continue;
      }
      if (inServices && /^\S/u.test(line) && line.trim()) inServices = false;
      const service = inServices ? /^  ([a-zA-Z0-9_-]+):\s*$/u.exec(line)?.[1] : null;
      if (service) items.push(record(`docker:service:${relative}:${service}`, "service", relative, { line: index + 1, service }));
      const profile = /^\s+profiles:\s*\[([^\]]+)\]/u.exec(line)?.[1];
      if (profile) items.push(record(`docker:profile:${relative}:${index + 1}:${profile}`, "profile", relative, { line: index + 1, value: profile }));
      if (/healthcheck:/u.test(line)) items.push(record(`docker:health:${relative}:${index + 1}`, "healthcheck", relative, { line: index + 1 }));
      if (/^\s+secrets:/u.test(line)) items.push(record(`docker:secret:${relative}:${index + 1}`, "secret", relative, { line: index + 1 }));
      for (const match of line.matchAll(/\$\{([A-Z][A-Z0-9_]+)/gu)) {
        items.push(record(`docker:environment:${relative}:${match[1]}`, "environment", relative, { line: index + 1, name: match[1] }));
      }
    }
  }
  return sortItems(unique(items));
}

export function buildDocsInventory(repositoryRoot) {
  return walkFiles(path.join(repositoryRoot, "docs"), (value) => value.endsWith(".md"))
    .filter((filePath) => !filePath.includes(`${path.sep}.vitepress${path.sep}dist${path.sep}`))
    .map((filePath) => {
      const relative = relativePath(repositoryRoot, filePath);
      const locale = relative.startsWith("docs/zh-CN/") ? "zh-CN" : "en";
      return record(`docs:page:${locale}:${relative}`, "page", relative, { locale });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function exportedInventory(repositoryRoot, relativeRoots, category, includeFields = false) {
  const items = [];
  for (const relativeRoot of relativeRoots) {
    const absoluteRoot = path.join(repositoryRoot, relativeRoot);
    const files = fs.existsSync(absoluteRoot) && fs.statSync(absoluteRoot).isDirectory()
      ? walkFiles(absoluteRoot, (value) => value.endsWith(".ts"))
      : fs.existsSync(absoluteRoot) ? [absoluteRoot] : [];
    for (const filePath of files) {
      const source = fs.readFileSync(filePath, "utf8");
      const relative = relativePath(repositoryRoot, filePath);
      items.push(record(`${category}:source:${relative}`, "source", relative));
      for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|type|interface)\s+([A-Za-z_$][\w$]*)/gmu)) {
        items.push(locatedRecord(repositoryRoot, filePath, source, match.index, `${category}-symbol`, match[1]));
      }
      if (includeFields) {
        if (category !== "worker") {
          for (const match of source.matchAll(/^[ \t]{2,}([a-z][A-Za-z0-9_]*)\??:\s*[^=]/gmu)) {
            items.push(locatedRecord(repositoryRoot, filePath, source, match.index, `${category}-field`, match[1]));
          }
        }
        const values = category === "worker"
          ? "source|upload|mutation|publication|deletion|search|maintenance|reconciliation|cleanup|extraction|embedding|community|vector|validation|projection_repair|lexical_rebuild|webhook"
          : "content|entity|relationship|community|file|graph|hybrid";
        for (const match of source.matchAll(new RegExp(`["'](${values})["']`, "gmu"))) {
          items.push(locatedRecord(repositoryRoot, filePath, source, match.index, `${category}-value`, match[1]));
        }
      }
    }
  }
  return sortItems(unique(items));
}

function unique(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function relativePath(repositoryRoot, filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function parseCreateTables(source) {
  const definitions = [];
  for (const match of source.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([\w.]+)\s*\(/gimu)) {
    if (source[match.index - 1] === "'") continue;
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closeIndex = findMatchingParenthesis(source, openIndex);
    if (closeIndex < 0) throw new Error(`Unclosed CREATE TABLE definition for ${match[1]}`);
    definitions.push({
      table: match[1],
      body: source.slice(openIndex + 1, closeIndex),
      bodyOffset: openIndex + 1
    });
  }
  return definitions;
}

function findMatchingParenthesis(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(body) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === quote && body[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if ((character === "," && depth === 0) || index === body.length) {
      parts.push({ value: body.slice(start, index), offset: start });
      start = index + 1;
    }
  }
  return parts;
}
