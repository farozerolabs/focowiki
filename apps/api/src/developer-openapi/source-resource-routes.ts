import { Hono } from "hono";
import { SourceResourceError } from "../domain/source-resource.js";
import { SourcePathValidationError } from "../domain/source-path.js";
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
import type { StorageVnextAdminMutationApplication } from
  "../storage-vnext/api/admin-mutation-application.js";
import { presentDeveloperResourceOperation } from "./resource-operation-presenter.js";
import {
  readKnowledgeBaseDescription,
  readKnowledgeBaseName
} from "./knowledge-base-input.js";

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
      if (!result.knowledgeBase) {
        throw conflict("The knowledge-base version in If-Match is no longer current.");
      }
      await recordResourceAudit(services, context, {
        eventType: "knowledge_base_metadata_updated",
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        targetKind: "knowledge_base",
        targetPublicId: context.req.param("knowledgeBaseId")
      });
      return {
        knowledgeBase: toDeveloperKnowledgeBase(result.knowledgeBase)
      };
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
      await recordResourceAudit(services, context, {
        eventType: "knowledge_base_delete_accepted",
        knowledgeBaseId,
        targetKind: "knowledge_base",
        targetPublicId: knowledgeBaseId
      });
      return {
        operation: presentDeveloperResourceOperation(result.operation),
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
          relativePath: readRequiredRelativePath(body.relativePath)
        }));
        await recordResourceAudit(services, context, {
          eventType: "source_directory_move_accepted",
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          targetKind: "source_directory",
          targetPublicId: context.req.param("directoryId")
        });
        return { operation: presentDeveloperResourceOperation(result.operation) };
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
        await recordResourceAudit(services, context, {
          eventType: "source_directory_delete_accepted",
          knowledgeBaseId,
          targetKind: "source_directory",
          targetPublicId: result.effectiveDirectoryId
        });
        return {
          operation: presentDeveloperResourceOperation(result.operation),
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
          relativePath: readRequiredRelativePath(body.relativePath)
        }));
        await recordResourceAudit(services, context, {
          eventType: "source_file_move_accepted",
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          targetKind: "source_file",
          targetPublicId: context.req.param("sourceFileId")
        });
        return { operation: presentDeveloperResourceOperation(result.operation) };
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
        await recordResourceAudit(services, context, {
          eventType: "source_file_replace_accepted",
          knowledgeBaseId,
          targetKind: "source_file",
          targetPublicId: sourceFileId
        });
        return { operation: presentDeveloperResourceOperation(result.operation) };
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
        await recordResourceAudit(services, context, {
          eventType: "source_file_delete_accepted",
          knowledgeBaseId,
          targetKind: "source_file",
          targetPublicId: sourceFileId
        });
        return {
          operation: presentDeveloperResourceOperation(result.operation),
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
        items: page.items.map(presentDeveloperResourceOperation),
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
        return { operation: presentDeveloperResourceOperation(operation) };
      })
  );
}

