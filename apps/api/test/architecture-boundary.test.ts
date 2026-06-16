import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function countLines(path: string): number {
  return readWorkspaceFile(path).split("\n").length;
}

describe("lightweight architecture boundaries", () => {
  it("keeps production admin responsibilities out of single oversized files", () => {
    expect(countLines("apps/api/src/server.ts")).toBeLessThanOrEqual(150);
    expect(countLines("apps/api/src/admin/routes.ts")).toBeLessThanOrEqual(1_100);
    expect(countLines("apps/api/src/admin/upload-processor.ts")).toBeLessThanOrEqual(500);
    expect(countLines("apps/api/src/developer-openapi/routes.ts")).toBeLessThanOrEqual(350);
    expect(countLines("apps/api/src/okf/publication.ts")).toBeLessThanOrEqual(800);
    expect(countLines("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx")).toBeLessThanOrEqual(
      700
    );
  });

  it("keeps API and Admin UI layers separated", () => {
    const apiServer = readWorkspaceFile("apps/api/src/server.ts");
    const uploadProcessor = readWorkspaceFile("apps/api/src/admin/upload-processor.ts");
    const adminPage = readWorkspaceFile("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx");

    expect(apiServer).not.toContain("apps/admin");
    expect(uploadProcessor).not.toContain("apps/admin");
    expect(adminPage).not.toContain("apps/api/src");
  });

  it("keeps Developer OpenAPI routes in their own route module", () => {
    const server = readWorkspaceFile("apps/api/src/server.ts");
    const developerRoutes = readWorkspaceFile("apps/api/src/developer-openapi/routes.ts");

    expect(server).toContain("registerDeveloperOpenApiRoutes");
    expect(server).not.toContain("serveScopedPublicFile");
    expect(developerRoutes).toContain("/openapi/v1/knowledge-bases");
    expect(developerRoutes).toContain("/openapi/v1/webhooks");
  });

  it("keeps Admin API routes in their own module without obsolete pre-release endpoints", () => {
    const server = readWorkspaceFile("apps/api/src/server.ts");
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const adminClient = readWorkspaceFile("apps/admin/src/lib/admin-api.ts");

    expect(server).toContain("registerAdminApiRoutes");
    expect(server).not.toContain("/admin/api/knowledge-bases");
    expect(adminRoutes).toContain("/admin/api/knowledge-bases/:knowledgeBaseId/uploads");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/uploads");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/generations");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/result");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/preview");
  });

  it("keeps OKF publication independent from full release file maps", () => {
    const publication = readWorkspaceFile("apps/api/src/okf/publication.ts");

    expect(publication).not.toContain("const bundleFiles: BundleFileDraft[]");
    expect(publication).not.toContain("buildBundleTreeEntries");
    expect(publication).toContain("flushTreeEntries");
  });
});
