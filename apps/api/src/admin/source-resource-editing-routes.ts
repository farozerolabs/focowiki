import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { RuntimeConfig } from "../config.js";
import { SourceResourceError, type ResourceOperationRecord } from "../domain/source-resource.js";
import { readPageLimit } from "./pagination.js";
import type { StorageVnextAdminAuditApplication } from "../storage-vnext/api/admin-audit-application.js";
import type { StorageVnextAdminMutationApplication } from "../storage-vnext/api/admin-mutation-application.js";

export function registerAdminSourceResourceEditingRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    application: StorageVnextAdminMutationApplication;
    audit: StorageVnextAdminAuditApplication;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  app.patch(
    "/admin/api/knowledge-bases/:knowledgeBaseId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const body = await readJsonBody(context.req.raw);
      const name = body.name === undefined ? undefined : readName(body.name);
      const description = readDescription(body.description);
      if (name === undefined && description === undefined) return invalid(context, "errors.invalidKnowledgeBase");
      try {
        const result = await services.application.updateKnowledgeBase({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          expectedResourceRevision: readRevision(context.req.header("if-match")),
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description })
        });
        if (!result.knowledgeBase) return conflict(context, "RESOURCE_REVISION_CONFLICT");
        await audit(context, services, "knowledge_base_metadata_updated");
        return context.json({
          knowledgeBase: result.knowledgeBase,
          publicationQueued: result.publicationQueued
        });
      } catch (error) {
        return mutationError(context, error);
      }
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories",
    middlewares.requireAuth,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const limit = readPageLimit(context.req.query("limit"), services.config);
      if (!limit) return invalid(context, "errors.invalidPagination");
      const page = await services.application.listDirectories({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        parentDirectoryId: readNullableId(context.req.query("parentDirectoryId")),
        limit,
        cursor: context.req.query("cursor") ?? null
      });
      return context.json({ items: page.items.map(directoryResponse), nextCursor: page.nextCursor });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    middlewares.requireAuth,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const directory = await services.application.getDirectory({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        directoryId: context.req.param("directoryId")
      });
      return directory ? context.json({ directory: directoryResponse(directory) }) : notFound(context);
    }
  );

  app.patch(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const body = await readJsonBody(context.req.raw);
      try {
        const result = await services.application.moveSourceDirectory({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readRevision(context.req.header("if-match")),
          targetId: context.req.param("directoryId"),
          relativePath: readRelativePath(body.relativePath)
        });
        await audit(context, services, "source_directory_move_accepted");
        return context.json({ operation: operationResponse(result.operation) }, 202);
      } catch (error) {
        return mutationError(context, error);
      }
    }
  );

  app.delete(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const body = await readJsonBody(context.req.raw);
      const expectedResourceRevision = Number(body.expectedResourceRevision);
      if (!Number.isInteger(expectedResourceRevision) || expectedResourceRevision < 1) {
        return invalid(context, "errors.invalidResourceRevision");
      }
      try {
        const result = await services.application.deleteSourceDirectory({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          directoryId: context.req.param("directoryId"),
          idempotencyKey: context.req.header("idempotency-key")?.trim() || null,
          expectedResourceRevision
        });
        await audit(context, services, "source_directory_delete_accepted");
        return context.json({
          accepted: true,
          operationId: result.operation.id,
          directoryId: result.effectiveDirectoryId,
          affectedDirectoryCount: result.affectedDirectoryCount,
          affectedFileCount: result.affectedFileCount
        }, 202);
      } catch (error) {
        return mutationError(context, error);
      }
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    middlewares.requireAuth,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const source = await services.application.readSourceContent({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sourceFileId: context.req.param("sourceFileId")
      });
      if (!source) return notFound(context);
      return new Response(source.content, {
        headers: {
          "content-type": source.contentType,
          etag: `\"${source.resourceRevision}\"`,
          "x-content-revision": String(source.contentRevision)
        }
      });
    }
  );

  app.patch(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const body = await readJsonBody(context.req.raw);
      try {
        const result = await services.application.moveSourceFile({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readRevision(context.req.header("if-match")),
          targetId: context.req.param("sourceFileId"),
          relativePath: readRelativePath(body.relativePath)
        });
        await audit(context, services, "source_file_move_accepted");
        return context.json({ operation: operationResponse(result.operation) }, 202);
      } catch (error) {
        return mutationError(context, error);
      }
    }
  );

  app.put(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const bytes = new Uint8Array(await context.req.raw.arrayBuffer());
      if (bytes.byteLength === 0) return invalid(context, "errors.sourceContentRequired");
      try {
        const relativePath = context.req.header("x-source-relative-path")?.trim();
        const result = await services.application.replaceSourceFileContent({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sourceFileId: context.req.param("sourceFileId"),
          expectedResourceRevision: readRevision(context.req.header("if-match")),
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          bytes,
          ...(relativePath ? { relativePath } : {})
        });
        await audit(context, services, "source_file_replacement_accepted");
        return context.json({ operation: operationResponse(result.operation) }, 202);
      } catch (error) {
        return mutationError(context, error);
      }
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/operations",
    middlewares.requireAuth,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const limit = readPageLimit(context.req.query("limit"), services.config);
      if (!limit) return invalid(context, "errors.invalidPagination");
      const state = readOperationState(context.req.query("state"));
      const activeStates: ResourceOperationRecord["state"][] = [
        "accepted", "validating", "processing", "publishing"
      ];
      const page = await services.application.listOperations({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        states: state ? [state] : activeStates,
        limit,
        cursor: context.req.query("cursor") ?? null
      });
      return context.json({ items: page.items.map(operationResponse), nextCursor: page.nextCursor });
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/operations/:operationId",
    middlewares.requireAuth,
    async (context) => {
      if (!services.application.available()) return unavailable(context);
      const operation = await services.application.getOperation({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        operationId: context.req.param("operationId")
      });
      return operation ? context.json({ operation: operationResponse(operation) }) : notFound(context);
    }
  );
}

