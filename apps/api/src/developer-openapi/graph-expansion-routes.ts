import type { Hono } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import { validationError } from "./errors.js";
import { readDeveloperGraphExpansionFilters } from "./graph-expansion-filters.js";
import { readLimit, safe } from "./route-helpers.js";
import type { createDeveloperOpenApiService } from "./services.js";

type DeveloperOpenApiServiceApi = ReturnType<typeof createDeveloperOpenApiService>;

export function registerDeveloperOpenApiGraphExpansionRoutes(
  app: Hono,
  services: {
    api: DeveloperOpenApiServiceApi;
    config: RuntimeConfig;
    runtimeSettings: RuntimeSettingsService | null;
  }
): void {
  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/graph/expand", async (context) => {
    return safe(context, async () => {
      const graphSettings = (await services.runtimeSettings?.getSnapshot())?.graph;
      const filters = readDeveloperGraphExpansionFilters({
        fileId: context.req.query("fileId"),
        nodeId: context.req.query("nodeId"),
        edgeId: context.req.query("edgeId"),
        query: context.req.query("query"),
        depth: context.req.query("depth"),
        fanout: context.req.query("fanout"),
        graphSettings
      });

      if (!filters.ok) {
        throw validationError("Graph expansion query is invalid.", {
          code: filters.code
        });
      }

      return services.api.expandGraph({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        fileId: filters.fileId,
        nodeId: filters.nodeId,
        edgeId: filters.edgeId,
        query: filters.query,
        depth: filters.depth,
        fanout: filters.fanout,
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      });
    });
  });
}
