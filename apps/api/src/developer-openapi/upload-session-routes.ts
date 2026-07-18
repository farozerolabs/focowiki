import { Hono, type Context } from "hono";
import {
  createUploadSessionService,
  UPLOAD_MANIFEST_PAGE_SIZE,
  UPLOAD_SESSION_TTL_SECONDS
} from "../application/upload-sessions.js";
import { UploadSessionError, type UploadSessionEntryRecord } from "../domain/upload-session.js";
import { SourcePathValidationError } from "../domain/source-path.js";
import { recordSecurityAudit } from "../security/audit.js";
import {
  conflict,
  notFound,
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
        transport: {
          manifestPageSize: UPLOAD_MANIFEST_PAGE_SIZE
        }
      };
    }, 201)
  );

  app.post(`${prefix}/:uploadSessionId/entries`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const body = await readJsonBody(context.req.raw);
      if (!Array.isArray(body.entries) || body.entries.length > UPLOAD_MANIFEST_PAGE_SIZE) {
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

  app.put(`${prefix}/:uploadSessionId/entries/:entryId/content`, async (context) =>
    safe(context, async () => {
      const environment = await createEnvironment(services, context.req.param("knowledgeBaseId"));
      const body = context.req.raw.body;
      if (!body || !isMarkdownContentType(context.req.header("content-type"))) {
        throw validationError("A text/markdown request body is required.");
      }
      const entry = await run(() =>
        environment.service.putEntryContent({
          knowledgeBaseId: environment.knowledgeBaseId,
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
          defaultPageSize: UPLOAD_MANIFEST_PAGE_SIZE,
          maxPageSize: UPLOAD_MANIFEST_PAGE_SIZE
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
    })
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
  const repositories = services.repositories;
  const repository = repositories?.uploadSessions;
  if (!repository) {
    throw repositoryUnavailable();
  }
  const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(knowledgeBaseId);
  if (!knowledgeBase) {
    throw notFound("Knowledge base was not found.");
  }
  return {
    knowledgeBaseId,
    service: createUploadSessionService({
      repository,
      storage: services.uploadSessionStorage,
      runtime: services.applicationRuntime,
      sessionTtlSeconds: UPLOAD_SESSION_TTL_SECONDS
    })
  };
}

function isMarkdownContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "text/markdown";
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
    (record.checksumSha256 === undefined || record.checksumSha256 === null || typeof record.checksumSha256 === "string")
    ? {
        relativePath: record.relativePath,
        declaredSize: record.declaredSize,
        checksumSha256: record.checksumSha256 ?? null
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
