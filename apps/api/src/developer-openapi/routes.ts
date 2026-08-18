import { Hono } from "hono";
import { apiVersion, readProductReleaseVersion } from "../release-version.js";
import { readTreeEntryTypeFilter } from "../tree-entry-filters.js";
import { isAllowedPublicGeneratedDirectoryPath } from "../public-generated-path.js";
import {
  repositoryUnavailable,
  unsupportedRoute,
  validationError,
  writeDeveloperOpenApiError
} from "./errors.js";
import { createDeveloperOpenApiDocument } from "./openapi-document.js";
import { registerDeveloperOpenApiFileSearchRoutes } from "./file-search-routes.js";
import { registerDeveloperOpenApiGraphExpansionRoutes } from "./graph-expansion-routes.js";
import { createDeveloperOpenApiBodyLimit } from "./security.js";
import { registerDeveloperOpenApiUploadSessionRoutes } from "./upload-session-routes.js";
import { registerDeveloperOpenApiWebhookRoutes } from "./webhook-routes.js";
import {
  registerDeveloperOpenApiSourceResourceRoutes,
  toSourceFileResponse
} from "./source-resource-routes.js";
import {
  readDeveloperJsonObjectBody,
  readLimit,
  safe
} from "./route-helpers.js";
import { installDeveloperOpenApiDiagnosticBoundary } from "./route-helpers.js";
import {
  readKnowledgeBaseDescription,
  readKnowledgeBaseName
} from "./knowledge-base-input.js";
import type { StorageVnextOpenApiRouteContext } from "../storage-vnext/api/openapi-route-context.js";

export type DeveloperOpenApiRouteServices = StorageVnextOpenApiRouteContext;

