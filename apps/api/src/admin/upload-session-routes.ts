import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createUploadSessionService } from "../application/upload-sessions.js";
import { resolveWorkerConfig, type RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import {
  UploadSessionError,
  type UploadSessionEntryRecord
} from "../domain/upload-session.js";
import { SourcePathValidationError } from "../domain/source-path.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import { resolveUploadGenerationSettings } from "../runtime-settings/upload-generation.js";
import type { ApplicationRuntime } from "../application/ports/runtime.js";
import type { UploadSessionStoragePort } from "../application/ports/upload-session-storage.js";
import { limitAdminUploadRequest, recordAdminAudit } from "./security.js";

export function registerAdminUploadSessionRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    redis: RedisCoordinator | null;
    repositories: AdminRepositories | null;
    runtimeSettings: RuntimeSettingsService | null;
    applicationRuntime: ApplicationRuntime;
    uploadSessionStorage: UploadSessionStoragePort;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  const prefix = "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions";
  const protectedRoute = [middlewares.requireAuth, middlewares.requireWriteProtection] as const;

  app.post(prefix, ...protectedRoute, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    const limited = await limitAdminUploadRequest({
      config: services.config,
      redis: services.redis,
      repositories: services.repositories,
      runtimeSettings: services.runtimeSettings,
      context
    });
    if (limited) {
      return limited;
    }
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
      const session = await environment.service.createSession({
        knowledgeBaseId: environment.knowledgeBaseId,
        idempotencyKey,
        declaredFileCount: body.declaredFileCount,
        declaredByteCount: body.declaredByteCount
      });
      await recordUploadAudit(services, context, "upload_session_created", "success");
      return context.json(
        {
          session,
          limits: {
            manifestPageSize: environment.settings.manifestPageSize,
            contentBatchMaxFiles: environment.settings.contentBatchMaxFiles,
            contentBatchMaxBytes: environment.settings.contentBatchMaxBytes,
            maxFileBytes: environment.settings.maxBytes
          }
        },
        201
      );
    } catch (error) {
      return uploadSessionFailure(context, error);
    }
  });

  app.post(`${prefix}/:sessionId/entries`, ...protectedRoute, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    const body = await readJson(context.req.raw);
    if (!Array.isArray(body.entries) || body.entries.length > environment.settings.manifestPageSize) {
      await recordUploadAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_UPLOAD_MANIFEST_PAGE");
      return invalidRequest(context, "INVALID_UPLOAD_MANIFEST_PAGE");
    }
    const entries = body.entries.map(readManifestEntry);
    if (entries.some((entry) => entry === null)) {
      await recordUploadAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_UPLOAD_MANIFEST_ENTRY");
      return invalidRequest(context, "INVALID_UPLOAD_MANIFEST_ENTRY");
    }
    try {
      const session = await environment.service.addManifestEntries({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: context.req.param("sessionId") ?? "",
        entries: entries.filter(isDefined)
      });
      return context.json({ session });
    } catch (error) {
      if (error instanceof SourcePathValidationError) {
        await recordUploadAudit(services, context, "upload_session_invalid_path", "failure", error.code);
      }
      return uploadSessionFailure(context, error);
    }
  });

  app.post(`${prefix}/:sessionId/seal`, ...protectedRoute, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    try {
      const session = await environment.service.sealManifest({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: context.req.param("sessionId") ?? ""
      });
      await recordUploadAudit(services, context, "upload_session_sealed", "success");
      const entries = await environment.service.listEntries({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: session.id,
        limit: Math.min(environment.settings.manifestPageSize, 100),
        cursor: null
      });
      return context.json({
        session,
        sample: entries.items.map(toSafeEntry),
        nextCursor: entries.nextCursor
      });
    } catch (error) {
      return uploadSessionFailure(context, error);
    }
  });

  app.post(`${prefix}/:sessionId/content`, ...protectedRoute, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    const form = await context.req.formData();
    const parts = [...form.entries()].filter((entry): entry is [string, File] => isFile(entry[1]));
    if (parts.length === 0 || parts.length > environment.settings.contentBatchMaxFiles) {
      return invalidRequest(context, "UPLOAD_CONTENT_BATCH_FILE_LIMIT");
    }
    const totalBytes = parts.reduce((sum, [, file]) => sum + file.size, 0);
    if (totalBytes > environment.settings.contentBatchMaxBytes) {
      return invalidRequest(context, "UPLOAD_CONTENT_BATCH_BYTE_LIMIT", 413);
    }
    const uploaded: UploadSessionEntryRecord[] = [];
    try {
      for (const [entryId, file] of parts) {
        uploaded.push(
          await environment.service.putEntryContent({
            knowledgeBaseId: environment.knowledgeBaseId,
            sessionId: context.req.param("sessionId") ?? "",
            entryId,
            bytes: new Uint8Array(await file.arrayBuffer())
          })
        );
      }
      return context.json({ entries: uploaded.map(toSafeEntry) });
    } catch (error) {
      return uploadSessionFailure(context, error);
    }
  });

  app.get(`${prefix}/:sessionId`, middlewares.requireAuth, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    try {
      const session = await environment.service.getSession({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: context.req.param("sessionId") ?? ""
      });
      const transferState = readTransferState(context.req.query("transferState"));
      if (context.req.query("transferState") && !transferState) {
        return invalidRequest(context, "INVALID_UPLOAD_ENTRY_FILTER");
      }
      const entries = await environment.service.listEntries({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: session.id,
        ...(transferState ? { transferState } : {}),
        limit: readLimit(context.req.query("limit"), environment.settings.manifestPageSize),
        cursor: context.req.query("cursor") ?? null
      });
      return context.json({
        session,
        entries: { items: entries.items.map(toSafeEntry), nextCursor: entries.nextCursor }
      });
    } catch (error) {
      return uploadSessionFailure(context, error);
    }
  });

  app.post(`${prefix}/:sessionId/reconcile`, ...protectedRoute, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    try {
      const session = await environment.service.reconcileReservations({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: context.req.param("sessionId") ?? ""
      });
      return context.json({ session });
    } catch (error) {
      return uploadSessionFailure(context, error);
    }
  });

  app.post(`${prefix}/:sessionId/finalize`, ...protectedRoute, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    try {
      const session = await environment.service.finalizeSession({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: context.req.param("sessionId") ?? ""
      });
      await recordUploadAudit(services, context, "upload_session_finalized", "success");
      return context.json({ session }, 202);
    } catch (error) {
      return uploadSessionFailure(context, error);
    }
  });

  app.delete(`${prefix}/:sessionId`, ...protectedRoute, async (context) => {
    const environment = await requireEnvironment(context, services);
    if (environment instanceof Response) {
      return environment;
    }
    try {
      const session = await environment.service.cancelSession({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: context.req.param("sessionId") ?? ""
      });
      await recordUploadAudit(services, context, "upload_session_cancelled", "success");
      return context.json({ session });
    } catch (error) {
      return uploadSessionFailure(context, error);
    }
  });
}

