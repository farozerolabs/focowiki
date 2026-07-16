import { Hono } from "hono";
import { createSourceResourceMutationService } from "../application/source-resource-mutations.js";
import { createSourceResourceService } from "../application/source-resources.js";
import { resolveWorkerConfig } from "../config.js";
import { SourceResourceError } from "../domain/source-resource.js";
import { resolveUploadGenerationSettings } from "../runtime-settings/upload-generation.js";
import { recordSecurityAudit } from "../security/audit.js";
import {
  conflict,
  notFound,
  payloadTooLarge,
  repositoryUnavailable,
  validationError,
  writeDeveloperOpenApiError
} from "./errors.js";
import { readLimit, safe } from "./route-helpers.js";
import type { DeveloperOpenApiRouteServices } from "./routes.js";

export function registerDeveloperOpenApiSourceResourceRoutes(
  app: Hono,
  services: DeveloperOpenApiRouteServices
): void {
  const requireService = () => {
    const repository = services.repositories?.sourceResources;
    if (!repository) throw repositoryUnavailable();
    return createSourceResourceService(repository, services.applicationRuntime);
  };
  const requireKnowledgeBase = async (knowledgeBaseId: string) => {
    const knowledgeBase = await services.repositories?.knowledgeBases.getKnowledgeBase(knowledgeBaseId);
    if (!knowledgeBase) throw notFound("Knowledge base was not found.");
    return knowledgeBase;
  };

  app.patch("/openapi/v2/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, async () => {
      const expectedResourceRevision = readExpectedRevision(context.req.header("if-match"));
      const body = await readJsonBody(context.req.raw);
      const name = body.name === undefined ? undefined : readOptionalName(body.name);
      const description = readOptionalDescription(body.description);
      if (name === undefined && description === undefined) {
        throw validationError("At least one mutable knowledge-base field is required.");
      }
      const mutation = await requireMutationService(services);
      const result = await mutation.service.updateKnowledgeBase(
        {
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          expectedResourceRevision,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description })
        },
        mutation.maxAttempts
      );
      const updated = result.knowledgeBase;
      if (!updated) throw conflict("Knowledge-base revision does not match the active resource.");
      return {
        knowledgeBase: {
          knowledgeBaseId: updated.id,
          name: updated.name,
          description: updated.description,
          activeReleaseId: updated.activeReleaseId,
          resourceRevision: updated.resourceRevision,
          catalogGeneration: updated.catalogGeneration,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt
        }
      };
    })
  );

  app.delete("/openapi/v2/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, async () => {
      const knowledgeBaseId = context.req.param("knowledgeBaseId");
      const result = await runSourceResourceMutation(() =>
        requireService().deleteKnowledgeBase({
          knowledgeBaseId,
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match"))
        })
      );
      if (!result.replayed) {
        const workerJobs = services.repositories?.workerJobs;
        if (!workerJobs?.enqueueHardDeleteJob) throw repositoryUnavailable();
        const now = new Date().toISOString();
        await workerJobs.cancelQueuedKnowledgeBaseJobs?.({
          knowledgeBaseId,
          cancelledAt: now,
          errorCode: "KNOWLEDGE_BASE_DELETED",
          errorMessage: "Knowledge base deletion superseded queued work."
        });
        await workerJobs.enqueueHardDeleteJob({
          knowledgeBaseId,
          targetKind: "knowledge_base",
          deletionIntentId: result.deletionIntentId,
          reason: "knowledge_base_deleted",
          runAfter: now,
          maxAttempts: 3
        });
      }
      return {
        deletion: {
          knowledgeBaseId,
          accepted: true,
          affectedDirectoryCount: result.affectedDirectoryCount,
          affectedFileCount: result.affectedFileCount
        }
      };
    }, 202)
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/source-directories", async (context) =>
    safe(context, async () => {
      await requireKnowledgeBase(context.req.param("knowledgeBaseId"));
      const parentDirectoryId = readNullableQuery(context.req.query("parentDirectoryId"));
      const page = await requireService().listDirectories({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        parentDirectoryId,
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      });
      return {
        items: page.items.map(toDirectoryResponse),
        nextCursor: page.nextCursor
      };
    })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    async (context) =>
      safe(context, async () => {
        const directory = await requireService().getDirectory({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          directoryId: context.req.param("directoryId")
        });
        if (!directory) throw notFound("Source directory was not found.");
        return { directory: toDirectoryResponse(directory) };
      })
  );

  app.patch(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    async (context) =>
      safe(context, async () => {
        const body = await readJsonBody(context.req.raw);
        const result = await acceptAndEnqueueOperation(services, {
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          kind: "source_directory_move",
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match")),
          targetKind: "source_directory",
          targetId: context.req.param("directoryId"),
          payload: { relativePath: body.relativePath }
        });
        return { operation: toOperationResponse(result.operation) };
      }, 202)
  );

  app.delete(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    async (context) =>
      safe(context, async () => {
        const idempotencyKey = context.req.header("idempotency-key")?.trim() ?? "";
        const expectedResourceRevision = readExpectedRevision(context.req.header("if-match"));
        const knowledgeBaseId = context.req.param("knowledgeBaseId");
        const directoryId = context.req.param("directoryId");
        const result = await runSourceResourceMutation(() =>
          requireService().deleteDirectory({
            knowledgeBaseId,
            directoryId,
            idempotencyKey,
            expectedResourceRevision
          })
        );
        if (!result.replayed) {
          const workerJobs = services.repositories?.workerJobs;
          if (!workerJobs?.enqueueResourceOperationJob) throw repositoryUnavailable();
          const runtimeWorker = (await services.runtimeSettings?.getSnapshot())?.worker;
          const worker = runtimeWorker ?? resolveWorkerConfig(services.config);
          await workerJobs.enqueueResourceOperationJob({
            knowledgeBaseId,
            operationId: result.operation.id,
            runAfter: new Date().toISOString(),
            maxAttempts: worker.jobMaxAttempts
          });
        }
        await recordSecurityAudit({
          repositories: services.repositories,
          config: services.config,
          context,
          eventType: "source_directory_delete_accepted",
          result: "success"
        });
        return {
          operation: toOperationResponse(result.operation),
          deletion: {
            directoryId: result.effectiveDirectoryId,
            affectedDirectoryCount: result.affectedDirectoryCount,
            affectedFileCount: result.affectedFileCount,
            visibility: "pending_processing"
          }
        };
      }, 202)
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files", async (context) =>
    safe(context, async () => {
      await requireKnowledgeBase(context.req.param("knowledgeBaseId"));
      const directoryId = context.req.query("directoryId");
      const page = await requireService().listSourceFiles({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        directoryId: directoryId === undefined ? undefined : readNullableQuery(directoryId),
        filters: readSourceResourceFilters(context.req.query()),
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      });
      return {
        items: page.items.map(toSourceFileResponse),
        nextCursor: page.nextCursor
      };
    })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    async (context) =>
      safe(context, async () => {
        const sourceFile = await requireService().getSourceFile({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sourceFileId: context.req.param("sourceFileId")
        });
        if (!sourceFile) throw notFound("Source file was not found.");
        return { sourceFile: toSourceFileResponse(sourceFile) };
      })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    async (context) => {
      try {
        const descriptor = await requireService().getSourceFileContentDescriptor({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sourceFileId: context.req.param("sourceFileId")
        });
        if (!descriptor) throw notFound("Source file was not found.");
        const settings = await resolveUploadGenerationSettings({
          config: services.config,
          runtimeSettings: services.runtimeSettings
        });
        const content = await services.storage.getObjectText(descriptor.objectKey, {
          maxBytes: settings.maxBytes
        });
        if (content === null) throw notFound("Source content was not found.");
        context.header("content-type", descriptor.contentType);
        context.header("etag", `\"${descriptor.checksumSha256}\"`);
        context.header("x-content-revision", String(descriptor.contentRevision));
        return context.body(content);
      } catch (error) {
        return writeDeveloperOpenApiError(context, error);
      }
    }
  );

  app.patch(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    async (context) =>
      safe(context, async () => {
        const body = await readJsonBody(context.req.raw);
        const result = await acceptAndEnqueueOperation(services, {
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          kind: "source_file_move",
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match")),
          targetKind: "source_file",
          targetId: context.req.param("sourceFileId"),
          payload: { relativePath: body.relativePath }
        });
        return { operation: toOperationResponse(result.operation) };
      }, 202)
  );

  app.put(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    async (context) =>
      safe(context, async () => {
        const settings = await resolveUploadGenerationSettings({
          config: services.config,
          runtimeSettings: services.runtimeSettings
        });
        const declaredLength = Number(context.req.header("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > settings.maxBytes) {
          throw payloadTooLarge("Markdown replacement exceeds the configured file limit.");
        }
        const bytes = new Uint8Array(await context.req.raw.arrayBuffer());
        if (bytes.byteLength === 0) {
          throw validationError("Markdown replacement body is required.");
        }
        if (bytes.byteLength > settings.maxBytes) {
          throw payloadTooLarge("Markdown replacement exceeds the configured file limit.");
        }
        const knowledgeBaseId = context.req.param("knowledgeBaseId");
        const sourceFileId = context.req.param("sourceFileId");
        const relativePath = context.req.header("x-source-relative-path")?.trim();
        const mutation = await requireMutationService(services);
        const result = await runSourceResourceMutation(() => mutation.service.replaceSourceContent({
          knowledgeBaseId,
          sourceFileId,
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match")),
          bytes,
          ...(relativePath ? { relativePath } : {}),
          maxAttempts: mutation.maxAttempts
        }));
        return { operation: toOperationResponse(result.operation) };
      }, 202)
  );

  app.delete(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    async (context) =>
      safe(context, async () => {
        const knowledgeBaseId = context.req.param("knowledgeBaseId");
        const sourceFileId = context.req.param("sourceFileId");
        const result = await runSourceResourceMutation(() =>
          requireService().deleteSourceFile({
            knowledgeBaseId,
            sourceFileId,
            idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
            expectedResourceRevision: readExpectedRevision(context.req.header("if-match"))
          })
        );
        if (!result.replayed) {
          const workerJobs = services.repositories?.workerJobs;
          if (!workerJobs?.enqueueHardDeleteJob) throw repositoryUnavailable();
          const now = new Date().toISOString();
          await workerJobs.cancelQueuedSourceFileJobs?.({
            knowledgeBaseId,
            sourceFileIds: [sourceFileId],
            cancelledAt: now,
            errorCode: "SOURCE_FILE_DELETED",
            errorMessage: "Source file was deleted before queued processing started."
          });
          await workerJobs.enqueuePublicationJob({
            knowledgeBaseId,
            reason: "deletion",
            targetCatalogGeneration: result.operation.candidateCatalogGeneration,
            runAfter: now,
            maxAttempts: 3,
            forceSuccessor: true
          });
          await workerJobs.enqueueHardDeleteJob({
            knowledgeBaseId,
            targetKind: "source_file",
            sourceFileId,
            deletionIntentId: result.deletionIntentId,
            reason: "source_file_deleted",
            runAfter: now,
            maxAttempts: 3
          });
        }
        return {
          operation: toOperationResponse(result.operation),
          deletion: { sourceFileId }
        };
      }, 202)
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/operations", async (context) =>
    safe(context, async () => {
      await requireKnowledgeBase(context.req.param("knowledgeBaseId"));
      const state = readOperationState(context.req.query("state"));
      const page = await requireService().listOperations({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        ...(state ? { states: [state] } : {}),
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      });
      return { items: page.items.map(toOperationResponse), nextCursor: page.nextCursor };
    })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/operations/:operationId",
    async (context) =>
      safe(context, async () => {
        const operation = await requireService().getOperation({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          operationId: context.req.param("operationId")
        });
        if (!operation) throw notFound("Resource operation was not found.");
        return { operation: toOperationResponse(operation) };
      })
  );
}

