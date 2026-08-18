import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDeveloperOpenApiDocument } from "../src/developer-openapi/openapi-document.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const apiSourceRoot = resolve(workspaceRoot, "apps/api/src");

const adminUseCases = [
  "listKnowledgeBases",
  "getKnowledgeBase",
  "createKnowledgeBase",
  "updateKnowledgeBase",
  "deleteKnowledgeBase",
  "listDirectories",
  "getDirectory",
  "listFiles",
  "getFile",
  "readSourceContent",
  "listSourceEvents",
  "retrySourceFile",
  "createUploadSession",
  "addUploadEntries",
  "sealUploadSession",
  "writeUploadContent",
  "getUploadSession",
  "reconcileUploadSession",
  "finalizeUploadSession",
  "cancelUploadSession",
  "moveSourceFile",
  "moveSourceDirectory",
  "replaceSourceFileContent",
  "deleteSourceFile",
  "deleteSourceDirectory",
  "listOperations",
  "getOperation",
  "listTree",
  "readGeneratedContent",
  "searchFiles",
  "expandGraph",
  "getGraphOverview",
  "listRelatedFiles",
  "requestMaintenance",
  "getMaintenanceStatus",
  "getRuntimeSettings",
  "updateRuntimeSettings"
] as const;

const openApiUseCases = [
  "listKnowledgeBases",
  "getKnowledgeBase",
  "createKnowledgeBase",
  "updateKnowledgeBase",
  "deleteKnowledgeBase",
  "createUploadSession",
  "addUploadEntries",
  "sealUploadSession",
  "writeUploadContent",
  "getUploadSession",
  "reconcileUploadSession",
  "finalizeUploadSession",
  "cancelUploadSession",
  "listSourceFiles",
  "getSourceFile",
  "readSourceContent",
  "listDirectories",
  "getDirectory",
  "moveSourceFile",
  "moveSourceDirectory",
  "replaceSourceFileContent",
  "deleteSourceFile",
  "deleteSourceDirectory",
  "listOperations",
  "getOperation",
  "retrySourceFile",
  "listTree",
  "searchFiles",
  "getFileById",
  "getFileContentById",
  "getFileContentByPath",
  "expandGraph",
  "getGraphOverview",
  "listRelatedFiles",
  "createWebhook",
  "listWebhooks",
  "deleteWebhook",
  "listWebhookDeliveries",
  "redeliverWebhook"
] as const;

