export const EXPECTED_DEVELOPER_OPENAPI_OPERATIONS = [
  "getDeveloperOpenApiHealth",
  "getDeveloperOpenApiVersion",
  "getDeveloperOpenApiContract",
  "listKnowledgeBases",
  "createKnowledgeBase",
  "getKnowledgeBase",
  "updateKnowledgeBase",
  "deleteKnowledgeBase",
  "createUploadSession",
  "addUploadManifestEntries",
  "sealUploadManifest",
  "uploadSessionContentBatch",
  "getUploadSession",
  "cancelUploadSession",
  "reconcileUploadSession",
  "finalizeUploadSession",
  "listKnowledgeBaseSourceFiles",
  "getKnowledgeBaseSourceFile",
  "moveSourceFile",
  "deleteSourceFile",
  "getSourceFileContent",
  "replaceSourceFileContent",
  "listSourceDirectories",
  "getSourceDirectory",
  "moveSourceDirectory",
  "deleteSourceDirectory",
  "listResourceOperations",
  "getResourceOperation",
  "listKnowledgeBaseSourceFileEvents",
  "retryKnowledgeBaseSourceFile",
  "listKnowledgeBaseTree",
  "getFileContentByPath",
  "searchGeneratedFiles",
  "expandGraph",
  "getGraphInsights",
  "getFileById",
  "getFileContentById",
  "listRelatedFiles",
  "createWebhook",
  "listWebhooks",
  "deleteWebhook",
  "listWebhookDeliveries",
  "redeliverWebhook"
];

export const ADMIN_UI_FLOWS = [
  "login-and-session",
  "language-switching",
  "knowledge-base-list",
  "knowledge-base-search",
  "knowledge-base-pagination",
  "knowledge-base-create",
  "knowledge-base-edit",
  "knowledge-base-delete",
  "knowledge-base-id-copy",
  "openapi-key-management",
  "runtime-settings",
  "model-management",
  "single-file-upload",
  "nested-folder-upload",
  "upload-refresh-recovery",
  "task-filtering",
  "task-pagination",
  "task-deletion-and-retry",
  "tree-pagination-and-search",
  "file-preview-and-copy",
  "sidebar-resize",
  "file-rename-move-replace-delete",
  "directory-rename-move-delete",
  "active-operation-recovery",
  "responsive-layout",
  "toast-and-error-feedback"
];

export const ADMIN_API_ROUTE_FAMILIES = [
  "authentication",
  "knowledge-bases",
  "knowledge-base-list-search",
  "openapi-keys",
  "runtime-settings",
  "models",
  "upload-sessions",
  "source-files",
  "source-file-events",
  "source-file-retry",
  "source-file-task-deletion",
  "source-directories",
  "source-resource-editing",
  "resource-operations",
  "file-tree",
  "file-tree-search",
  "processing-summary",
  "public-urls",
  "hard-deletion"
];

export const WORKER_JOB_KINDS = [
  "source_file_processing",
  "resource_operation",
  "upload_session_finalization",
  "publication",
  "hard_delete"
];

export const RUNTIME_SETTINGS_GROUPS = [
  "rate-limits",
  "worker",
  "publication",
  "graph",
  "uploads",
  "pagination-and-content",
  "security-retention",
  "models"
];

export const GENERATED_OUTPUT_FAMILIES = [
  "source-backed-pages",
  "root-navigation",
  "nested-navigation",
  "numbered-index-shards",
  "schema-files",
  "log-shards",
  "manifest-index",
  "search-index",
  "link-index",
  "graph-overview",
  "graph-shards",
  "per-file-graph",
  "release-history"
];

const OPERATION_COVERAGE = EXPECTED_DEVELOPER_OPENAPI_OPERATIONS.map((operationId) => ({
  operationId,
  cases: classifyOperationCases(operationId)
}));

export function buildFullSystemCoverageManifest({ openApiDocument }) {
  const actualOperations = collectOpenApiOperations(openApiDocument);
  const actualIds = actualOperations.map((operation) => operation.operationId);
  const expectedIds = OPERATION_COVERAGE.map((operation) => operation.operationId);
  const duplicateActual = findDuplicates(actualIds);
  const duplicateExpected = findDuplicates(expectedIds);
  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(actualIds);
  const unmapped = actualIds.filter((operationId) => !expectedSet.has(operationId));
  const stale = expectedIds.filter((operationId) => !actualSet.has(operationId));
  const duplicates = [...new Set([...duplicateActual, ...duplicateExpected])].sort();

  if (unmapped.length || stale.length || duplicates.length) {
    throw new Error(
      [
        unmapped.length ? `Unmapped operations: ${unmapped.join(", ")}` : "",
        stale.length ? `Stale operations: ${stale.join(", ")}` : "",
        duplicates.length ? `Duplicate operations: ${duplicates.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("; ")
    );
  }

  return {
    developerOpenApi: {
      actualCount: actualIds.length,
      expectedCount: expectedIds.length,
      operationIds: [...actualIds].sort(),
      operations: actualOperations.map((operation) => ({
        ...operation,
        cases: OPERATION_COVERAGE.find((entry) => entry.operationId === operation.operationId)
          ?.cases ?? []
      })),
      unmapped,
      stale,
      duplicates
    },
    adminUi: { count: ADMIN_UI_FLOWS.length, flows: [...ADMIN_UI_FLOWS] },
    adminApi: {
      count: ADMIN_API_ROUTE_FAMILIES.length,
      routeFamilies: [...ADMIN_API_ROUTE_FAMILIES]
    },
    worker: { count: WORKER_JOB_KINDS.length, jobKinds: [...WORKER_JOB_KINDS] },
    runtimeSettings: {
      count: RUNTIME_SETTINGS_GROUPS.length,
      groups: [...RUNTIME_SETTINGS_GROUPS]
    },
    generatedOutput: {
      count: GENERATED_OUTPUT_FAMILIES.length,
      families: [...GENERATED_OUTPUT_FAMILIES]
    }
  };
}

export function collectOpenApiOperations(openApiDocument) {
  const operations = [];

  for (const [path, pathItem] of Object.entries(openApiDocument?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!operation || typeof operation !== "object" || !operation.operationId) {
        continue;
      }

      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path
      });
    }
  }

  return operations;
}

function classifyOperationCases(operationId) {
  const cases = ["authentication", "schema", "safe-error"];

  if (/list|search|expand|insights/i.test(operationId)) {
    cases.push("pagination-or-bounded-read");
  }
  if (/create|upload|replace|move|retry|redeliver/i.test(operationId)) {
    cases.push("positive-mutation", "idempotency-or-conflict");
  }
  if (/delete|cancel/i.test(operationId)) {
    cases.push("reverse-lifecycle", "deleted-resource-read");
  }
  if (/get|list|search|expand|insights/i.test(operationId)) {
    cases.push("identifier-continuity");
  }

  return cases;
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].sort();
}
