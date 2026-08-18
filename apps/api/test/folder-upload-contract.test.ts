import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAdminUploadSessionRoutes } from
  "../src/admin/upload-session-routes.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("destructive folder-aware upload contract", () => {
  it("binds a created upload audit event to its knowledge base and session", async () => {
    const app = new Hono();
    const audit = { record: vi.fn(async () => undefined) };
    registerAdminUploadSessionRoutes(app, {
      application: {
        createUploadSession: vi.fn(async () => ({ id: "upload-session-owned" }))
      } as never,
      audit: audit as never
    }, {
      requireAuth: async (_context, next) => next(),
      requireWriteProtection: async (_context, next) => next()
    });

    const response = await app.request(
      "/admin/api/knowledge-bases/kb-owned/upload-sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "upload-owned-attempt"
        },
        body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: 12 })
      }
    );

    expect(response.status).toBe(201);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "upload_session_created",
      knowledgeBaseId: "kb-owned",
      targetKind: "upload_session",
      targetPublicId: "upload-session-owned"
    }));
  });

  it("removes the flat direct multipart upload contract", () => {
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const developerRoutes = readWorkspaceFile("apps/api/src/developer-openapi/routes.ts");

    expect(adminRoutes).not.toContain(
      '"/admin/api/knowledge-bases/:knowledgeBaseId/uploads"'
    );
    expect(developerRoutes).not.toContain(
      '"/openapi/v2/knowledge-bases/:knowledgeBaseId/uploads"'
    );
  });

  it("uses normalized relative paths instead of basenames for duplicate identity", () => {
    const uploadApplication = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-admin-upload.ts"
    );
    const manifest = readWorkspaceFile(
      "apps/api/src/storage-vnext/upload/manifest.ts"
    );

    expect(uploadApplication).toContain("entry.relativePath");
    expect(uploadApplication).toContain("path.pathKey");
    expect(manifest).toContain("path.pathKey");
    expect(`${uploadApplication}\n${manifest}`).not.toContain("hasDuplicateUploadFileNames");
  });

  it("maps nested source paths to nested generated pages", () => {
    const pathPolicy = readWorkspaceFile("packages/okf/src/source-path.ts");

    expect(pathPolicy).toContain('generatedPath: `pages/${relativePath}`');
  });
});
