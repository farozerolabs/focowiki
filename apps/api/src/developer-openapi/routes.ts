import { Hono } from "hono";
import type { OpenAIModelClient } from "@focowiki/okf";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import type { StorageAdapter } from "../storage/s3.js";
import { createSourceResourceService } from "../application/source-resources.js";
import type { ApplicationRuntime } from "../application/ports/runtime.js";
import type { UploadSessionStoragePort } from "../application/ports/upload-session-storage.js";
import { apiVersion, readProductReleaseVersion } from "../release-version.js";
import { readTreeEntryTypeFilter } from "../tree-entry-filters.js";
import {
  repositoryUnavailable,
  unsupportedRoute,
  validationError,
  writeDeveloperOpenApiError
} from "./errors.js";
import {
  createDeveloperOpenApiKeyService,
  requireDeveloperOpenApiAuth
} from "./security.js";
import { createDeveloperOpenApiService } from "./services.js";
import { createDeveloperOpenApiDocument } from "./openapi-document.js";
import { registerDeveloperOpenApiFileSearchRoutes } from "./file-search-routes.js";
import { registerDeveloperOpenApiGraphExpansionRoutes } from "./graph-expansion-routes.js";
import { registerDeveloperOpenApiUploadSessionRoutes } from "./upload-session-routes.js";
import {
  registerDeveloperOpenApiSourceResourceRoutes,
  toSourceFileResponse
} from "./source-resource-routes.js";
import { readLimit, safe } from "./route-helpers.js";
import type { ActiveGenerationReadRepository } from "../application/ports/active-generation-read-repository.js";
import type { RoleJobRepository } from "../application/ports/role-job-repository.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { SourceFileRetryRepository } from "../application/ports/source-file-retry-repository.js";

export type DeveloperOpenApiRouteServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  modelClient: OpenAIModelClient | null;
  runtimeSettings: RuntimeSettingsService | null;
  applicationRuntime: ApplicationRuntime;
  uploadSessionStorage: UploadSessionStoragePort;
  activeGenerationReads: ActiveGenerationReadRepository | null;
  roleJobs: RoleJobRepository | null;
  publicationGenerations: PublicationGenerationRepository | null;
  sourceFileRetries: SourceFileRetryRepository | null;
};

export function registerDeveloperOpenApiRoutes(
  app: Hono,
  services: DeveloperOpenApiRouteServices
): void {
  const keyService = createDeveloperOpenApiKeyService(services);
  const requireAuth = requireDeveloperOpenApiAuth(services, keyService);
  const api = createDeveloperOpenApiService(services);
  const openApiDocument = createDeveloperOpenApiDocument();

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
      const body = await readJsonBody(context.req.raw);
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
  registerDeveloperOpenApiSourceResourceRoutes(app, services);

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
          const sourceResources = services.repositories?.sourceResources;

          if (!sourceResources) {
            throw repositoryUnavailable();
          }

          const sourceFile = await createSourceResourceService(
            sourceResources,
            services.applicationRuntime
          ).getSourceFile({
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

  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/graph/insights", async (context) =>
    safe(context, () =>
      api.getGraphInsights({
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
      const body = await readJsonBody(context.req.raw);
      return api.createWebhook({
        name: typeof body.name === "string" ? body.name : null,
        url: typeof body.url === "string" ? body.url : "",
        events: Array.isArray(body.events)
          ? body.events.filter((event): event is string => typeof event === "string")
          : []
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

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
