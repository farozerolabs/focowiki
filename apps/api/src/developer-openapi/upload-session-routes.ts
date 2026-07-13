import { Hono, type Context } from "hono";
import { resolveWorkerConfig } from "../config.js";
import { createUploadSessionService } from "../application/upload-sessions.js";
import { UploadSessionError, type UploadSessionEntryRecord } from "../domain/upload-session.js";
import { SourcePathValidationError } from "../domain/source-path.js";
import { resolveUploadGenerationSettings } from "../runtime-settings/upload-generation.js";
import { recordSecurityAudit } from "../security/audit.js";
import {
  conflict,
  notFound,
  payloadTooLarge,
  repositoryUnavailable,
  validationError
} from "./errors.js";
import { readLimit, safe } from "./route-helpers.js";
import type { DeveloperOpenApiRouteServices } from "./routes.js";

export function registerDeveloperOpenApiUploadSessionRoutes(
  app: Hono,
  services: DeveloperOpenApiRouteServices
): void {
  const prefix = "/openapi/v2/knowledge-bases/:knowledgeBaseId/upload-sessions";

  app.post(prefix, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const body = await readJsonBody(context.req.raw);
      const idempotencyKey = context.req.header("idempotency-key")?.trim() ?? "";
      if (
        !idempotencyKey ||
        !isNonNegativeInteger(body.declaredFileCount) ||
        !isNonNegativeInteger(body.declaredByteCount)
      ) {
        throw validationError("Upload session totals and Idempotency-Key are required.");
      }
      const declaredFileCount = body.declaredFileCount;
      const declaredByteCount = body.declaredByteCount;
      const session = await run(() =>
        environment.service.createSession({
          knowledgeBaseId: environment.knowledgeBaseId,
          idempotencyKey,
          declaredFileCount,
          declaredByteCount
        })
      );
      await recordUploadSessionAudit(services, context, "upload_session_created", "success");
      return {
        session: toSafeSession(session),
        limits: {
          manifestPageSize: environment.settings.manifestPageSize,
          contentBatchMaxFiles: environment.settings.contentBatchMaxFiles,
          contentBatchMaxBytes: environment.settings.contentBatchMaxBytes,
          maxFileBytes: environment.settings.maxBytes
        }
      };
    }, 201)
  );

  app.post(`${prefix}/:uploadSessionId/entries`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const body = await readJsonBody(context.req.raw);
      if (!Array.isArray(body.entries) || body.entries.length > environment.settings.manifestPageSize) {
        await recordUploadSessionAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_MANIFEST_PAGE");
        throw validationError("Manifest page is invalid.");
      }
      const entries = body.entries.map(readManifestEntry);
      if (entries.some((entry) => entry === null)) {
        await recordUploadSessionAudit(services, context, "upload_session_invalid_path", "failure", "INVALID_MANIFEST_ENTRY");
        throw validationError("Manifest entry is invalid.");
      }
      return {
        session: toSafeSession(
          await run(
            () => environment.service.addManifestEntries({
              knowledgeBaseId: environment.knowledgeBaseId,
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
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const session = await run(() =>
        environment.service.sealManifest({
          knowledgeBaseId: environment.knowledgeBaseId,
          sessionId: context.req.param("uploadSessionId")
        })
      );
      await recordUploadSessionAudit(services, context, "upload_session_sealed", "success");
      return { session: toSafeSession(session) };
    })
  );

  app.post(`${prefix}/:uploadSessionId/content`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const form = await context.req.formData();
      const parts = [...form.entries()].filter((entry): entry is [string, File] => isFile(entry[1]));
      if (parts.length === 0 || parts.length > environment.settings.contentBatchMaxFiles) {
        throw validationError("Content batch file count is invalid.");
      }
      if (parts.reduce((sum, [, file]) => sum + file.size, 0) > environment.settings.contentBatchMaxBytes) {
        throw validationError("Content batch byte count is invalid.");
      }
      const entries: UploadSessionEntryRecord[] = [];
      for (const [entryId, file] of parts) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        entries.push(
          await run(() =>
            environment.service.putEntryContent({
              knowledgeBaseId: environment.knowledgeBaseId,
              sessionId: context.req.param("uploadSessionId"),
              entryId,
              bytes
            })
          )
        );
      }
      return { entries: entries.map(toSafeEntry) };
    })
  );

  app.get(`${prefix}/:uploadSessionId`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const sessionId = context.req.param("uploadSessionId");
      const session = await run(() =>
        environment.service.getSession({
          knowledgeBaseId: environment.knowledgeBaseId,
          sessionId
        })
      );
      const state = readTransferState(context.req.query("transferState"));
      if (context.req.query("transferState") && !state) {
        throw validationError("Upload entry transferState is invalid.");
      }
      const page = await environment.service.listEntries({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId,
        ...(state ? { transferState: state } : {}),
        limit: readLimit(context.req.query("limit"), services.config, {
          defaultPageSize: environment.settings.manifestPageSize,
          maxPageSize: environment.settings.manifestPageSize
        }),
        cursor: context.req.query("cursor") ?? null
      });
      return {
        session: toSafeSession(session),
        entries: { items: page.items.map(toSafeEntry), nextCursor: page.nextCursor }
      };
    })
  );

  app.post(`${prefix}/:uploadSessionId/reconcile`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      return {
        session: toSafeSession(
          await run(() => environment.service.reconcileReservations({
            knowledgeBaseId: environment.knowledgeBaseId,
            sessionId: context.req.param("uploadSessionId")
          }))
        )
      };
    })
  );

  app.post(`${prefix}/:uploadSessionId/finalize`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const session = await run(() => environment.service.finalizeSession({
        knowledgeBaseId: environment.knowledgeBaseId,
        sessionId: context.req.param("uploadSessionId")
      }));
      await recordUploadSessionAudit(services, context, "upload_session_finalized", "success");
      return {
        session: toSafeSession(
          session
        )
      };
    }, 202)
  );

  app.delete(`${prefix}/:uploadSessionId`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const session = await run(() => environment.service.cancelSession({
        knowledgeBaseId: environment.knowledgeBaseId,
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

async function createEnvironment(services: DeveloperOpenApiRouteServices, knowledgeBaseId: string) {
  const repository = services.repositories?.uploadSessions;
  if (!repository || !services.repositories?.workerJobs) {
    throw repositoryUnavailable();
  }
  const knowledgeBase = await services.repositories.knowledgeBases.getKnowledgeBase(knowledgeBaseId);
  if (!knowledgeBase) {
    throw notFound("Knowledge base was not found.");
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
      repository,
      storage: services.uploadSessionStorage,
      runtime: services.applicationRuntime,
      sessionTtlSeconds: settings.sessionTtlSeconds,
      maxFileBytes: settings.maxBytes,
      finalization: {
        enqueue: async ({ knowledgeBaseId: id, sessionId }) => {
          if (!workerJobs?.enqueueUploadSessionFinalizationJob) {
            throw repositoryUnavailable();
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

async function run<T>(operation: () => Promise<T>, onInvalidPath?: () => Promise<void>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SourcePathValidationError) {
      await onInvalidPath?.();
      throw validationError("Upload manifest contains an invalid relative path.", {
        field: "relativePath",
        reason: error.code
      });
    }
    if (error instanceof UploadSessionError) {
      if (error.code.endsWith("NOT_FOUND")) throw notFound(error.code);
      if (error.code === "UPLOAD_FILE_TOO_LARGE") throw payloadTooLarge(error.code);
      if (error.code.includes("MISMATCH") || error.code.includes("DUPLICATE")) {
        throw validationError(error.code);
      }
      throw conflict(error.code);
    }
    throw error;
  }
}

async function recordUploadSessionAudit(
  services: DeveloperOpenApiRouteServices,
  context: Context,
  eventType: string,
  result: "success" | "failure" | "blocked",
  errorCode: string | null = null
): Promise<void> {
  await recordSecurityAudit({
    repositories: services.repositories,
    config: services.config,
    context,
    eventType,
    result,
    errorCode
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

function toSafeSession(session: Awaited<ReturnType<ReturnType<typeof createUploadSessionService>["getSession"]>>) {
  return {
    id: session.id,
    knowledgeBaseId: session.knowledgeBaseId,
    state: session.state,
    declaredFileCount: session.declaredFileCount,
    declaredByteCount: session.declaredByteCount,
    counts: session.counts,
    errorCode: session.errorCode,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt
  };
}

function readManifestEntry(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.relativePath === "string" &&
    isNonNegativeInteger(record.declaredSize) &&
    typeof record.checksumSha256 === "string"
    ? {
        relativePath: record.relativePath,
        declaredSize: record.declaredSize,
        checksumSha256: record.checksumSha256
      }
    : null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function readTransferState(value: string | undefined): "missing" | "failed" | "uploaded" | null {
  return value === "missing" || value === "failed" || value === "uploaded" ? value : null;
}

function isFile(value: FormDataEntryValue): value is File {
  return typeof value === "object" && value !== null && "arrayBuffer" in value && "size" in value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
