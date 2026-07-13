import { Hono, type MiddlewareHandler } from "hono";
import { createSourceResourceService } from "../application/source-resources.js";
import { resolveWorkerConfig, type RuntimeConfig } from "../config.js";
import { SourceResourceError } from "../domain/source-resource.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import type { ApplicationRuntime } from "../application/ports/runtime.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";
import { recordAdminAudit } from "./security.js";

export function registerAdminSourceDirectoryDeletionRoutes(
  app: Hono,
  services: {
    repositories: AdminRepositories | null;
    redis: RedisCoordinator | null;
    config: RuntimeConfig;
    runtimeSettings: RuntimeSettingsService | null;
    applicationRuntime: ApplicationRuntime;
  },
  middlewares: { requireAuth: MiddlewareHandler; requireWriteProtection: MiddlewareHandler }
): void {
  app.delete(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      const repository = services.repositories?.sourceResources;
      const workerJobs = services.repositories?.workerJobs;
      if (!repository || !workerJobs || !services.redis) {
        return context.json({ error: { code: "DATABASE_REPOSITORY_UNAVAILABLE" } }, 503);
      }
      const body = await readJsonBody(context.req.raw);
      const expectedResourceRevision = Number(body.expectedResourceRevision);
      if (!Number.isInteger(expectedResourceRevision) || expectedResourceRevision < 1) {
        return context.json({ error: { code: "INVALID_RESOURCE_REVISION" } }, 422);
      }
      const knowledgeBaseId = context.req.param("knowledgeBaseId");
      try {
        const result = await createSourceResourceService(
          repository,
          services.applicationRuntime
        ).deleteDirectory({
          knowledgeBaseId,
          directoryId: context.req.param("directoryId"),
          idempotencyKey:
            context.req.header("idempotency-key")?.trim() ||
            services.applicationRuntime.ids.create("admin-delete"),
          expectedResourceRevision
        });
        if (!result.replayed) {
          const now = services.applicationRuntime.clock.now().toISOString();
          if (!workerJobs.enqueueResourceOperationJob) {
            return context.json({ error: { code: "DATABASE_REPOSITORY_UNAVAILABLE" } }, 503);
          }
          const worker = services.runtimeSettings
            ? (await services.runtimeSettings.getSnapshot()).worker
            : resolveWorkerConfig(services.config);
          await workerJobs.enqueueResourceOperationJob({
            knowledgeBaseId,
            operationId: result.operation.id,
            runAfter: now,
            maxAttempts: worker.jobMaxAttempts
          });
          await invalidateKnowledgeBaseCaches({
            redis: services.redis,
            knowledgeBaseId,
            releaseId: null,
            ttlSeconds: 900
          });
        }
        await recordAdminAudit({
          repositories: services.repositories,
          config: services.config,
          context,
          eventType: "source_directory_delete_accepted",
          result: "success"
        });
        return context.json({
          accepted: true,
          operationId: result.operation.id,
          directoryId: result.effectiveDirectoryId,
          affectedDirectoryCount: result.affectedDirectoryCount,
          affectedFileCount: result.affectedFileCount
        }, 202);
      } catch (error) {
        if (!(error instanceof SourceResourceError)) throw error;
        const status = error.code === "RESOURCE_NOT_FOUND" ? 404 : 409;
        return context.json({ error: { code: error.code } }, status);
      }
    }
  );
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
