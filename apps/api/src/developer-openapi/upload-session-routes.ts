import { Hono, type Context } from "hono";
import {
  UPLOAD_CONTENT_TRANSFER_CONCURRENCY,
  UPLOAD_MANIFEST_PAGE_SIZE
} from "../application/upload-sessions.js";
import {
  UploadSessionError,
  type UploadSessionEntryRecord,
  type UploadSessionRecord
} from "../domain/upload-session.js";
import { SourcePathValidationError } from "../domain/source-path.js";
import {
  conflict,
  notFound,
  repositoryUnavailable,
  validationError
} from "./errors.js";
import {
  readDeveloperJsonObjectBody,
  readLimit,
  safe
} from "./route-helpers.js";
import type { DeveloperOpenApiRouteServices } from "./routes.js";
import { readIdempotencyKey } from "./idempotency-key.js";
import { StorageVnextAdminUploadApplicationError } from "../storage-vnext/api/admin-upload-application.js";
import {
  readSourceResourceCursor,
  writeSourceResourceCursor
} from "./source-resource-pagination.js";

export function registerDeveloperOpenApiUploadSessionRoutes(
  app: Hono,
  services: DeveloperOpenApiRouteServices
): void {
  const prefix = "/openapi/v2/knowledge-bases/:knowledgeBaseId/upload-sessions";

  app.post(prefix, async (context) =>
    safe(context, async () => {
      const body = await readDeveloperJsonObjectBody(
        context.req.raw,
        ["declaredFileCount", "declaredByteCount"]
      );
      const idempotencyKey = readIdempotencyKey(
        context.req.header("idempotency-key")
      );
      if (
        !isNonNegativeInteger(body.declaredFileCount) ||
        !isNonNegativeInteger(body.declaredByteCount)
      ) {
        throw validationError("Upload session totals are required.");
      }
      const declaredFileCount = body.declaredFileCount;
      const declaredByteCount = body.declaredByteCount;
      const session = await run(() =>
        services.uploadApplication.createUploadSession({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          idempotencyKey,
          declaredFileCount,
          declaredByteCount
        })
      );
      await recordUploadSessionAudit(
        services,
        context,
        "upload_session_created",
        "success",
        null,
        session.id
      );
      return {
        session: toSafeSession(session),
        transport: {
          manifestPageSize: UPLOAD_MANIFEST_PAGE_SIZE,
          contentUploadConcurrency: UPLOAD_CONTENT_TRANSFER_CONCURRENCY
        }
      };
    }, 201)
  );

  app.post(`${prefix}/:uploadSessionId/entries`, async (context) =>
    safe(context, async () => {
      const body = await readDeveloperJsonObjectBody(context.req.raw, ["entries"]);
      if (
        !Array.isArray(body.entries)
        || body.entries.length === 0
        || body.entries.length > UPLOAD_MANIFEST_PAGE_SIZE
      ) {
        await recordUploadSessionAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_MANIFEST_PAGE");
        throw validationError("Upload file list is invalid.");
      }
      const entries = body.entries.map(readManifestEntry);
      if (entries.some((entry) => entry === null)) {
        await recordUploadSessionAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_MANIFEST_ENTRY");
        throw validationError("An upload file record is invalid.");
      }
      return {
        session: toSafeSession(
          await run(
            () => services.uploadApplication.addUploadEntries({
              knowledgeBaseId: context.req.param("knowledgeBaseId"),
              sessionId: context.req.param("uploadSessionId"),
              entries: entries.filter(isDefined)
            }),
            () => recordUploadSessionAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_RELATIVE_PATH")
          )
        )
      };
    })
  );

  app.post(`${prefix}/:uploadSessionId/seal`, async (context) =>
    safe(context, async () => {
      const result = await run(() =>
        services.uploadApplication.sealUploadSession({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sessionId: context.req.param("uploadSessionId")
        })
      );
      await recordUploadSessionAudit(services, context, "upload_session_sealed", "success");
      return { session: toSafeSession(result.session) };
    })
  );

  app.put(`${prefix}/:uploadSessionId/entries/:entryId/content`, async (context) =>
    safe(context, async () => {
      const request = context.req.raw;
      const body = request.body;
      if (!body || !hasNonEmptyMarkdownBody(request)) {
        throw validationError("A text/markdown request body is required.");
      }
      const entry = await run(() =>
        services.uploadApplication.writeUploadContent({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sessionId: context.req.param("uploadSessionId"),
          entryId: context.req.param("entryId"),
          body
        })
      );
      return { entry: toSafeEntry(entry) };
    })
  );

  app.get(`${prefix}/:uploadSessionId`, async (context) =>
    safe(context, async () => {
      const sessionId = context.req.param("uploadSessionId");
      const state = readTransferState(context.req.query("transferState"));
      if (context.req.query("transferState") && !state) {
        throw validationError("Upload file transferState is invalid.");
      }
      const knowledgeBaseId = context.req.param("knowledgeBaseId");
      const scope = uploadEntryCursorScope(knowledgeBaseId, sessionId, state);
      const cursor = await readSourceResourceCursor<string>(
        services.redis,
        scope,
        context.req.query("cursor") ?? null
      );
      const result = await run(() => services.uploadApplication.getUploadSession({
        knowledgeBaseId,
        sessionId,
        ...(state ? { transferState: state } : {}),
        limit: readLimit(context.req.query("limit"), services.config, {
          defaultPageSize: UPLOAD_MANIFEST_PAGE_SIZE,
          maxPageSize: UPLOAD_MANIFEST_PAGE_SIZE
        }),
        cursor
      }));
      return {
        session: toSafeSession(result.session),
        entries: {
          items: result.entries.items.map(toSafeEntry),
          nextCursor: await writeSourceResourceCursor(
            services.redis,
            scope,
            result.entries.nextCursor,
            services.config.pagination.cursorTtlSeconds
          )
        }
      };
    })
  );

  app.post(`${prefix}/:uploadSessionId/reconcile`, async (context) =>
    safe(context, async () => {
      return {
        session: toSafeSession(
          await run(() => services.uploadApplication.reconcileUploadSession({
            knowledgeBaseId: context.req.param("knowledgeBaseId"),
            sessionId: context.req.param("uploadSessionId")
          }))
        )
      };
    })
  );

  app.post(`${prefix}/:uploadSessionId/finalize`, async (context) =>
    safe(context, async () => {
      const session = await run(() => services.uploadApplication.finalizeUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("uploadSessionId")
      }));
      await recordUploadSessionAudit(services, context, "upload_session_finalized", "success");
      return {
        session: toSafeSession(
          session
        )
      };
    })
  );

  app.delete(`${prefix}/:uploadSessionId`, async (context) =>
    safe(context, async () => {
      const session = await run(() => services.uploadApplication.cancelUploadSession({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sessionId: context.req.param("uploadSessionId")
      }));
      await recordUploadSessionAudit(services, context, "upload_session_cancelled", "success");
      return {
        session: toSafeSession(
          session
        )
      };
    })
  );
}

function isMarkdownContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "text/markdown";
}

export function hasNonEmptyMarkdownBody(request: Request): boolean {
  const declaredLength = request.headers.get("content-length");
  return Boolean(
    request.body
    && isMarkdownContentType(request.headers.get("content-type") ?? undefined)
    && (declaredLength === null || Number(declaredLength) > 0)
  );
}

async function run<T>(operation: () => Promise<T>, onInvalidPath?: () => Promise<void>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SourcePathValidationError) {
      await onInvalidPath?.();
      throw validationError("The upload file list contains an invalid relative path.", {
        field: "relativePath",
        reason: error.code
      });
    }
    if (error instanceof UploadSessionError) {
      if (error.code.endsWith("NOT_FOUND")) throw notFound(error.code);
      if (error.code.includes("MISMATCH") || error.code.includes("DUPLICATE")) {
        throw validationError(error.code);
      }
      throw conflict(error.code);
    }
    if (error instanceof StorageVnextAdminUploadApplicationError) {
      throw error.code === "NOT_FOUND"
        ? notFound("Knowledge base was not found.")
        : repositoryUnavailable();
    }
    throw error;
  }
}

async function recordUploadSessionAudit(
  services: DeveloperOpenApiRouteServices,
  context: Context,
  eventType: string,
  result: "success" | "failure" | "blocked",
  errorCode: string | null = null,
  targetPublicId: string | null = context.req.param("uploadSessionId") || null
): Promise<void> {
  const knowledgeBaseId = context.req.param("knowledgeBaseId") || null;
  await services.auditApplication.record({
    context,
    eventType,
    result,
    errorCode,
    knowledgeBaseId,
    targetKind: targetPublicId ? "upload_session" : "knowledge_base",
    targetPublicId: targetPublicId ?? knowledgeBaseId
  });
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
    sourceFileId: entry.sourceFileId,
    existingResourceRevision: entry.existingResourceRevision
  };
}

function toSafeSession(session: UploadSessionRecord) {
  const base = `/openapi/v2/knowledge-bases/${session.knowledgeBaseId}`;
  return {
    id: session.id,
    operationId: session.operationId,
    knowledgeBaseId: session.knowledgeBaseId,
    state: session.state,
    declaredFileCount: session.declaredFileCount,
    declaredByteCount: session.declaredByteCount,
    counts: {
      selected: session.counts.selected,
      uploadRequired: session.counts.uploadRequired,
      skippedExisting: session.counts.skippedExisting,
      waitingReservation: session.counts.waitingReservation,
      rejectedDeleting: session.counts.rejectedDeleting,
      uploaded: session.counts.uploaded,
      finalized: session.counts.finalized
    },
    errorCode: session.errorCode,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    actions: {
      operation: `${base}/operations/${session.operationId}`
    }
  };
}

function readManifestEntry(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const allowedFields = new Set(["relativePath", "declaredSize", "checksumSha256"]);
  if (Object.keys(record).some((field) => !allowedFields.has(field))) return null;
  return typeof record.relativePath === "string" &&
    isNonNegativeInteger(record.declaredSize) &&
    (record.checksumSha256 === undefined || record.checksumSha256 === null || typeof record.checksumSha256 === "string")
    ? {
        relativePath: record.relativePath,
        declaredSize: record.declaredSize,
        checksumSha256: record.checksumSha256 ?? null
      }
    : null;
}

function readTransferState(value: string | undefined): "missing" | "uploaded" | null {
  return value === "missing" || value === "uploaded" ? value : null;
}

function uploadEntryCursorScope(
  knowledgeBaseId: string,
  sessionId: string,
  transferState: "missing" | "uploaded" | null
): string {
  return `developer-openapi:upload-entries:${knowledgeBaseId}:${sessionId}:${transferState ?? "all"}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
