import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_GENERATED_NAVIGATION_PATHS } from "../src/okf/generated-graph-resources.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

const expectedOpenApiPaths = [
  "/openapi/v2/health",
  "/openapi/v2/version",
  "/openapi/v2/openapi.json",
  "/openapi/v2/knowledge-bases",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/seal",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries/{entryId}/content",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/reconcile",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/finalize",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/content",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations/{operationId}",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/tree",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/content",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/overview",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content",
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related",
  "/openapi/v2/webhooks",
  "/openapi/v2/webhooks/{webhookId}",
  "/openapi/v2/webhook-deliveries",
  "/openapi/v2/webhook-deliveries/{deliveryId}/redeliver"
] as const;

describe("storage vNext API compatibility contract", () => {
  it("defines the connected storage-neutral application contracts for existing route handlers", () => {
    const adminSource = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/admin-ports.ts"
    );
    const openApiSource = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/openapi-application.ts"
    );
    const postgresOpenApi = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-openapi-application.ts"
    );

    expect(adminSource).toMatch(/export\s+type\s+StorageVnextAdminBackendAdapter\b/u);
    expect(openApiSource).toMatch(/export\s+type\s+DeveloperOpenApiApplication\b/u);
    expect(postgresOpenApi).toContain("): DeveloperOpenApiApplication");
    expect(adminSource).toContain("refreshAfterMs");
    expect(adminSource).toContain("listOperations");
    expect(adminSource).toContain("logicalPath");
    expect(openApiSource).toContain("getSourceFile");
    expect(openApiSource).toContain("searchFiles");
    expect(openApiSource).toContain("listWebhooks");

    for (const source of [adminSource, openApiSource]) {
      expect(source).not.toMatch(
        /Hono|\/admin\/api|\/openapi\/v2|httpStatus|messageKey|bucket|objectKey|indexUid|taskUid|Redis|tableName|Generation/u
      );
    }
  });

  it("keeps released Admin polling behavior in the unchanged UI consumer", () => {
    const detailPage = readWorkspaceFile(
      "apps/admin/src/pages/KnowledgeBaseDetailPage.tsx"
    );
    const operationHook = readWorkspaceFile(
      "apps/admin/src/hooks/use-resource-operations.ts"
    );

    expect(detailPage).toContain("const SOURCE_FILE_REFRESH_INTERVAL_MS = 2_000;");
    expect(detailPage).toContain("page.refreshAfterMs");
    expect(operationHook).toContain(
      "const POLL_DELAYS_MS = [1_000, 2_000, 5_000] as const;"
    );
    expect(operationHook).toContain('document.visibilityState === "hidden"');
  });

  it("keeps all 33 released Developer OpenAPI paths in the same order", () => {
    const source = readWorkspaceFile(
      "apps/api/src/developer-openapi/openapi-paths.ts"
    );
    const paths = [...source.matchAll(/^\s{4}"(\/openapi\/v2[^"]+)":\s*\{/gmu)]
      .map((match) => match[1]);

    expect(paths).toEqual(expectedOpenApiPaths);
  });

  it("keeps released route error ownership outside storage adapters", () => {
    const adminRoutes = readWorkspaceFile(
      "apps/api/src/admin/source-resource-editing-routes.ts"
    );
    const openApiRoutes = readWorkspaceFile(
      "apps/api/src/developer-openapi/source-resource-routes.ts"
    );

    for (const token of [
      "RESOURCE_NOT_FOUND",
      "INVALID_RESOURCE_MUTATION"
    ]) {
      expect(adminRoutes).toContain(token);
      expect(openApiRoutes).toContain(token);
    }
    expect(adminRoutes).toContain("RESOURCE_REVISION_CONFLICT");
    expect(adminRoutes).toContain("DATABASE_REPOSITORY_UNAVAILABLE");
    expect(openApiRoutes).toContain("throw conflict(error.code)");
    expect(openApiRoutes).toContain("sanitizeStorageVnextPublicValue(operation.result)");
  });

  it("reads active source revisions through the vNext current-revision relation", () => {
    const source = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-admin-resources.ts"
    );

    expect(source).toContain(
      "LEFT JOIN focowiki.source_file_current_revisions current_revision"
    );
    expect(source).toContain(
      "revision.public_id = current_revision.source_revision_public_id"
    );
    expect(source).not.toContain("source.current_revision_public_id");
  });

  it("keeps the released generated navigation paths and order", () => {
    expect(REQUIRED_GENERATED_NAVIGATION_PATHS).toEqual([
      "index.md",
      "pages/index.md",
      "schema.md",
      "log.md",
      "_index/index.md",
      "_graph/index.md",
      "_index/catalog.json"
    ]);
  });
});
