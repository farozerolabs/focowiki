import { Hono, type Context } from "hono";
import type { OpenAIResponsesClient } from "@focowiki/okf";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { apiVersion, readProductReleaseVersion } from "../release-version.js";
import { readTreeEntryTypeFilter } from "../tree-entry-filters.js";
import {
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

export type DeveloperOpenApiRouteServices = {
  config: RuntimeConfig;
  storage: StorageAdapter;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  modelClient: OpenAIResponsesClient | null;
};

export function registerDeveloperOpenApiRoutes(
  app: Hono,
  services: DeveloperOpenApiRouteServices
): void {
  const keyService = createDeveloperOpenApiKeyService(services);
  const requireAuth = requireDeveloperOpenApiAuth(services, keyService);
  const api = createDeveloperOpenApiService(services);

  app.use("/openapi/v1/*", requireAuth);

  app.get("/openapi/v1/health", (context) =>
    context.json({
      status: "ok"
    })
  );

  app.get("/openapi/v1/version", (context) =>
    context.json({
      product: "focowiki",
      version: readProductReleaseVersion(),
      apiVersion
    })
  );

  app.get("/openapi/v1/openapi.json", (context) => context.json(createDeveloperOpenApiDocument()));

  app.get("/openapi/v1/knowledge-bases", async (context) =>
    safe(context, () =>
      api.listKnowledgeBases({
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.post("/openapi/v1/knowledge-bases", async (context) =>
    safe(context, async () => {
      const body = await readJsonBody(context.req.raw);
      return api.createKnowledgeBase({
        name: typeof body.name === "string" ? body.name : "",
        description: typeof body.description === "string" ? body.description : null
      });
    }, 201)
  );

  app.get("/openapi/v1/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, () => api.getKnowledgeBase(context.req.param("knowledgeBaseId")))
  );

  app.delete("/openapi/v1/knowledge-bases/:knowledgeBaseId", async (context) =>
    safe(context, () => api.deleteKnowledgeBase(context.req.param("knowledgeBaseId")))
  );

  app.post("/openapi/v1/knowledge-bases/:knowledgeBaseId/uploads", async (context) =>
    safe(
      context,
      async () => {
        const formData = await context.req.formData();
        return api.uploadMarkdown({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          files: formData.getAll("files").filter((value): value is File => value instanceof File)
        });
      },
      202
    )
  );

  app.get("/openapi/v1/knowledge-bases/:knowledgeBaseId/source-files", async (context) =>
    safe(context, () =>
      api.listSourceFiles({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.get(
    "/openapi/v1/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    async (context) =>
      safe(context, () =>
        api.getSourceFile({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          sourceFileId: context.req.param("sourceFileId")
        })
      )
  );

  app.get(
    "/openapi/v1/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/events",
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
    "/openapi/v1/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    async (context) =>
      safe(
        context,
        () =>
          api.retrySourceFile({
            knowledgeBaseId: context.req.param("knowledgeBaseId"),
            sourceFileId: context.req.param("sourceFileId")
          }),
        202
      )
  );

  app.get("/openapi/v1/knowledge-bases/:knowledgeBaseId/tree", async (context) =>
    safe(context, () => {
      const entryType = readTreeEntryTypeFilter(context.req.query("entryType"));

      if (entryType === undefined) {
        throw validationError("Invalid tree entry type filter.", {
          allowedValues: ["file", "directory"]
        });
      }

      return api.listTree({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        parentPath: context.req.query("parentPath") ?? "",
        entryType,
        limit: readLimit(context.req.query("limit"), services.config, {
          defaultPageSize: services.config.pagination.treeDefaultPageSize,
          maxPageSize: services.config.pagination.treeMaxPageSize
        }),
        cursor: context.req.query("cursor") ?? null
      });
    })
  );

  app.get("/openapi/v1/knowledge-bases/:knowledgeBaseId/files/content", async (context) =>
    safe(context, () =>
      api.getFileContentByPath({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        path: context.req.query("path") ?? ""
      })
    )
  );

  app.get("/openapi/v1/knowledge-bases/:knowledgeBaseId/files/:fileId", async (context) =>
    safe(context, () =>
      api.getFileById({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        fileId: context.req.param("fileId")
      })
    )
  );

  app.get("/openapi/v1/knowledge-bases/:knowledgeBaseId/files/:fileId/related", async (context) =>
    safe(context, () =>
      api.listRelatedFiles({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        fileId: context.req.param("fileId"),
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.get("/openapi/v1/knowledge-bases/:knowledgeBaseId/files/:fileId/content", async (context) =>
    safe(context, () =>
      api.getFileContentById({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        fileId: context.req.param("fileId")
      })
    )
  );

  app.delete("/openapi/v1/knowledge-bases/:knowledgeBaseId/files/:fileId", async (context) =>
    safe(
      context,
      () =>
        api.deleteFileById({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          fileId: context.req.param("fileId")
        }),
      200
    )
  );

  app.delete("/openapi/v1/knowledge-bases/:knowledgeBaseId/files", async (context) =>
    safe(
      context,
      () =>
        api.deleteFileByPath({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          path: context.req.query("path") ?? ""
        }),
      200
    )
  );

  app.post("/openapi/v1/webhooks", async (context) =>
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

  app.get("/openapi/v1/webhooks", async (context) =>
    safe(context, () =>
      api.listWebhooks({
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.delete("/openapi/v1/webhooks/:webhookId", async (context) =>
    safe(context, () => api.deleteWebhook(context.req.param("webhookId")))
  );

  app.get("/openapi/v1/webhook-deliveries", async (context) =>
    safe(context, () =>
      api.listWebhookDeliveries({
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.post("/openapi/v1/webhook-deliveries/:deliveryId/redeliver", async (context) =>
    safe(context, () => api.redeliverWebhook(context.req.param("deliveryId")), 202)
  );

  app.all("/openapi/v1/*", (context) => writeDeveloperOpenApiError(context, unsupportedRoute()));
  app.all("/kb/*", (context) => writeDeveloperOpenApiError(context, unsupportedRoute()));
}

async function safe(
  context: Context,
  action: () => Promise<unknown> | unknown,
  status = 200
): Promise<Response> {
  try {
    return context.json(await action(), status as never);
  } catch (error) {
    return writeDeveloperOpenApiError(context, error);
  }
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

function readLimit(
  value: string | undefined,
  config: RuntimeConfig,
  limits: { defaultPageSize: number; maxPageSize: number } = config.pagination
): number {
  const parsed = value ? Number(value) : limits.defaultPageSize;

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > limits.maxPageSize) {
    throw validationError("Pagination limit is invalid.", { field: "limit" });
  }

  return parsed;
}
