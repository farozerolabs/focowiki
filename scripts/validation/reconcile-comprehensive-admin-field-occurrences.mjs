import fs from "node:fs";
import path from "node:path";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";
import {
  adminFieldCaseKindFromEvidenceId,
  enumerateRequiredAdminFieldCases,
  locateAdminFieldRoute
} from "./lib/comprehensive-admin-field-matrix.mjs";

const OCCURRENCE_ROUTES = Object.freeze({
  "knowledge-bases": "GET:/admin/api/knowledge-bases",
  "file-tree": "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/tree",
  "file-tree-search": "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/tree/search",
  "openapi-keys": "GET:/admin/api/openapi-keys",
  "source-files": "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
  "source-file-detail": "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
  "generated-read": "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
  "generated-delete": "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
  operations: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/operations",
  "source-directories": "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories",
  "upload-session": "GET:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId"
});

const repositoryRoot = process.cwd();
const evidenceDirectory = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY
    || "ReferenceDocs/validation/comprehensive-large-scale-release"
);
const boundaryName = process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_FIELD_SOURCE
  || "admin-api-field-boundaries-expanded.json";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_FIELD_OCCURRENCE_REPORT
    || path.join(evidenceDirectory, "admin-api-field-occurrence-reconciliation.json")
);
const boundary = readJson(path.join(evidenceDirectory, boundaryName));
if (boundary.ok !== true) throw new Error(`${boundaryName} is not green.`);

const fields = buildAdminApiInventory(repositoryRoot).filter((item) =>
  item.kind === "request-field" || item.kind === "body-field");
const evidence = boundary.rows.map((row) => ({
  id: `boundary:${row.id}`,
  row,
  routeId: row.routeId ?? boundaryRouteId(row.id),
  fieldNames: [
    ...(Array.isArray(row.covers) ? row.covers : []),
    ...(typeof row.bodyField === "string" ? [row.bodyField] : [])
  ]
}));

const rows = fields.map((field, index) => {
  const routeId = fieldRouteId(field);
  const requiredCases = enumerateRequiredAdminFieldCases(field, { routeId });
  const matched = evidence.filter((item) =>
    item.fieldNames.includes(field.name)
    && evidenceAppliesToRoute(item.routeId, routeId));
  const executed = new Map();
  for (const item of matched) {
    const kind = adminFieldCaseKindFromEvidenceId(item.row.id, field.name);
    if (!kind) continue;
    const ids = executed.get(kind) ?? [];
    ids.push(item.id);
    executed.set(kind, ids);
  }
  if (["query:limit", "query:cursor"].includes(field.name) && matched.length > 0) {
    executed.set("pagination", matched.map((item) => item.id));
  }
  const missingCases = requiredCases.filter((kind) => !executed.has(kind));
  return {
    sequence: index + 1,
    sourceId: field.id,
    fieldKind: field.kind,
    fieldName: field.name,
    source: field.source,
    line: field.line,
    routeId,
    requiredCases,
    executedCases: Object.fromEntries(executed),
    missingCases,
    pass: missingCases.length === 0
  };
});

const missingByFieldName = Object.entries(Object.groupBy(
  rows.flatMap((row) => row.missingCases.map((caseKind) => ({
    fieldName: row.fieldName,
    caseKind,
    sourceId: row.sourceId,
    routeId: row.routeId
  }))),
  (item) => `${item.fieldName}:${item.caseKind}`
)).map(([key, items]) => ({ key, count: items.length }));
const report = {
  kind: "focowiki-comprehensive-admin-field-occurrence-reconciliation",
  version: 1,
  generatedAt: new Date().toISOString(),
  ok: rows.every((row) => row.pass),
  expectedOccurrenceCount: fields.length,
  observedOccurrenceCount: rows.length,
  requiredCaseCount: rows.reduce((sum, row) => sum + row.requiredCases.length, 0),
  executedCaseCount: rows.reduce((sum, row) =>
    sum + row.requiredCases.filter((kind) => !row.missingCases.includes(kind)).length, 0),
  missingCaseCount: rows.reduce((sum, row) => sum + row.missingCases.length, 0),
  missingByFieldName: missingByFieldName.sort((left, right) =>
    left.key.localeCompare(right.key)),
  rows
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  expectedOccurrenceCount: report.expectedOccurrenceCount,
  requiredCaseCount: report.requiredCaseCount,
  executedCaseCount: report.executedCaseCount,
  missingCaseCount: report.missingCaseCount,
  missingByFieldName: report.missingByFieldName,
  reportPath
}, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;