function toDirectoryResponse(directory: Awaited<ReturnType<ReturnType<typeof createSourceResourceService>["getDirectory"]>> & {}) {
  if (!directory) throw new SourceResourceError("RESOURCE_NOT_FOUND");
  const base = `/openapi/v2/knowledge-bases/${directory.knowledgeBaseId}`;
  return {
    directoryId: directory.id,
    knowledgeBaseId: directory.knowledgeBaseId,
    parentDirectoryId: directory.parentDirectoryId,
    name: directory.name,
    relativePath: directory.relativePath,
    generatedPath: `pages/${directory.relativePath}`,
    depth: directory.depth,
    resourceRevision: directory.resourceRevision,
    directFileCount: directory.directFileCount,
    descendantFileCount: directory.descendantFileCount,
    mutable: !directory.deleting,
    deletable: !directory.deleting,
    deleting: directory.deleting,
    actions: {
      self: `${base}/source-directories/${directory.id}`,
      children: `${base}/source-directories?parentDirectoryId=${encodeURIComponent(directory.id)}`,
      sourceFiles: `${base}/source-files?directoryId=${encodeURIComponent(directory.id)}`,
      generatedTree: `${base}/tree?parentPath=${encodeURIComponent(`pages/${directory.relativePath}`)}`
    },
    createdAt: directory.createdAt,
    updatedAt: directory.updatedAt
  };
}