export function registerDeveloperOpenApiRoutes(
  app: Hono,
  services: DeveloperOpenApiRouteServices
): void {
  const { api, requireAuth } = services;
  const openApiDocument = createDeveloperOpenApiDocument();

  installDeveloperOpenApiDiagnosticBoundary(app, {
    logger: services.logger,
    operationIds: createOperationIdMap(openApiDocument.paths)
  });

  app.use("/openapi/v2/*", requireAuth);
  app.use("/openapi/v2/*", createDeveloperOpenApiBodyLimit(services.config));

  app.get("/openapi/v2/health", (context) =>
    context.json({
      status: "ok"
    })
  );

  app.get("/openapi/v2/version", (context) =>
    context.json({
      product: "focowiki",
      version: readProductReleaseVersion(),
      apiVersion
    })
  );

  app.get("/openapi/v2/openapi.json", (context) => context.json(openApiDocument));

  app.get("/openapi/v2/knowledge-bases", async (context) =>
    safe(context, () =>
      api.listKnowledgeBases({
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.post("/openapi/v2/knowledge-bases", async (context) =>
    safe(context, async () => {
      const body = await readDeveloperJsonObjectBody(
        context.req.raw,
        ["name", "description"]
      );
      const created = await api.createKnowledgeBase({
        name: readKnowledgeBaseName(body.name),
        description: readKnowledgeBaseDescription(body.description)
      });
      const knowledgeBaseId = readNestedResponseId(
        created,
        "knowledgeBase",
        "knowledgeBaseId"
      );
      await services.auditApplication.record({
        context,
        eventType: "knowledge_base_create",
        result: "success",
        knowledgeBaseId,
        targetKind: "knowledge_base",
        targetPublicId: knowledgeBaseId
      });
      return created;
    }, 201)
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, () => api.getKnowledgeBase(context.req.param("knowledgeBaseId")))
  );

  registerDeveloperOpenApiUploadSessionRoutes(app, services);
  registerDeveloperOpenApiSourceResourceRoutes(app, services, api);

  app.post(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    async (context) =>
      safe(
        context,
        async () => {
          const knowledgeBaseId = context.req.param("knowledgeBaseId");
          const sourceFileId = context.req.param("sourceFileId");
          const retry = await api.retrySourceFile({ knowledgeBaseId, sourceFileId });
          const sourceFile = await api.getSourceFile({
            knowledgeBaseId,
            sourceFileId
          });

          if (!sourceFile) {
            throw repositoryUnavailable();
          }

          await services.auditApplication.record({
            context,
            eventType: "source_file_retry_accepted",
            result: "success",
            knowledgeBaseId,
            targetKind: "source_file",
            targetPublicId: sourceFileId
          });

          return {
            sourceFile: toSourceFileResponse(sourceFile),
            retry: {
              kind: retry.kind,
              scope: retry.scope,
              coalesced: retry.coalesced
            }
          };
        },
        202
      )
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/tree", async (context) =>
    safe(context, () => {
      if (context.req.query("query") !== undefined) {
        throw validationError("Tree search is not supported. Use the file search endpoint.", {
          field: "query"
        });
      }
      const entryType = readTreeEntryTypeFilter(context.req.query("entryType"));

      if (entryType === undefined) {
        throw validationError("Invalid tree entry type filter.", {
          allowedValues: ["file", "directory"]
        });
      }

      return api.listTree({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        parentPath: readOpenApiTreeParentPath(context.req.query("parentPath")),
        entryType,
        query: null,
        limit: readLimit(context.req.query("limit"), services.config, {
          defaultPageSize: services.config.pagination.treeDefaultPageSize,
          maxPageSize: services.config.pagination.treeMaxPageSize
        }),
        cursor: context.req.query("cursor") ?? null
      });
    })
  );

  registerDeveloperOpenApiFileSearchRoutes(app, {
    api,
    config: services.config,
    redis: services.redis,
    runtimeSettings: services.runtimeSettings
  });

  registerDeveloperOpenApiGraphExpansionRoutes(app, {
    api,
    config: services.config,
    runtimeSettings: services.runtimeSettings
  });

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/graph/overview", async (context) =>
    safe(context, () =>
      api.getGraphOverview({
        knowledgeBaseId: context.req.param("knowledgeBaseId")
      })
    )
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/files/content", async (context) =>
    safe(context, () =>
      api.getFileContentByPath({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        path: context.req.query("path") ?? ""
      })
    )
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/files/:fileId", async (context) =>
    safe(context, () =>
      api.getFileById({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        fileId: context.req.param("fileId")
      })
    )
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/files/:fileId/related", async (context) =>
    safe(context, () =>
      api.listRelatedFiles({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        fileId: context.req.param("fileId"),
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/files/:fileId/content", async (context) =>
    safe(context, () =>
      api.getFileContentById({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        fileId: context.req.param("fileId")
      })
    )
  );

  registerDeveloperOpenApiWebhookRoutes(app, services);

  app.all("/openapi/v2/*", (context) => writeDeveloperOpenApiError(context, unsupportedRoute()));
  app.all("/kb/*", (context) => writeDeveloperOpenApiError(context, unsupportedRoute()));
}

export function readOpenApiTreeParentPath(value: string | undefined): string {
  if (value === undefined || value === "root") return "";
  if (!isAllowedPublicGeneratedDirectoryPath(value)) {
    throw validationError("Tree parent path is invalid.", { field: "parentPath" });
  }
  return value;
}

function readNestedResponseId(
  response: Record<string, unknown>,
  objectField: string,
  idField: string
): string {
  const nested = response[objectField];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw repositoryUnavailable();
  }
  const id = (nested as Record<string, unknown>)[idField];
  if (typeof id !== "string" || id.trim() === "") throw repositoryUnavailable();
  return id;
}

function createOperationIdMap(
  paths: Record<string, Record<string, Record<string, unknown>>>
): Map<string, string> {
  const operationIds = new Map<string, string>();
  for (const [path, methods] of Object.entries(paths)) {
    const routeTemplate = path.replace(/\{([^}]+)\}/gu, ":$1");
    for (const [method, operation] of Object.entries(methods)) {
      if (typeof operation.operationId === "string") {
        operationIds.set(`${method.toUpperCase()} ${routeTemplate}`, operation.operationId);
      }
    }
  }
  return operationIds;
}
