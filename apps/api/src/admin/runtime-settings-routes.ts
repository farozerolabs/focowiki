import { Hono, type MiddlewareHandler } from "hono";
import {
  RuntimeSettingsValidationError,
  serializePublicModel,
  type RuntimeGraphSettings,
  type RuntimeGeneratedSettings,
  type RuntimeMaintenanceSettings,
  type RuntimeModelConfigDraft,
  type RuntimeModelConfigUpdate,
  type RuntimeRateLimitSettings,
  type RuntimeSemanticSettings,
  type RuntimeSearchSettings,
  type RuntimeSettingsSnapshot,
  type RuntimeWorkerPublicSettings
} from "../runtime-settings/types.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";

export function registerAdminRuntimeSettingsRoutes(
  app: Hono,
  services: {
    runtimeSettings: RuntimeSettingsService | null;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  app.get("/admin/api/settings/runtime", middlewares.requireAuth, async (context) => {
    const service = requireRuntimeSettings(context, services.runtimeSettings);

    if (service instanceof Response) {
      return service;
    }

    const [snapshot, models] = await Promise.all([
      service.getPublicSnapshot(),
      service.listModels()
    ]);
    return context.json({
      settings: snapshot,
      models
    });
  });

  app.put(
    "/admin/api/settings/rate-limits",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) =>
        service.updateRateLimits({
          value: body as RuntimeRateLimitSettings,
          actor: "admin"
        })
      )
  );

  app.put(
    "/admin/api/settings/worker",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) => {
        assertExactFields(body, [
          "sourceFileConcurrency",
          "s3Concurrency",
          "jobMaxAttempts",
          "jobRetryDelayMs",
          "completedJobRetentionDays"
        ]);
        const snapshot = await service.getSnapshot();
        const publicWorker = body as RuntimeWorkerPublicSettings;
        return service.updateWorker({
          value: {
            ...snapshot.worker,
            sourceFileConcurrency: publicWorker.sourceFileConcurrency,
            sourceObjectReadConcurrency: publicWorker.s3Concurrency,
            jobMaxAttempts: publicWorker.jobMaxAttempts,
            jobRetryDelayMs: publicWorker.jobRetryDelayMs,
            completedJobRetentionDays: publicWorker.completedJobRetentionDays,
            claimBatchSize: Math.max(
              snapshot.worker.claimBatchSize,
              publicWorker.sourceFileConcurrency
            )
          },
          actor: "admin"
        });
      })
  );

  app.put(
    "/admin/api/settings/generated",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) => {
        assertExactFields(body, [
          "directoryIndexMaxEntries",
          "directoryIndexMaxBytes",
          "rootSummaryLimit",
          "okfLogMaxEntries",
          "okfLogMaxBytes"
        ]);
        return service.updateGenerated({
          value: body as RuntimeGeneratedSettings,
          actor: "admin"
        });
      })
  );

  app.put(
    "/admin/api/settings/graph",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) =>
        service.updateGraph({
          value: body as RuntimeGraphSettings,
          actor: "admin"
        })
      )
  );

  app.put(
    "/admin/api/settings/maintenance",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) => {
        assertExactFields(body, [
          "reconciliationEnabled",
          "scanBatchSize",
          "maxAttempts",
          "retryDelayMs",
          "hardDeleteConcurrency",
          "hardDeleteDatabaseBatchSize",
          "hardDeleteObjectBatchSize",
          "hardDeleteMaxAttempts",
          "hardDeleteRetryDelayMs",
          "hardDeleteFailedRetentionDays"
        ]);
        return service.updateMaintenance({
          value: body as RuntimeMaintenanceSettings,
          actor: "admin"
        });
      })
  );

  app.put(
    "/admin/api/settings/search",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) =>
        service.updateSearch({
          value: body as RuntimeSearchSettings,
          actor: "admin"
        })
      )
  );

  app.put(
    "/admin/api/settings/semantic",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) =>
        service.updateSemantic({
          value: body as RuntimeSemanticSettings,
          actor: "admin"
        })
      )
  );

  app.post(
    "/admin/api/settings/models",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      const service = requireRuntimeSettings(context, services.runtimeSettings);

      if (service instanceof Response) {
        return service;
      }

      try {
        const model = await service.createModel({
          ...((await readJsonBody(context.req.raw)) as RuntimeModelConfigDraft),
          actor: "admin"
        });
        return context.json({ model }, 201);
      } catch (error) {
        return writeSettingsError(context, error);
      }
    }
  );

  app.put(
    "/admin/api/settings/models/:modelId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      const service = requireRuntimeSettings(context, services.runtimeSettings);
      if (service instanceof Response) return service;
      try {
        const model = await service.updateModel({
          id: context.req.param("modelId"),
          value: (await readJsonBody(context.req.raw)) as RuntimeModelConfigUpdate,
          actor: "admin"
        });
        return model
          ? context.json({ model })
          : context.json({ error: { code: "NOT_FOUND" } }, 404);
      } catch (error) {
        return writeSettingsError(context, error);
      }
    }
  );

  app.post(
    "/admin/api/settings/models/:modelId/activate",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      const service = requireRuntimeSettings(context, services.runtimeSettings);

      if (service instanceof Response) {
        return service;
      }

      try {
        const model = await service.activateModel({
          id: context.req.param("modelId"),
          actor: "admin"
        });

        return model ? context.json({ model }) : context.json({ error: { code: "NOT_FOUND" } }, 404);
      } catch (error) {
        return writeSettingsError(context, error);
      }
    }
  );

  app.post(
    "/admin/api/settings/models/:modelId/pause",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => writeModelStatus(context, services.runtimeSettings, "pause")
  );

  app.post(
    "/admin/api/settings/models/:modelId/resume",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => writeModelStatus(context, services.runtimeSettings, "resume")
  );

  app.delete(
    "/admin/api/settings/models/:modelId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      const service = requireRuntimeSettings(context, services.runtimeSettings);

      if (service instanceof Response) {
        return service;
      }

      try {
        const model = await service.deleteModel({
          id: context.req.param("modelId"),
          actor: "admin"
        });

        return model
          ? context.json({ model: serializePublicModel(model) })
          : context.json({ error: { code: "NOT_FOUND" } }, 404);
      } catch (error) {
        return writeSettingsError(context, error);
      }
    }
  );

  async function writeSettingsResponse(
    context: Parameters<MiddlewareHandler>[0],
    apply: (
      service: RuntimeSettingsService,
      body: unknown
    ) => Promise<RuntimeSettingsSnapshot>
  ) {
    const service = requireRuntimeSettings(context, services.runtimeSettings);

    if (service instanceof Response) {
      return service;
    }

    try {
      await apply(service, await readJsonBody(context.req.raw));
      const publicSnapshot = await service.getPublicSnapshot();
      return context.json({ settings: publicSnapshot });
    } catch (error) {
      return writeSettingsError(context, error);
    }
  }
}