export function toSourceFileResponse(sourceFile: NonNullable<Awaited<ReturnType<ReturnType<typeof createSourceResourceService>["getSourceFile"]>>>) {
  const base = `/openapi/v2/knowledge-bases/${sourceFile.knowledgeBaseId}`;
  return {
    sourceFileId: sourceFile.id,
    knowledgeBaseId: sourceFile.knowledgeBaseId,
    directoryId: sourceFile.directoryId,
    name: sourceFile.name,
    relativePath: sourceFile.relativePath,
    generatedPath: sourceFile.generatedPath,
    contentType: sourceFile.contentType,
    sizeBytes: sourceFile.sizeBytes,
    checksumSha256: sourceFile.checksumSha256,
    resourceRevision: sourceFile.resourceRevision,
    contentRevision: sourceFile.contentRevision,
    activeRevisionId: sourceFile.activeRevisionId,
    processingState: sourceFile.processingState,
    currentStage: sourceFile.currentStage,
    processingErrorCode: sourceFile.processingErrorCode,
    generatedOutputStatus: sourceFile.generatedOutputStatus,
    mutable: !sourceFile.deleting,
    deletable: !sourceFile.deleting,
    deleting: sourceFile.deleting,
    actions: {
      self: `${base}/source-files/${sourceFile.id}`,
      events: `${base}/source-files/${sourceFile.id}/events`,
      retry: `${base}/source-files/${sourceFile.id}/retry`,
      generatedContent: sourceFile.generatedPath
        ? `${base}/files/content?path=${encodeURIComponent(sourceFile.generatedPath)}`
        : null,
      search: `${base}/files/search?query=${encodeURIComponent(sourceFile.name)}`
    },
    createdAt: sourceFile.createdAt
  };
}

