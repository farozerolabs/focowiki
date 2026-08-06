import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

const contractFiles = {
  shared: "apps/api/src/storage-vnext/shared/types.ts",
  catalog: "apps/api/src/storage-vnext/catalog/ports.ts",
  graph: "apps/api/src/storage-vnext/graph/ports.ts",
  release: "apps/api/src/storage-vnext/release/ports.ts",
  workflow: "apps/api/src/storage-vnext/workflow/ports.ts",
  ownership: "apps/api/src/storage-vnext/ownership/ports.ts",
  search: "apps/api/src/storage-vnext/search/ports.ts",
  cleanup: "apps/api/src/storage-vnext/cleanup/terminal-convergence.ts",
  audit: "apps/api/src/storage-vnext/audit/ports.ts",
  settings: "apps/api/src/storage-vnext/settings/ports.ts",
  admin: "apps/api/src/storage-vnext/api/admin-ports.ts",
  openapi: "apps/api/src/storage-vnext/api/openapi-ports.ts"
} as const;

const requiredExports: Record<keyof typeof contractFiles, string[]> = {
  shared: [
    "StorageVnextKnowledgeBaseId",
    "StorageVnextOpaqueCursor",
    "StorageVnextPage",
    "StorageVnextRevision"
  ],
  catalog: ["StorageVnextCatalogReadPort", "StorageVnextCatalogWritePort"],
  graph: ["StorageVnextGraphReadPort", "StorageVnextGraphWritePort"],
  release: ["StorageVnextReleaseReadPort", "StorageVnextReleaseWritePort"],
  workflow: ["StorageVnextWorkflowClaimPort", "StorageVnextWorkflowWritePort"],
  ownership: ["StorageVnextOwnershipReadPort", "StorageVnextOwnershipWritePort"],
  search: ["StorageVnextSearchQueryPort", "StorageVnextSearchProjectionPort"],
  cleanup: ["StorageVnextTerminalConvergencePort"],
  audit: ["StorageVnextAuditPort"],
  settings: ["StorageVnextSettingsReadPort", "StorageVnextSettingsWritePort"],
  admin: ["StorageVnextAdminBackendAdapter"],
  openapi: ["StorageVnextOpenApiBackendAdapter"]
};

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("storage vNext architecture contracts", () => {
  it("defines one small typed port module for every stable responsibility", () => {
    for (const [responsibility, path] of Object.entries(contractFiles)) {
      const absolutePath = resolve(workspaceRoot, path);
      expect(existsSync(absolutePath), `${responsibility}: ${path}`).toBe(true);
      if (!existsSync(absolutePath)) continue;

      const source = readWorkspaceFile(path);
      expect(source.split("\n").length, `${responsibility}: ${path}`).toBeLessThanOrEqual(240);
      for (const name of requiredExports[responsibility as keyof typeof contractFiles]) {
        expect(source, `${responsibility}: ${name}`).toMatch(
          new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`, "u")
        );
      }
    }
  });

  it("keeps port contracts independent from concrete stores and interface adapters", () => {
    const forbiddenImports =
      /from\s+["'][^"']*(?:\/db\/|\/infrastructure\/|\/redis\/|\/storage\/s3|\/admin\/|\/developer-openapi\/)|from\s+["'](?:hono|postgres|redis|meilisearch|@aws-sdk\/)/u;

    for (const [responsibility, path] of Object.entries(contractFiles)) {
      if (!existsSync(resolve(workspaceRoot, path))) continue;
      expect(readWorkspaceFile(path), `${responsibility}: ${path}`).not.toMatch(forbiddenImports);
    }
  });

  it("prevents responsibility ports from importing one another", () => {
    const responsibilityImport = /from\s+["']\.\.\/(?:catalog|graph|release|workflow|ownership|search|cleanup|audit|settings)\//u;

    for (const [responsibility, path] of Object.entries(contractFiles)) {
      if (responsibility === "shared" || !existsSync(resolve(workspaceRoot, path))) continue;
      expect(readWorkspaceFile(path), `${responsibility}: ${path}`).not.toMatch(
        responsibilityImport
      );
    }
  });

  it("keeps Admin and OpenAPI ports storage-neutral and public-safe", () => {
    for (const responsibility of ["admin", "openapi"] as const) {
      const path = contractFiles[responsibility];
      if (!existsSync(resolve(workspaceRoot, path))) continue;
      const source = readWorkspaceFile(path);
      expect(source).not.toMatch(
        /S3|R2|bucket|objectKey|Meilisearch|indexUid|taskUid|Redis|tableName|Generation/u
      );
      expect(source).toContain("logicalPath");
      expect(source).toContain("publicId");
    }
  });
});