async function recordResourceAudit(
  services: DeveloperOpenApiRouteServices,
  context: Parameters<DeveloperOpenApiRouteServices["auditApplication"]["record"]>[0]["context"],
  input: {
    eventType: string;
    knowledgeBaseId: string;
    targetKind: "knowledge_base" | "source_directory" | "source_file";
    targetPublicId: string;
  }
): Promise<void> {
  await services.auditApplication.record({
    context,
    eventType: input.eventType,
    result: "success",
    knowledgeBaseId: input.knowledgeBaseId,
    targetKind: input.targetKind,
    targetPublicId: input.targetPublicId
  });
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
    blockingWorkKind: sourceFile.blockingWorkKind,
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
    state: lifecycle.state,
    workProgress: {
      required: sourceFile.requiredWorkCount,
      completed: sourceFile.completedWorkCount,
      activeKinds: sourceFile.activeWorkKinds,
      blockingKind: lifecycle.blockingWorkKind,
      retryingKind: sourceFile.retryingWorkKind
    },
    failure: lifecycle.failure,
    generatedOutputStatus: sourceFile.generatedOutputStatus,
    actions: lifecycle.actions.map((kind) =>
      developerLifecycleAction(base, sourceFile.id, sourceFile.generatedPath, kind)
    ),
    links: {
      self: `${base}/source-files/${sourceFile.id}`,
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
    case "retry_document_processing":
      return {
        kind,
        method: "POST" as const,
        href: `${sourceBase}/retry`,
        scope: "source_file" as const
      };
    case "replace_source_content":
      return {
        kind,
        method: "PUT" as const,
        href: `${sourceBase}/content`,
        scope: "source_file" as const
      };
    case "view_failure_details":
      return { kind, method: "GET" as const, href: sourceBase, scope: "source_file" as const };
  }
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
  return readKnowledgeBaseName(value);
}

function readRequiredRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError("Relative path must be a non-empty string.", {
      field: "relativePath"
    });
  }
  return value;
}

function readOptionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return readKnowledgeBaseDescription(value);
}

export function readNullableQuery(value: string | undefined): string | null {
  if (value === undefined || value === "root") return null;
  if (!value) {
    throw validationError("Directory filter must be `root` or a non-empty identifier.");
  }
  if (value.length > 200) {
    throw validationError("Directory filter must not exceed 200 characters.");
  }
  return value;
}

function readSourceResourceFilters(query: Record<string, string>) {
  const lifecycleStates = new Set([
    "waiting", "processing", "available", "error", "deleting"
  ]);
  const workKinds = new Set([
    "prepare", "first_layer", "content_projection", "graphrag",
    "relation_reconcile", "knowledge_projection", "activate", "cleanup"
  ]);
  const generatedOutputStatuses = new Set([
    "unavailable", "previous_available", "current_available"
  ]);
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
  if (query.blockingWorkKind && !workKinds.has(query.blockingWorkKind)) {
    throw validationError("File blocking work filter is invalid.", {
      field: "blockingWorkKind"
    });
  }
  if (query.generatedOutputStatus && !generatedOutputStatuses.has(query.generatedOutputStatus)) {
    throw validationError("Readable-file availability filter is invalid.", {
      field: "generatedOutputStatus"
    });
  }

  return {
    pathQuery,
    sourceFileIdPrefix,
    state: (query.state || null) as
      | "waiting"
      | "processing"
      | "available"
      | "error"
      | "deleting"
      | null,
    blockingWorkKind: (query.blockingWorkKind || null) as
      | "prepare" | "first_layer" | "content_projection" | "graphrag"
      | "relation_reconcile" | "knowledge_projection" | "activate"
      | "cleanup" | null,
    generatedOutputStatus: (query.generatedOutputStatus || null) as
      | "unavailable"
      | "previous_available"
      | "current_available"
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
    "processing", "completed", "failed", "cancelled", "superseded"
  ]);
  if (!allowed.has(value)) throw validationError("File or directory change status is invalid.");
  return value as "processing" | "completed" | "failed" | "cancelled" | "superseded";
}

async function runSourceResourceMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SourcePathValidationError) {
      throw validationError("Relative path is invalid.", { field: "relativePath" });
    }
    if (!(error instanceof SourceResourceError)) throw error;
    if (error.code === "RESOURCE_NOT_FOUND") throw notFound();
    if (error.code === "INVALID_PAGINATION") {
      throw validationError("Cursor is invalid.", { field: "cursor" });
    }
    if (error.code === "INVALID_RESOURCE_MUTATION") {
      throw validationError("Request headers or body are invalid.");
    }
    if (error.code === "RESOURCE_CONTENT_TOO_LARGE") {
      throw validationError("Markdown replacement body exceeds the configured source limit.");
    }
    throw conflict(error.code);
  }
}