function assertExactFields(input: unknown, allowedFields: readonly string[]): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RuntimeSettingsValidationError([{
      field: "settings",
      message: "settings must be an object"
    }]);
  }
  const allowed = new Set(allowedFields);
  const removed = Object.keys(input).filter((field) => !allowed.has(field));
  if (removed.length > 0) {
    throw new RuntimeSettingsValidationError(removed.map((field) => ({
      field,
      message: `${field} is not a supported runtime setting`
    })));
  }
}

async function writeModelStatus(
  context: Parameters<MiddlewareHandler>[0],
  service: RuntimeSettingsService | null,
  action: "pause" | "resume"
) {
  const settings = requireRuntimeSettings(context, service);

  if (settings instanceof Response) {
    return settings;
  }

  const modelId = context.req.param("modelId");

  if (!modelId) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  try {
    const model =
      action === "pause"
        ? await settings.pauseModel({ id: modelId, actor: "admin" })
        : await settings.resumeModel({ id: modelId, actor: "admin" });

    return model ? context.json({ model }) : context.json({ error: { code: "NOT_FOUND" } }, 404);
  } catch (error) {
    return writeSettingsError(context, error);
  }
}

function requireRuntimeSettings(
  context: Parameters<MiddlewareHandler>[0],
  service: RuntimeSettingsService | null
): RuntimeSettingsService | Response {
  return (
    service ??
    context.json(
      {
        error: {
          code: "RUNTIME_SETTINGS_UNAVAILABLE",
          messageKey: "errors.runtimeSettingsUnavailable"
        }
      },
      503
    )
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function writeSettingsError(
  context: Parameters<MiddlewareHandler>[0],
  error: unknown
): Response {
  if (error instanceof RuntimeSettingsValidationError) {
    return context.json(
      {
        error: {
          code: error.code,
          messageKey: "errors.runtimeSettingsValidationFailed",
          issues: error.issues
        }
      },
      400
    );
  }

  throw error;
}