function toOperationResponse(operation: NonNullable<Awaited<ReturnType<ReturnType<typeof createSourceResourceService>["getOperation"]>>>) {
  const base = `/openapi/v2/knowledge-bases/${operation.knowledgeBaseId}`;
  return {
    operationId: operation.id,
    knowledgeBaseId: operation.knowledgeBaseId,
    kind: operation.kind,
    state: operation.state,
    expectedResourceRevision: operation.expectedResourceRevision,
    targetKind: operation.targetKind ?? null,
    targetId: operation.targetId ?? null,
    candidateRelativePath: operation.candidateRelativePath ?? null,
    result: toPublicOperationResult(operation.result),
    errorCode: operation.errorCode,
    retryGuidance: operation.state === "accepted" || operation.state === "processing" || operation.state === "publishing"
      ? "Read the operation again after a short delay."
      : null,
    actions: { self: `${base}/operations/${operation.id}` },
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt
  };
}

function toPublicOperationResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPublicOperationResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "deletionIntentId")
      .map(([key, nestedValue]) => [key, toPublicOperationResult(nestedValue)])
  );
}

function readExpectedRevision(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//u, "").replace(/^"|"$/gu, "");
  const revision = Number(normalized);
  if (!Number.isInteger(revision) || revision < 1) {
    throw validationError("If-Match must contain the active positive resource revision.", {
      field: "If-Match"
    });
  }
  return revision;
}

function readOptionalName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError("Knowledge-base name must be a non-empty string.", { field: "name" });
  }
  return value.trim();
}

function readOptionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw validationError("Knowledge-base description must be a string or null.", {
      field: "description"
    });
  }
  return value.trim() || null;
}

