import { Hono } from "hono";
import { SourceResourceError } from "../domain/source-resource.js";
import {
  deriveSourceFileLifecycle,
  type SourceFileLifecycleActionKind
} from "../domain/source-file-lifecycle.js";
import {
  conflict,
  notFound,
  repositoryUnavailable,
  validationError,
  writeDeveloperOpenApiError
} from "./errors.js";
import {
  readDeveloperJsonObjectBody,
  readLimit,
  safe
} from "./route-helpers.js";
import type { DeveloperOpenApiRouteServices } from "./routes.js";
import type { DeveloperOpenApiApplication } from "./services.js";
import { toDeveloperKnowledgeBase } from "./serializers.js";
import {
  readSourceResourceCursor,
  sourceResourceCursorScope,
  writeSourceResourceCursor
} from "./source-resource-pagination.js";
import { readIdempotencyKey } from "./idempotency-key.js";
import type { StorageVnextAdminMutationApplication } from "../storage-vnext/api/admin-mutation-application.js";
import { sanitizeStorageVnextPublicValue } from "../storage-vnext/api/public-output-sanitizer.js";

export function registerDeveloperOpenApiSourceResourceRoutes(
  app: Hono,
  services: DeveloperOpenApiRouteServices,
  api: DeveloperOpenApiApplication
): void {
  const requireSourceApplication = () => {
    if (!services.sourceApplication.available()) throw repositoryUnavailable();
    return services.sourceApplication;
  };
  const requireKnowledgeBase = async (knowledgeBaseId: string) => {
    const knowledgeBase = await requireSourceApplication().getKnowledgeBase({ knowledgeBaseId });
    if (!knowledgeBase) throw notFound("Knowledge base was not found.");
    return knowledgeBase;
  };

  app.patch("/openapi/v2/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, async () => {
      const expectedResourceRevision = readExpectedRevision(context.req.header("if-match"));
      const body = await readDeveloperJsonObjectBody(
        context.req.raw,
        ["name", "description"]
      );
      const name = body.name === undefined ? undefined : readOptionalName(body.name);
      const description = readOptionalDescription(body.description);
      if (name === undefined && description === undefined) {
        throw validationError("Provide a knowledge-base name or description to update.");
      }
      const result = await runSourceResourceMutation(() =>
        requireSourceApplication().updateKnowledgeBase({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          expectedResourceRevision,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description })
        })
      );
      const updated = result.knowledgeBase;
      if (!updated) throw conflict("The knowledge-base version in If-Match is no longer current.");
      return { knowledgeBase: toDeveloperKnowledgeBase(updated) };
    })
  );

  app.delete("/openapi/v2/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, async () => {
      const knowledgeBaseId = context.req.param("knowledgeBaseId");
      const result = await runSourceResourceMutation(() =>
        requireSourceApplication().deleteKnowledgeBase({
          knowledgeBaseId,
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match"))
        })
      );
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
      const knowledgeBaseId = context.req.param("knowledgeBaseId");
      await requireKnowledgeBase(knowledgeBaseId);
      const parentDirectoryId = readNullableQuery(context.req.query("parentDirectoryId"));
      const scope = sourceResourceCursorScope(
        "directories",
        knowledgeBaseId,
        { parentDirectoryId }
      );
      const page = await requireSourceApplication().listDirectories({
        knowledgeBaseId,
        parentDirectoryId,
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: await readSourceResourceCursor(
          services.redis,
          scope,
          context.req.query("cursor") ?? null
        )
      });
      return {
        items: page.items.map(toDirectoryResponse),
        nextCursor: await writeSourceResourceCursor(
          services.redis,
          scope,
          page.nextCursor,
          services.config.pagination.cursorTtlSeconds
        )
      };
    })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    async (context) =>
      safe(context, async () => {
        const directory = await requireSourceApplication().getDirectory({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          directoryId: context.req.param("directoryId")
        });
        if (!directory) throw notFound("Uploaded directory was not found.");
        return { directory: toDirectoryResponse(directory) };
      })
  );

  app.patch(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    async (context) =>
      safe(context, async () => {
        const body = await readDeveloperJsonObjectBody(context.req.raw, ["relativePath"]);
        const result = await runSourceResourceMutation(() =>
          requireSourceApplication().moveSourceDirectory({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match")),
          targetId: context.req.param("directoryId"),
          relativePath: body.relativePath as string
        }));
        return { operation: toOperationResponse(result.operation) };
      }, 202)
  );

  app.delete(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    async (context) =>
      safe(context, async () => {
        const idempotencyKey = readIdempotencyKey(
          context.req.header("idempotency-key")
        );
        const expectedResourceRevision = readExpectedRevision(context.req.header("if-match"));
        const knowledgeBaseId = context.req.param("knowledgeBaseId");
        const directoryId = context.req.param("directoryId");
        const result = await runSourceResourceMutation(() =>
          requireSourceApplication().deleteSourceDirectory({
            knowledgeBaseId,
            directoryId,
            idempotencyKey,
            expectedResourceRevision
          })
        );
        await services.auditApplication.record({
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
      const knowledgeBaseId = context.req.param("knowledgeBaseId");
      await requireKnowledgeBase(knowledgeBaseId);
      const directoryId = context.req.query("directoryId");
      const resolvedDirectoryId = directoryId === undefined
        ? undefined
        : readNullableQuery(directoryId);
      const filters = readSourceResourceFilters(context.req.query());
      const scope = sourceResourceCursorScope("files", knowledgeBaseId, {
        directoryId: resolvedDirectoryId,
        filters
      });
      const page = await requireSourceApplication().listSourceFiles({
        knowledgeBaseId,
        directoryId: resolvedDirectoryId,
        filters,
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: await readSourceResourceCursor(
          services.redis,
          scope,
          context.req.query("cursor") ?? null
        )
      });
      return {
        items: page.items.map(toSourceFileResponse),
        nextCursor: await writeSourceResourceCursor(
          services.redis,
          scope,
          page.nextCursor,
          services.config.pagination.cursorTtlSeconds
        )
      };
    })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    async (context) =>
      safe(context, async () => {
        const sourceFile = await requireSourceApplication().getSourceFile({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sourceFileId: context.req.param("sourceFileId")
        });
        if (!sourceFile) throw notFound("Uploaded file was not found.");
        return { sourceFile: toSourceFileResponse(sourceFile) };
      })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    async (context) => {
      try {
        const source = await api.readSourceContent({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sourceFileId: context.req.param("sourceFileId")
        });
        return new Response(source.content, {
          headers: {
            "content-type": source.contentType,
            etag: `\"${source.resourceRevision}\"`,
            "x-content-revision": String(source.contentRevision)
          }
        });
      } catch (error) {
        return writeDeveloperOpenApiError(context, error);
      }
    }
  );

  app.patch(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    async (context) =>
      safe(context, async () => {
        const body = await readDeveloperJsonObjectBody(context.req.raw, ["relativePath"]);
        const result = await runSourceResourceMutation(() =>
          requireSourceApplication().moveSourceFile({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match")),
          targetId: context.req.param("sourceFileId"),
          relativePath: body.relativePath as string
        }));
        return { operation: toOperationResponse(result.operation) };
      }, 202)
  );

  app.put(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    async (context) =>
      safe(context, async () => {
        if (!isMarkdownContentType(context.req.header("content-type"))) {
          throw validationError("A text/markdown request body is required.");
        }
        const bytes = new Uint8Array(await context.req.raw.arrayBuffer());
        if (bytes.byteLength === 0) {
          throw validationError("Markdown replacement body is required.");
        }
        const knowledgeBaseId = context.req.param("knowledgeBaseId");
        const sourceFileId = context.req.param("sourceFileId");
        const relativePath = context.req.header("x-source-relative-path")?.trim();
        const result = await runSourceResourceMutation(() =>
          requireSourceApplication().replaceSourceFileContent({
          knowledgeBaseId,
          sourceFileId,
          idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
          expectedResourceRevision: readExpectedRevision(context.req.header("if-match")),
          bytes,
          ...(relativePath ? { relativePath } : {})
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
          requireSourceApplication().deleteSourceFile({
            knowledgeBaseId,
            sourceFileId,
            idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
            expectedResourceRevision: readExpectedRevision(context.req.header("if-match"))
          })
        );
        return {
          operation: toOperationResponse(result.operation),
          deletion: { sourceFileId }
        };
      }, 202)
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/operations", async (context) =>
    safe(context, async () => {
      const knowledgeBaseId = context.req.param("knowledgeBaseId");
      await requireKnowledgeBase(knowledgeBaseId);
      const state = readOperationState(context.req.query("state"));
      const scope = sourceResourceCursorScope(
        "operations",
        knowledgeBaseId,
        { state }
      );
      const page = await requireSourceApplication().listOperations({
        knowledgeBaseId,
        ...(state ? { states: [state] } : {}),
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: await readSourceResourceCursor(
          services.redis,
          scope,
          context.req.query("cursor") ?? null
        )
      });
      return {
        items: page.items.map(toOperationResponse),
        nextCursor: await writeSourceResourceCursor(
          services.redis,
          scope,
          page.nextCursor,
          services.config.pagination.cursorTtlSeconds
        )
      };
    })
  );

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/operations/:operationId",
    async (context) =>
      safe(context, async () => {
        const operation = await requireSourceApplication().getOperation({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          operationId: context.req.param("operationId")
        });
        if (!operation) throw notFound("File or directory change was not found.");
        return { operation: toOperationResponse(operation) };
      })
  );
}

function isMarkdownContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "text/markdown";
}

function toDirectoryResponse(
  directory: NonNullable<Awaited<ReturnType<StorageVnextAdminMutationApplication["getDirectory"]>>>
) {
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

export function toSourceFileResponse(
  sourceFile: NonNullable<Awaited<ReturnType<StorageVnextAdminMutationApplication["getSourceFile"]>>>
) {
  const base = `/openapi/v2/knowledge-bases/${sourceFile.knowledgeBaseId}`;
  const lifecycle = deriveSourceFileLifecycle({
    processingStatus: sourceFile.processingStatus,
    processingStage: sourceFile.currentStage,
    generatedOutputStatus: sourceFile.generatedOutputStatus,
    generatedPath: sourceFile.generatedPath,
    failure: sourceFile.terminalFailure
  });
  return {
    sourceFileId: sourceFile.id,
    knowledgeBaseId: sourceFile.knowledgeBaseId,
    directoryId: sourceFile.directoryId,
    name: sourceFile.name,
    relativePath: sourceFile.relativePath,
    generatedPath: sourceFile.generatedPath,
    contentType: sourceFile.contentType,
    sizeBytes: sourceFile.sizeBytes,
    resourceRevision: sourceFile.resourceRevision,
    contentRevision: sourceFile.contentRevision,
    activeRevisionId: sourceFile.activeRevisionId,
    state: lifecycle.state,
    currentStage: lifecycle.currentStage,
    failure: lifecycle.failure,
    generatedOutputStatus: sourceFile.generatedOutputStatus,
    mutable: !sourceFile.deleting,
    deletable: !sourceFile.deleting,
    deleting: sourceFile.deleting,
    actions: lifecycle.actions.map((kind) =>
      developerLifecycleAction(base, sourceFile.id, sourceFile.generatedPath, kind)
    ),
    links: {
      self: `${base}/source-files/${sourceFile.id}`,
      events: `${base}/source-files/${sourceFile.id}/events`,
      generatedContent: sourceFile.generatedPath
        ? `${base}/files/content?path=${encodeURIComponent(sourceFile.generatedPath)}`
        : null,
      search: `${base}/files/search?query=${encodeURIComponent(sourceFile.name)}`
    },
    createdAt: sourceFile.createdAt
  };
}

function developerLifecycleAction(
  base: string,
  sourceFileId: string,
  generatedPath: string | null,
  kind: SourceFileLifecycleActionKind
) {
  const sourceBase = `${base}/source-files/${sourceFileId}`;
  switch (kind) {
    case "open_generated_file":
      return {
        kind,
        method: "GET" as const,
        href: generatedPath
          ? `${base}/files/content?path=${encodeURIComponent(generatedPath)}`
          : sourceBase,
        scope: "source_file" as const
      };
    case "retry_publication":
      return {
        kind,
        method: "POST" as const,
        href: `${sourceBase}/retry`,
        scope: "knowledge_base_publication" as const
      };
    case "retry_source_processing":
      return {
        kind,
        method: "POST" as const,
        href: `${sourceBase}/retry`,
        scope: "source_file" as const
      };
    case "view_failure_details":
      return { kind, method: "GET" as const, href: sourceBase, scope: "source_file" as const };
  }
}

function toOperationResponse(
  operation: NonNullable<Awaited<ReturnType<StorageVnextAdminMutationApplication["getOperation"]>>>
) {
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
    result: sanitizeStorageVnextPublicValue(operation.result),
    errorCode: operation.errorCode,
    retryGuidance: operation.state === "accepted" || operation.state === "processing" || operation.state === "publishing"
      ? "Check this change again after a short delay."
      : null,
    actions: { self: `${base}/operations/${operation.id}` },
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt
  };
}

function readExpectedRevision(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//u, "").replace(/^"|"$/gu, "");
  const revision = Number(normalized);
  if (!Number.isInteger(revision) || revision < 1) {
    throw validationError("If-Match must contain the current positive `resourceRevision` value.", {
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
  const lifecycleStates = new Set(["queued", "running", "pending_publication", "visible", "failed"]);
  const currentStages = new Set([
    "upload_storage",
    "metadata_resolution",
    "llm_suggestion",
    "graph_generation",
    "projection_generation",
    "generation_validation",
    "generation_activation"
  ]);
  const generatedOutputStatuses = new Set(["pending", "visible", "unavailable"]);
  const pathQuery = readBoundedQueryText(query.pathQuery, "pathQuery", 1, 160);
  const sourceFileIdPrefix = readBoundedQueryText(
    query.sourceFileIdPrefix,
    "sourceFileIdPrefix",
    8,
    160
  );

  if (query.processingState !== undefined) {
    throw validationError("Source-file processingState filter is not supported. Use state.", {
      field: "processingState"
    });
  }
  if (query.state && !lifecycleStates.has(query.state)) {
    throw validationError("File processing status filter is invalid.", {
      field: "state"
    });
  }
  if (query.currentStage && !currentStages.has(query.currentStage)) {
    throw validationError("File processing step filter is invalid.", {
      field: "currentStage"
    });
  }
  if (query.generatedOutputStatus && !generatedOutputStatuses.has(query.generatedOutputStatus)) {
    throw validationError("Published-file availability filter is invalid.", {
      field: "generatedOutputStatus"
    });
  }

  return {
    pathQuery,
    sourceFileIdPrefix,
    state: (query.state || null) as
      | "queued"
      | "running"
      | "pending_publication"
      | "visible"
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
    throw validationError("Filter text length is invalid.", { field });
  }
  return normalized;
}

function readOperationState(value: string | undefined) {
  if (!value) return undefined;
  const allowed = new Set([
    "accepted", "validating", "processing", "publishing", "completed", "failed", "cancelled", "superseded"
  ]);
  if (!allowed.has(value)) throw validationError("File or directory change status is invalid.");
  return value as "accepted" | "validating" | "processing" | "publishing" | "completed" | "failed" | "cancelled" | "superseded";
}

async function runSourceResourceMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof SourceResourceError)) throw error;
    if (error.code === "RESOURCE_NOT_FOUND") throw notFound();
    if (error.code === "INVALID_RESOURCE_MUTATION") {
      throw validationError("Request headers or body are invalid.");
    }
    throw conflict(error.code);
  }
}