async function requireEnvironment(
  context: Context,
  services: Parameters<typeof registerAdminUploadSessionRoutes>[1]
) {
  if (!services.repositories?.uploadSessions || !services.repositories.workerJobs || !services.redis) {
    return context.json({ error: { code: "SERVICE_UNAVAILABLE" } }, 503);
  }
  const knowledgeBaseId = context.req.param("knowledgeBaseId") ?? "";
  const knowledgeBase = await services.repositories.knowledgeBases.getKnowledgeBase(knowledgeBaseId);
  if (!knowledgeBase) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const settings = await resolveUploadGenerationSettings({
    config: services.config,
    runtimeSettings: services.runtimeSettings
  });
  const worker = services.runtimeSettings
    ? (await services.runtimeSettings.getSnapshot()).worker
    : resolveWorkerConfig(services.config);
  const workerJobs = services.repositories.workerJobs;
  return {
    knowledgeBaseId,
    settings,
    service: createUploadSessionService({
      repository: services.repositories.uploadSessions,
      storage: services.uploadSessionStorage,
      runtime: services.applicationRuntime,
      sessionTtlSeconds: settings.sessionTtlSeconds,
      maxFileBytes: settings.maxBytes,
      finalization: {
        enqueue: async ({ knowledgeBaseId: id, sessionId }) => {
          if (!workerJobs?.enqueueUploadSessionFinalizationJob) {
            throw new Error("Upload finalization queue is unavailable");
          }
          await workerJobs.enqueueUploadSessionFinalizationJob({
            knowledgeBaseId: id,
            sessionId,
            runAfter: services.applicationRuntime.clock.now().toISOString(),
            maxAttempts: worker.jobMaxAttempts
          });
        }
      }
    })
  };
}

function readManifestEntry(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.relativePath === "string" &&
    isNonNegativeInteger(entry.declaredSize) &&
    typeof entry.checksumSha256 === "string"
    ? {
        relativePath: entry.relativePath,
        declaredSize: entry.declaredSize,
        checksumSha256: entry.checksumSha256
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
    checksumSha256: entry.checksumSha256,
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
  context: Context,
  error: unknown
) {
  if (error instanceof SourcePathValidationError) {
    return context.json({ error: { code: error.code } }, 400);
  }
  if (error instanceof UploadSessionError) {
    const status = error.code === "UPLOAD_FILE_TOO_LARGE"
      ? 413
      : error.code.endsWith("NOT_FOUND")
        ? 404
        : 409;
    return context.json({ error: { code: error.code } }, status);
  }
  throw error;
}

async function recordUploadAudit(
  services: Parameters<typeof registerAdminUploadSessionRoutes>[1],
  context: Context,
  eventType: string,
  result: "success" | "failure" | "blocked",
  errorCode: string | null = null
): Promise<void> {
  await recordAdminAudit({
    repositories: services.repositories,
    config: services.config,
    context,
    eventType,
    result,
    errorCode
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

function isFile(value: FormDataEntryValue): value is File {
  return typeof value === "object" && value !== null && "arrayBuffer" in value && "size" in value;
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