function readNullableQuery(value: string | undefined): string | null {
  if (!value || value === "root") return null;
  return value;
}

function readSourceResourceFilters(query: Record<string, string>) {
  const processingStates = new Set(["queued", "running", "completed", "failed"]);
  const currentStages = new Set([
    "upload_storage",
    "metadata_resolution",
    "llm_suggestion",
    "graph_generation",
    "okf_validation",
    "bundle_generation",
    "index_publication",
    "release_activation"
  ]);
  const generatedOutputStatuses = new Set(["pending", "visible", "unavailable"]);
  const pathQuery = readBoundedQueryText(query.pathQuery, "pathQuery", 1, 160);
  const sourceFileIdPrefix = readBoundedQueryText(
    query.sourceFileIdPrefix,
    "sourceFileIdPrefix",
    8,
    160
  );

  if (query.processingState && !processingStates.has(query.processingState)) {
    throw validationError("Source-file processing state filter is invalid.", {
      field: "processingState"
    });
  }
  if (query.currentStage && !currentStages.has(query.currentStage)) {
    throw validationError("Source-file current stage filter is invalid.", {
      field: "currentStage"
    });
  }
  if (query.generatedOutputStatus && !generatedOutputStatuses.has(query.generatedOutputStatus)) {
    throw validationError("Generated output status filter is invalid.", {
      field: "generatedOutputStatus"
    });
  }

  return {
    pathQuery,
    sourceFileIdPrefix,
    processingState: (query.processingState || null) as
      | "queued"
      | "running"
      | "completed"
      | "failed"
      | null,
    currentStage: query.currentStage || null,
    generatedOutputStatus: (query.generatedOutputStatus || null) as
      | "pending"
      | "visible"
      | "unavailable"
      | null
  };
}

function readBoundedQueryText(
  value: string | undefined,
  field: string,
  minLength: number,
  maxLength: number
): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw validationError("Source-file text filter length is invalid.", { field });
  }
  return normalized;
}

function readOperationState(value: string | undefined) {
  if (!value) return undefined;
  const allowed = new Set([
    "accepted", "validating", "processing", "publishing", "completed", "failed", "cancelled", "superseded"
  ]);
  if (!allowed.has(value)) throw validationError("Resource operation state is invalid.");
  return value as "accepted" | "validating" | "processing" | "publishing" | "completed" | "failed" | "cancelled" | "superseded";
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function runSourceResourceMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof SourceResourceError)) throw error;
    if (error.code === "RESOURCE_NOT_FOUND") throw notFound();
    if (error.code === "INVALID_RESOURCE_MUTATION") {
      throw validationError("Mutation headers or payload are invalid.");
    }
    throw conflict(error.code);
  }
}

async function acceptAndEnqueueOperation(
  services: DeveloperOpenApiRouteServices,
  input: Parameters<ReturnType<typeof createSourceResourceService>["acceptOperation"]>[0]
) {
  const mutation = await requireMutationService(services);
  return runSourceResourceMutation(() => mutation.service.acceptOperation(input, mutation.maxAttempts));
}

async function requireMutationService(services: DeveloperOpenApiRouteServices) {
  const repository = services.repositories?.sourceResources;
  const workerJobs = services.repositories?.workerJobs;
  if (!repository || !workerJobs?.enqueueResourceOperationJob) throw repositoryUnavailable();
  const runtimeWorker = (await services.runtimeSettings?.getSnapshot())?.worker;
  const worker = runtimeWorker ?? resolveWorkerConfig(services.config);
  return {
    service: createSourceResourceMutationService({
      repository,
      worker: {
        enqueueResourceOperationJob: workerJobs.enqueueResourceOperationJob.bind(workerJobs),
        enqueuePublicationJob: workerJobs.enqueuePublicationJob.bind(workerJobs)
      },
      storage: {
        sourceRevisionKey: services.storage.keyspace.sourceRevisionKey,
        put: (object) => services.storage.putObject(object),
        delete: async (key) => {
          await services.storage.deleteObject?.(key);
        }
      },
      runtime: services.applicationRuntime
    }),
    maxAttempts: worker.jobMaxAttempts
  };
}

function readIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!key) throw validationError("Idempotency-Key is required.", { field: "Idempotency-Key" });
  return key;
}
