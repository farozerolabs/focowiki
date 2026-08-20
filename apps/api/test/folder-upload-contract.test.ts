import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAdminUploadSessionRoutes } from
  "../src/admin/upload-session-routes.js";
import { UploadSessionError } from "../src/domain/upload-session.js";
import { registerDeveloperOpenApiUploadSessionRoutes } from
  "../src/developer-openapi/upload-session-routes.js";

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

  it("logs a safe ingestion diagnostic when an upload stage fails", async () => {
    const app = new Hono();
    const logger = { error: vi.fn() };
    registerAdminUploadSessionRoutes(app, {
      application: {
        createUploadSession: vi.fn(async () => {
          throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        })
      } as never,
      audit: { record: vi.fn(async () => undefined) } as never,
      logger
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
          "idempotency-key": "upload-failed-attempt"
        },
        body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: 12 })
      }
    );

    expect(response.status).toBe(409);
    expect(logger.error).toHaveBeenCalledWith(
      "ingestion.stage_failed",
      expect.objectContaining({
        stage: "upload_create",
        errorCode: "UPLOAD_SESSION_STATE_CONFLICT",
        errorMessage: "UPLOAD_SESSION_STATE_CONFLICT",
        knowledgeBaseId: "kb-owned"
      })
    );
  });

  it("logs the same safe ingestion event for Developer OpenAPI uploads", async () => {
    const app = new Hono();
    const logger = { error: vi.fn() };
    registerDeveloperOpenApiUploadSessionRoutes(app, {
      uploadApplication: {
        createUploadSession: vi.fn(async () => {
          throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        })
      },
      auditApplication: { record: vi.fn(async () => undefined) },
      logger
    } as never);

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-openapi/upload-sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "openapi-upload-failed-attempt"
        },
        body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: 12 })
      }
    );

    expect(response.status).toBe(409);
    expect(logger.error).toHaveBeenCalledWith(
      "ingestion.stage_failed",
      expect.objectContaining({
        stage: "upload_create",
        errorCode: "UPLOAD_SESSION_STATE_CONFLICT",
        errorMessage: "UPLOAD_SESSION_STATE_CONFLICT",
        knowledgeBaseId: "kb-openapi"
      })
    );
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