function directoryResponse(
  directory: NonNullable<Awaited<ReturnType<StorageVnextAdminMutationApplication["getDirectory"]>>>
) {
  return {
    directoryId: directory.id,
    knowledgeBaseId: directory.knowledgeBaseId,
    parentDirectoryId: directory.parentDirectoryId,
    name: directory.name,
    relativePath: directory.relativePath,
    resourceRevision: directory.resourceRevision,
    directFileCount: directory.directFileCount,
    descendantFileCount: directory.descendantFileCount,
    mutable: !directory.deleting,
    deleting: directory.deleting
  };
}

function operationResponse(operation: ResourceOperationRecord) {
  return {
    operationId: operation.id,
    knowledgeBaseId: operation.knowledgeBaseId,
    kind: operation.kind,
    state: operation.state,
    expectedResourceRevision: operation.expectedResourceRevision,
    targetKind: operation.targetKind ?? null,
    targetId: operation.targetId ?? null,
    candidateRelativePath: operation.candidateRelativePath ?? null,
    result: operation.result,
    errorCode: operation.errorCode,
    retryGuidance: ["accepted", "validating", "processing", "publishing"].includes(operation.state)
      ? "retry_after_short_delay"
      : null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt
  };
}

async function audit(
  context: Parameters<MiddlewareHandler>[0],
  services: Parameters<typeof registerAdminSourceResourceEditingRoutes>[1],
  eventType: string
) {
  await services.audit.record({
    context,
    eventType,
    result: "success"
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readRevision(value: string | undefined): number {
  const revision = Number(value?.trim().replace(/^W\//u, "").replace(/^"|"$/gu, ""));
  if (!Number.isInteger(revision) || revision < 1) throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return revision;
}

function readIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!key) throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return key;
}

function readName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return value.trim();
}

function readDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return value.trim() || null;
}

function readRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return value.trim();
}

function readNullableId(value: string | undefined): string | null {
  return !value || value === "root" ? null : value;
}

function readOperationState(value: string | undefined): ResourceOperationRecord["state"] | undefined {
  if (!value) return undefined;
  const states: ResourceOperationRecord["state"][] = [
    "accepted", "validating", "processing", "publishing", "completed", "failed", "cancelled", "superseded"
  ];
  if (!states.includes(value as ResourceOperationRecord["state"])) throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return value as ResourceOperationRecord["state"];
}

function mutationError(context: Parameters<MiddlewareHandler>[0], error: unknown): Response {
  if (!(error instanceof SourceResourceError)) {
    return context.json({ error: { code: "INTERNAL_ERROR", messageKey: "errors.editFailed" } }, 500);
  }
  if (error.code === "RESOURCE_NOT_FOUND") return notFound(context);
  if (error.code === "INVALID_RESOURCE_MUTATION") return invalid(context, "errors.invalidResourceMutation");
  return conflict(context, error.code);
}

function conflict(context: Parameters<MiddlewareHandler>[0], code: string): Response {
  const keys: Record<string, string> = {
    RESOURCE_REVISION_CONFLICT: "errors.resourceRevisionConflict",
    RESOURCE_PATH_CONFLICT: "errors.resourcePathConflict",
    RESOURCE_BUSY: "errors.resourceBusy",
    RESOURCE_DELETING: "errors.resourceDeleting",
    IDEMPOTENCY_CONFLICT: "errors.idempotencyConflict"
  };
  return context.json({ error: { code, messageKey: keys[code] ?? "errors.editFailed" } }, 409);
}

function invalid(context: Parameters<MiddlewareHandler>[0], messageKey: string): Response {
  return context.json({ error: { code: "VALIDATION_ERROR", messageKey } }, 422);
}

function notFound(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json({ error: { code: "NOT_FOUND", messageKey: "errors.notFound" } }, 404);
}

function unavailable(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json({ error: { code: "DATABASE_REPOSITORY_UNAVAILABLE", messageKey: "errors.serviceUnavailable" } }, 503);
}
