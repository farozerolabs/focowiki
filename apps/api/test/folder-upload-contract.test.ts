import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("destructive folder-aware upload contract", () => {
  it("removes the flat direct multipart upload contract", () => {
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const developerRoutes = readWorkspaceFile("apps/api/src/developer-openapi/routes.ts");

    expect(adminRoutes).not.toContain(
      '"/admin/api/knowledge-bases/:knowledgeBaseId/uploads"'
    );
    expect(developerRoutes).not.toContain(
      '"/openapi/v1/knowledge-bases/:knowledgeBaseId/uploads"'
    );
  });

  it("uses normalized relative paths instead of basenames for duplicate identity", () => {
    const uploadSessions = readWorkspaceFile("apps/api/src/application/upload-sessions.ts");

    expect(uploadSessions).toContain("relativePath");
    expect(uploadSessions).toContain("pathKey");
    expect(uploadSessions).not.toContain("hasDuplicateUploadFileNames");
  });

  it("maps nested source paths to nested generated pages", () => {
    const pathPolicy = readWorkspaceFile("packages/okf/src/source-path.ts");

    expect(pathPolicy).toContain('generatedPath: `pages/${relativePath}`');
  });
});
