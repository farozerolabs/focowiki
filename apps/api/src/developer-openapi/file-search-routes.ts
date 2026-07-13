import type { Hono } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import { validationError } from "./errors.js";
import { readDeveloperFileSearchFilters } from "./file-search-filters.js";
import { readLimit, safe } from "./route-helpers.js";
import type { createDeveloperOpenApiService } from "./services.js";

type DeveloperOpenApiServiceApi = ReturnType<typeof createDeveloperOpenApiService>;

export function registerDeveloperOpenApiFileSearchRoutes(
  app: Hono,
  services: {
    api: DeveloperOpenApiServiceApi;
    config: RuntimeConfig;
    redis: RedisCoordinator | null;
    runtimeSettings: RuntimeSettingsService | null;
  }
): void {
  app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/files/search", async (context) => {
    return safe(context, async () => {
      const graphSettings = (await services.runtimeSettings?.getSnapshot())?.graph;
      const filters = readDeveloperFileSearchFilters({
        query: context.req.query("query"),
        scope: context.req.query("scope"),
        fileKind: context.req.query("fileKind"),
        mode: context.req.query("mode"),
        graphDepth: context.req.query("graphDepth"),
        graphFanout: context.req.query("graphFanout"),
        graphSettings
      });

      if (!filters.ok) {
        throw validationError("File search query is invalid.", {
          code: filters.code
        });
      }

      return services.api.searchFiles({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        query: filters.query,
        scope: filters.scope,
        fileKind: filters.fileKind,
        mode: filters.mode,
        graphDepth: filters.graphDepth,
        graphFanout: filters.graphFanout,
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      });
    });
  });
}
