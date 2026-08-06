import { Hono } from "hono";
import { apiVersion, readProductReleaseVersion } from "../release-version.js";
import { readTreeEntryTypeFilter } from "../tree-entry-filters.js";
import {
  repositoryUnavailable,
  unsupportedRoute,
  validationError,
  writeDeveloperOpenApiError
} from "./errors.js";
import { createDeveloperOpenApiDocument } from "./openapi-document.js";
import { registerDeveloperOpenApiFileSearchRoutes } from "./file-search-routes.js";
import { registerDeveloperOpenApiGraphExpansionRoutes } from "./graph-expansion-routes.js";
import { registerDeveloperOpenApiUploadSessionRoutes } from "./upload-session-routes.js";
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
      if (
        body.description !== undefined
        && body.description !== null
        && typeof body.description !== "string"
      ) {
        throw validationError("Knowledge-base description must be a string or null.", {
          field: "description"
        });
      }
      return api.createKnowledgeBase({
        name: typeof body.name === "string" ? body.name : "",
        description: typeof body.description === "string" ? body.description : null
      });
    }, 201)
  );

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, () => api.getKnowledgeBase(context.req.param("knowledgeBaseId")))
  );

  registerDeveloperOpenApiUploadSessionRoutes(app, services);
  registerDeveloperOpenApiSourceResourceRoutes(app, services, api);

  app.get(
    "/openapi/v2/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/events",
    async (context) =>
      safe(context, () =>
        api.listSourceFileEvents({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sourceFileId: context.req.param("sourceFileId"),
          limit: readLimit(context.req.query("limit"), services.config),
          cursor: context.req.query("cursor") ?? null
        })
      )
  );

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
      const entryType = readTreeEntryTypeFilter(context.req.query("entryType"));

      if (entryType === undefined) {
        throw validationError("Invalid tree entry type filter.", {
          allowedValues: ["file", "directory"]
        });
      }

      return api.listTree({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        parentPath: context.req.query("parentPath") ?? "pages",
        entryType,
        query: context.req.query("query") ?? null,
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

  app.post("/openapi/v2/webhooks", async (context) =>
    safe(context, async () => {
      const body = await readDeveloperJsonObjectBody(
        context.req.raw,
        ["name", "url", "events"]
      );
      if (
        body.name !== undefined
        && body.name !== null
        && typeof body.name !== "string"
      ) {
        throw validationError("Webhook name must be a string or null.", {
          field: "name"
        });
      }
      if (!Array.isArray(body.events) || !body.events.every((event) => typeof event === "string")) {
        throw validationError("Webhook events must be an array of strings.", {
          field: "events"
        });
      }
      return api.createWebhook({
        name: typeof body.name === "string" ? body.name : null,
        url: typeof body.url === "string" ? body.url : "",
        events: body.events
      });
    }, 201)
  );

  app.get("/openapi/v2/webhooks", async (context) =>
    safe(context, () =>
      api.listWebhooks({
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.delete("/openapi/v2/webhooks/:webhookId", async (context) =>
    safe(context, () => api.deleteWebhook(context.req.param("webhookId")))
  );

  app.get("/openapi/v2/webhook-deliveries", async (context) =>
    safe(context, () =>
      api.listWebhookDeliveries({
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.post("/openapi/v2/webhook-deliveries/:deliveryId/redeliver", async (context) =>
    safe(context, () => api.redeliverWebhook(context.req.param("deliveryId")), 202)
  );

  app.all("/openapi/v2/*", (context) => writeDeveloperOpenApiError(context, unsupportedRoute()));
  app.all("/kb/*", (context) => writeDeveloperOpenApiError(context, unsupportedRoute()));
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