describe("storage vNext public continuity Red contract", () => {
  it("defines every existing Admin use case on one storage-neutral application boundary", () => {
    const source = readWorkspaceFile("apps/api/src/storage-vnext/api/admin-ports.ts");

    expect(findMissingMethods(source, adminUseCases)).toEqual([]);
  });

  it("defines every existing Developer OpenAPI use case across the explicit storage-neutral route boundaries", () => {
    const source = [
      "apps/api/src/storage-vnext/api/openapi-application.ts",
      "apps/api/src/storage-vnext/api/admin-upload-application.ts",
      "apps/api/src/storage-vnext/api/admin-mutation-application.ts"
    ].map(readWorkspaceFile).join("\n");

    expect(findMissingMethods(source, openApiUseCases)).toEqual([]);
  });

  it("keeps Admin and OpenAPI handlers free of legacy repositories and physical storage concepts", () => {
    const handlerFiles = [
      ...collectTypeScriptFiles(resolve(apiSourceRoot, "admin"))
        .filter((path) => path.endsWith("-routes.ts") || path.endsWith("/routes.ts")),
      ...collectTypeScriptFiles(resolve(apiSourceRoot, "developer-openapi"))
        .filter((path) => path.endsWith("-routes.ts") || path.endsWith("/routes.ts") || path.endsWith("/services.ts"))
    ];
    const forbidden = [
      "AdminRepositories",
      "ActiveGenerationReadRepository",
      "PublicationGenerationRepository",
      "RoleJobRepository",
      "StorageAdapter",
      "getObjectText(",
      "objectKey"
    ];
    const violations = handlerFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbidden
        .filter((token) => source.includes(token))
        .map((token) => ({ path: relativeWorkspacePath(path), token }));
    });

    expect(violations).toEqual([]);
  });

  it("wires production Admin and OpenAPI applications only through storage vNext ports", () => {
    const applicationFiles = collectTypeScriptFiles(
      resolve(apiSourceRoot, "storage-vnext/api")
    ).filter((path) => path.endsWith("-application.ts") || path.endsWith("-route-context.ts"));
    const forbiddenApplicationTokens = [
      "AdminRepositories",
      "ActiveGenerationReadRepository",
      "PublicationGenerationRepository",
      "RoleJobRepository",
      "SourceDispatchRepository",
      "SourceFileRetryRepository",
      "SourceFileTaskDeletionRepository",
      'from "../../db/admin-repositories.js"',
      'from "../../storage/s3.js"'
    ];
    const applicationViolations = applicationFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbiddenApplicationTokens
        .filter((token) => source.includes(token))
        .map((token) => ({ path: relativeWorkspacePath(path), token }));
    });

    const productionSource = readWorkspaceFile("apps/api/src/main.ts");
    const forbiddenProductionFactories = [
      "createPostgresAdminRepositories",
      "createPostgresActiveGenerationReadRepository",
      "createPostgresRoleJobRepository",
      "createPostgresPublicationGenerationRepository",
      "createPostgresSourceDispatchRepository",
      "createPostgresSourceFileRetryRepository",
      "createPostgresSourceFileTaskDeletionRepository",
      "createPostgresStorageReconciliationRepository",
      "createPostgresObjectProtectionRepository",
      "createPostgresMaintenanceProgressRepository",
      "createPostgresKnowledgeBaseIndexMaintenanceRepository"
    ];
    const productionViolations = forbiddenProductionFactories.filter((token) =>
      productionSource.includes(token)
    );

    expect({ applicationViolations, productionViolations }).toEqual({
      applicationViolations: [],
      productionViolations: []
    });
  });

  it("preserves Admin styling while allowing document-lifecycle wiring changes", () => {
    expect(sha256(readWorkspaceFile("apps/admin/src/styles.css"))).toBe(
      "2661326c543de78343817b10c532812824851806cc05d0048c3aac9418d5b532"
    );
    const detail = readWorkspaceFile("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx");
    const detailView = readWorkspaceFile(
      "apps/admin/src/lib/knowledge-base-detail-view.ts"
    );
    const operations = readWorkspaceFile("apps/admin/src/hooks/use-resource-operations.ts");
    expect(detail).toContain("SOURCE_FILE_REFRESH_INTERVAL_MS");
    expect(detail).toContain("SOURCE_FILE_FILTER_DEBOUNCE_MS");
    expect(detailView).toContain("SOURCE_FILE_REFRESH_INTERVAL_MS = 2_000;");
    expect(detailView).toContain("SOURCE_FILE_FILTER_DEBOUNCE_MS = 300;");
    expect(operations).toContain("const POLL_DELAYS_MS = [1_000, 2_000, 5_000] as const;");
    expect(operations).toContain('document.visibilityState === "hidden"');
  });

  it("freezes all routes, schemas, authentication, limits, cursors, and safe error envelopes", () => {
    const document = createDeveloperOpenApiDocument();
    const operations = Object.values(document.paths)
      .flatMap((pathItem) => Object.values(pathItem));
    const normalized = structuredClone(document);
    normalized.info.version = "<normalized>";

    expect(Object.keys(document.paths)).toHaveLength(32);
    expect(operations).toHaveLength(42);
    expect(Object.keys(document.components.schemas)).toHaveLength(57);
    const fileSearchResponse = document.components.schemas.FileSearchResponse;
    expect(fileSearchResponse).toBeDefined();
    expect(fileSearchResponse).toMatchObject({
      type: "object",
      properties: {
        semanticStatus: {
          type: "object",
          properties: {
            state: { enum: ["ready", "degraded", "unavailable"] },
            safeCode: {
              anyOf: [{ type: "string" }, { type: "null" }]
            }
          },
          required: ["state", "safeCode"]
        }
      }
    });
    expect(fileSearchResponse?.required).toEqual(expect.arrayContaining([
      "semanticStatus",
      "evidenceStatus",
      "rerankerStatus"
    ]));
    const normalizedDocument = JSON.stringify(normalized);
    expect(normalizedDocument).not.toMatch(
      /pending_publication|publication_queued|publication_failed|manual_publication/u
    );
    expect(normalizedDocument).toContain('"waiting"');
    expect(normalizedDocument).toContain('"processing"');
    expect(normalizedDocument).toContain('"available"');
    expect(normalizedDocument).toContain('"error"');
    expect(document.security).toEqual([{ bearerAuth: [] }]);

    const errors = readWorkspaceFile("apps/api/src/developer-openapi/errors.ts");
    for (const token of [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "PAYLOAD_TOO_LARGE",
      "VALIDATION_ERROR",
      "RATE_LIMITED",
      "DATABASE_REPOSITORY_UNAVAILABLE",
      "SEARCH_UNAVAILABLE",
      "SEARCH_TIMEOUT",
      "SEARCH_OVERLOADED",
      "requestId"
    ]) {
      expect(errors).toContain(token);
    }
  });

  it("keeps internal storage identities out of the public application ports", () => {
    for (const path of [
      "apps/api/src/storage-vnext/api/admin-ports.ts",
      "apps/api/src/storage-vnext/api/openapi-application.ts",
      "apps/api/src/storage-vnext/api/admin-upload-application.ts",
      "apps/api/src/storage-vnext/api/admin-mutation-application.ts"
    ]) {
      const source = readWorkspaceFile(path);
      expect(source, path).not.toMatch(
        /bucket|objectKey|indexUid|taskUid|tableName|ownerRow|leaseId/u
      );
    }
  });
});

function findMissingMethods(source: string, methods: readonly string[]): string[] {
  return methods.filter((method) => !new RegExp(`\\b${method}\\s*\\(`, "u").test(source));
}

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function relativeWorkspacePath(path: string): string {
  return path.slice(workspaceRoot.length + 1);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
