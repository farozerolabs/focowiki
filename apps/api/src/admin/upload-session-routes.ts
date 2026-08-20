import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  UPLOAD_CONTENT_TRANSFER_CONCURRENCY,
  UPLOAD_MANIFEST_PAGE_SIZE
} from "../application/upload-sessions.js";
import {
  UploadSessionError,
  type UploadSessionEntryRecord
} from "../domain/upload-session.js";
import { SourcePathValidationError } from "../domain/source-path.js";
import type { StorageVnextAdminAuditApplication } from "../storage-vnext/api/admin-audit-application.js";
import {
  StorageVnextAdminUploadApplicationError,
  type StorageVnextAdminUploadApplication
} from "../storage-vnext/api/admin-upload-application.js";
import type { RuntimeLogger } from "../logger.js";
import { createIngestionFailureFields } from "../runtime/ingestion-failure.js";

export function registerAdminUploadSessionRoutes(
  app: Hono,
  services: {
    application: StorageVnextAdminUploadApplication;
    audit: StorageVnextAdminAuditApplication;
    logger?: Pick<RuntimeLogger, "error">;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  const prefix = "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions";
  const protectedRoute = [middlewares.requireAuth, middlewares.requireWriteProtection] as const;

  app.post(prefix, ...protectedRoute, async (context) => {
    const body = await readJson(context.req.raw);
    const idempotencyKey = context.req.header("idempotency-key")?.trim() ?? "";
    if (
      !idempotencyKey ||
      !isNonNegativeInteger(body.declaredFileCount) ||
      !isNonNegativeInteger(body.declaredByteCount)
    ) {
      return invalidRequest(context, "INVALID_UPLOAD_SESSION");
    }
    try {
      const session = await services.application.createUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        idempotencyKey,
        declaredFileCount: body.declaredFileCount,
        declaredByteCount: body.declaredByteCount
      });
      await recordUploadAudit(
        services,
        context,
        "upload_session_created",
        "success",
        null,
        session.id
      );
      return context.json(
        {
          session,
          transport: {
            manifestPageSize: UPLOAD_MANIFEST_PAGE_SIZE,
            contentUploadConcurrency: UPLOAD_CONTENT_TRANSFER_CONCURRENCY
          }
        },
        201
      );
    } catch (error) {
      return uploadSessionFailure(services, context, error);
    }
  });

  app.post(`${prefix}/:sessionId/entries`, ...protectedRoute, async (context) => {
    const body = await readJson(context.req.raw);
    if (!Array.isArray(body.entries) || body.entries.length > UPLOAD_MANIFEST_PAGE_SIZE) {
      await recordUploadAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_UPLOAD_MANIFEST_PAGE");
      return invalidRequest(context, "INVALID_UPLOAD_MANIFEST_PAGE");
    }
    const entries = body.entries.map(readManifestEntry);
    if (entries.some((entry) => entry === null)) {
      await recordUploadAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_UPLOAD_MANIFEST_ENTRY");
      return invalidRequest(context, "INVALID_UPLOAD_MANIFEST_ENTRY");
    }
    try {
      const session = await services.application.addUploadEntries({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("sessionId") ?? "",
        entries: entries.filter(isDefined)
      });
      return context.json({ session });
    } catch (error) {
      if (error instanceof SourcePathValidationError) {
        await recordUploadAudit(services, context, "upload_session_invalid_path", "failure", error.code);
      }
      return uploadSessionFailure(services, context, error);
    }
  });

  app.post(`${prefix}/:sessionId/seal`, ...protectedRoute, async (context) => {
    try {
      const result = await services.application.sealUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("sessionId") ?? ""
      });
      await recordUploadAudit(services, context, "upload_session_sealed", "success");
      return context.json({
        session: result.session,
        sample: result.entries.items.map(toSafeEntry),
        nextCursor: result.entries.nextCursor
      });
    } catch (error) {
      return uploadSessionFailure(services, context, error);
    }
  });

  app.put(`${prefix}/:sessionId/entries/:entryId/content`, ...protectedRoute, async (context) => {
    const body = context.req.raw.body;
    if (!body || !isMarkdownContentType(context.req.header("content-type"))) {
      return invalidRequest(context, "INVALID_MARKDOWN_CONTENT");
    }
    try {
      const entry = await services.application.writeUploadContent({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("sessionId") ?? "",
        entryId: context.req.param("entryId") ?? "",
        body
      });
      return context.json({ entry: toSafeEntry(entry) });
    } catch (error) {
      return uploadSessionFailure(services, context, error);
    }
  });

  app.get(`${prefix}/:sessionId`, middlewares.requireAuth, async (context) => {
    try {
      const transferState = readTransferState(context.req.query("transferState"));
      if (context.req.query("transferState") && !transferState) {
        return invalidRequest(context, "INVALID_UPLOAD_ENTRY_FILTER");
      }
      const result = await services.application.getUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("sessionId") ?? "",
        ...(transferState ? { transferState } : {}),
        limit: readLimit(context.req.query("limit"), UPLOAD_MANIFEST_PAGE_SIZE),
        cursor: context.req.query("cursor") ?? null
      });
      return context.json({
        session: result.session,
        entries: {
          items: result.entries.items.map(toSafeEntry),
          nextCursor: result.entries.nextCursor
        }
      });
    } catch (error) {
      return uploadSessionFailure(services, context, error);
    }
  });

  app.post(`${prefix}/:sessionId/reconcile`, ...protectedRoute, async (context) => {
    try {
      const session = await services.application.reconcileUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("sessionId") ?? ""
      });
      return context.json({ session });
    } catch (error) {
      return uploadSessionFailure(services, context, error);
    }
  });

  app.post(`${prefix}/:sessionId/finalize`, ...protectedRoute, async (context) => {
    try {
      const session = await services.application.finalizeUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("sessionId") ?? ""
      });
      await recordUploadAudit(services, context, "upload_session_finalized", "success");
      return context.json({ session });
    } catch (error) {
      return uploadSessionFailure(services, context, error);
    }
  });

  app.delete(`${prefix}/:sessionId`, ...protectedRoute, async (context) => {
    try {
      const session = await services.application.cancelUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("sessionId") ?? ""
      });
      await recordUploadAudit(services, context, "upload_session_cancelled", "success");
      return context.json({ session });
    } catch (error) {
      return uploadSessionFailure(services, context, error);
    }
  });
}

function isMarkdownContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "text/markdown";
}

function readManifestEntry(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.relativePath === "string" &&
    isNonNegativeInteger(entry.declaredSize) &&
    (entry.checksumSha256 === undefined || entry.checksumSha256 === null || typeof entry.checksumSha256 === "string")
    ? {
        relativePath: entry.relativePath,
        declaredSize: entry.declaredSize,
        checksumSha256: entry.checksumSha256 ?? null
      }
    : null;
}

function toSafeEntry(entry: UploadSessionEntryRecord) {
  return {
    id: entry.id,
    relativePath: entry.relativePath,
    directoryPath: entry.directoryPath,
    name: entry.name,
    declaredSize: entry.declaredSize,
    receivedSize: entry.receivedSize,
    disposition: entry.disposition,
    transferState: entry.transferState,
    sourceDirectoryId: entry.sourceDirectoryId,
    sourceFileId: entry.sourceFileId,
    existingResourceRevision: entry.existingResourceRevision,
    generatedPath: entry.generatedPath,
    errorCode: entry.errorCode
  };
}

function uploadSessionFailure(
  services: Parameters<typeof registerAdminUploadSessionRoutes>[1],
  context: Context,
  error: unknown
) {
  services.logger?.error("ingestion.stage_failed", createIngestionFailureFields({
    stage: uploadStage(context),
    error,
    knowledgeBaseId: context.req.param("knowledgeBaseId") ?? null,
    uploadSessionId: context.req.param("sessionId") ?? null
  }));
  if (error instanceof SourcePathValidationError) {
    return context.json({ error: { code: error.code } }, 400);
  }
  if (error instanceof UploadSessionError) {
    const status = error.code.endsWith("NOT_FOUND")
        ? 404
        : error.code.includes("MISMATCH") || error.code.includes("DUPLICATE")
          ? 400
          : 409;
    return context.json({ error: { code: error.code } }, status);
  }
  if (error instanceof StorageVnextAdminUploadApplicationError) {
    return context.json(
      { error: { code: error.code } },
      error.code === "NOT_FOUND" ? 404 : 503
    );
  }
  throw error;
}

function uploadStage(context: Context): string {
  const route = context.req.routePath;
  if (route.endsWith("/entries/:entryId/content")) return "upload_content";
  if (route.endsWith("/entries")) return "upload_manifest";
  if (route.endsWith("/seal")) return "upload_seal";
  if (route.endsWith("/reconcile")) return "upload_reconcile";
  if (route.endsWith("/finalize")) return "upload_finalize";
  if (context.req.method === "DELETE") return "upload_cancel";
  if (context.req.method === "GET") return "upload_status";
  return "upload_create";
}

async function recordUploadAudit(
  services: Parameters<typeof registerAdminUploadSessionRoutes>[1],
  context: Context,
  eventType: string,
  result: "success" | "failure" | "blocked",
  errorCode: string | null = null,
  targetPublicId: string | null = context.req.param("sessionId") ?? null
): Promise<void> {
  const knowledgeBaseId = context.req.param("knowledgeBaseId") ?? null;
  await services.audit.record({
    context,
    eventType,
    result,
    errorCode,
    knowledgeBaseId,
    targetKind: targetPublicId ? "upload_session" : "knowledge_base",
    targetPublicId: targetPublicId ?? knowledgeBaseId
  });
}

function invalidRequest(
  context: Context,
  code: string,
  status: 400 | 413 = 400
) {
  return context.json({ error: { code } }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readLimit(raw: string | undefined, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : max;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : max;
}

function readTransferState(value: string | undefined): "missing" | "failed" | "uploaded" | null {
  return value === "missing" || value === "failed" || value === "uploaded" ? value : null;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
