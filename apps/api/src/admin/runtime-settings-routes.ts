import { Hono, type MiddlewareHandler } from "hono";
import {
  RuntimeSettingsValidationError,
  serializePublicModel,
  type RuntimeGraphSettings,
  type RuntimeMaintenanceSettings,
  type RuntimeModelConfigDraft,
  type RuntimePublicationSettings,
  type RuntimeRateLimitSettings,
  type RuntimeSettingsSnapshot
} from "../runtime-settings/types.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import type { StorageReconciliationRepository } from "../application/ports/storage-reconciliation-repository.js";

export function registerAdminRuntimeSettingsRoutes(
  app: Hono,
  services: {
    runtimeSettings: RuntimeSettingsService | null;
    storageReconciliation: StorageReconciliationRepository | null;
    storagePrefix: string;
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

    const [snapshot, models, maintenanceStatus] = await Promise.all([
      service.getPublicSnapshot(),
      service.listModels(),
      services.storageReconciliation?.getStatus(`${services.storagePrefix}/generated/`) ?? null
    ]);
    return context.json({
      settings: snapshot,
      models,
      maintenanceStatus
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
      writeSettingsResponse(context, async (service, body) =>
        service.updateWorker({
          value: body as RuntimeSettingsSnapshot["worker"],
          actor: "admin"
        })
      )
  );

  app.put(
    "/admin/api/settings/publication",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) =>
      writeSettingsResponse(context, async (service, body) =>
        service.updatePublication({
          value: body as RuntimePublicationSettings,
          actor: "admin"
        })
      )
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
      writeSettingsResponse(context, async (service, body) =>
        service.updateMaintenance({
          value: body as RuntimeMaintenanceSettings,
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
      const snapshot = await apply(service, await readJsonBody(context.req.raw));
      return context.json({
        settings: {
          rateLimits: snapshot.rateLimits,
          worker: snapshot.worker,
          publication: snapshot.publication,
          graph: snapshot.graph,
          maintenance: snapshot.maintenance,
          activeModel: snapshot.activeModel ? serializePublicModel(snapshot.activeModel) : null
        }
      });
    } catch (error) {
      return writeSettingsError(context, error);
    }
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