function fieldRouteId(field) {
  if (field.source === "apps/api/src/admin/source-file-task-deletion-request.ts") {
    return "POST:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/task-deletions";
  }
  if (field.source === "apps/api/src/admin/security.ts") return "MIDDLEWARE:admin-security";
  if (field.source === "apps/api/src/admin/openapi-key-routes.ts" && field.kind === "body-field") {
    return "POST:/admin/api/openapi-keys";
  }
  if (field.source === "apps/api/src/admin/routes.ts" && field.kind === "body-field") {
    if (field.name === "username" || field.name === "password") return "POST:/admin/api/login";
    return "POST:/admin/api/knowledge-bases";
  }
  if (
    field.source === "apps/api/src/admin/runtime-settings-routes.ts"
    && field.name === "param:modelId"
  ) {
    const source = fs.readFileSync(path.join(repositoryRoot, field.source), "utf8");
    const helperLine = source.slice(0, source.indexOf("async function writeModelStatus")).split("\n").length;
    if (field.line >= helperLine) return "HELPER:model-status";
  }
  const source = fs.readFileSync(path.join(repositoryRoot, field.source), "utf8");
  return locateAdminFieldRoute({ source, line: field.line }) ?? `HELPER:${field.source}`;
}

function evidenceAppliesToRoute(evidenceRouteId, fieldRouteIdValue) {
  if (evidenceRouteId === "ANY") return true;
  if (evidenceRouteId === fieldRouteIdValue) return true;
  if (evidenceRouteId === "MIDDLEWARE:admin-security") {
    return fieldRouteIdValue === "MIDDLEWARE:admin-security";
  }
  return false;
}

function boundaryRouteId(id) {
  const occurrence = id.match(/^occurrence:([^:]+):/u)?.[1];
  if (occurrence) return OCCURRENCE_ROUTES[occurrence] ?? "ANY";
  if (id.startsWith("header:cookie:")) return "MIDDLEWARE:admin-security";
  if (id.startsWith("header:content-type:")) return "MIDDLEWARE:admin-security";
  if (id.startsWith("body:name:") || id.startsWith("body:description:")) {
    return "POST:/admin/api/knowledge-bases";
  }
  if (id.startsWith("query:limit:") || id.startsWith("query:cursor:")) {
    return "GET:/admin/api/knowledge-bases";
  }
  if (id.startsWith("query:query:")) {
    return "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/tree/search";
  }
  if (id.startsWith("query:entryType:") || id.startsWith("query:parentPath:")) {
    return "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/tree";
  }
  if (id.startsWith("query:path:") || id.startsWith("query:includeRelationships:")) {
    return "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/detail";
  }
  if (id.startsWith("query:parentDirectoryId:") || id.startsWith("query:state:")) {
    return id.startsWith("query:state:")
      ? "GET:/admin/api/knowledge-bases/:knowledgeBaseId/operations"
      : "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories";
  }
  if (id.startsWith("param:knowledgeBaseId:")) return "GET:/admin/api/knowledge-bases/:knowledgeBaseId";
  if (id.startsWith("param:sourceFileId:")) return "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId";
  if (id.startsWith("param:directoryId:")) return "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId";
  if (id.startsWith("param:operationId:")) return "GET:/admin/api/knowledge-bases/:knowledgeBaseId/operations/:operationId";
  if (id.startsWith("header:idempotency-key:") || id.startsWith("header:if-match:") || id.startsWith("body:relativePath:")) {
    return "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId";
  }
  if (id.startsWith("header:x-source-relative-path:")) {
    return "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content";
  }
  if (id.startsWith("body:expectedResourceRevision:")) {
    return "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId";
  }
  if (id.startsWith("body:idempotencyKey:")) {
    return "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance";
  }
  if (id.startsWith("body:sourceFileIds:")) {
    return "POST:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/task-deletions";
  }
  if (id.startsWith("body:declared") || id.startsWith("query:transferState:")) {
    return id.startsWith("query:transferState:")
      ? "GET:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId"
      : "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions";
  }
  if (id.startsWith("body:entries:")) {
    return "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries";
  }
  if (id.startsWith("param:entryId:")) {
    return "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries/:entryId/content";
  }
  if (id.startsWith("param:keyId:")) return "DELETE:/admin/api/openapi-keys/:keyId";
  if (id.startsWith("param:configurationId:")) return "DELETE:/admin/api/settings/embeddings/:configurationId";
  if (id.startsWith("param:modelId:")) return "DELETE:/admin/api/settings/models/:modelId";
  return "ANY";
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing evidence file: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
