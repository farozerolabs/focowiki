import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { RerankerConfigurationDraft } from
  "../semantic/reranker/configuration.js";
import {
  RerankerConfigurationServiceError,
  type RerankerConfigurationService
} from "../semantic/reranker/service.js";

export function registerAdminRerankerSettingsRoutes(
  app: Hono,
  services: {
    rerankerConfigurations: RerankerConfigurationService | null;
    actorPublicId: string;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  app.get(
    "/admin/api/settings/rerankers",
    middlewares.requireAuth,
    async (context) => {
      const service = requireService(context, services.rerankerConfigurations);
      if (service instanceof Response) return service;
      return context.json({ configurations: await service.list() });
    }
  );

  app.post(
    "/admin/api/settings/rerankers",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => writeConfiguration(context, async (service) =>
      service.create(
        await readJson<RerankerConfigurationDraft>(context),
        services.actorPublicId
      ), services.rerankerConfigurations, 201)
  );

  app.put(
    "/admin/api/settings/rerankers/:configurationId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => writeConfiguration(context, async (service) => {
      const body = await readJson<{
        expectedRevision?: unknown;
        configuration?: unknown;
      }>(context);
      return service.update(
        context.req.param("configurationId"),
        requireRevision(body.expectedRevision),
        body.configuration as RerankerConfigurationDraft,
        services.actorPublicId
      );
    }, services.rerankerConfigurations)
  );

  app.post(
    "/admin/api/settings/rerankers/:configurationId/test",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => writeConfiguration(context, (service) =>
      service.test(context.req.param("configurationId"), services.actorPublicId),
    services.rerankerConfigurations)
  );

  for (const action of ["activate", "pause", "resume"] as const) {
    app.post(
      `/admin/api/settings/rerankers/:configurationId/${action}`,
      middlewares.requireAuth,
      middlewares.requireWriteProtection,
      async (context) => writeConfiguration(context, async (service) => {
        const body = await readJson<{ expectedRevision?: unknown }>(context);
        return service[action](
          context.req.param("configurationId"),
          requireRevision(body.expectedRevision),
          services.actorPublicId
        );
      }, services.rerankerConfigurations)
    );
  }

  app.delete(
    "/admin/api/settings/rerankers/:configurationId",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => writeConfiguration(context, async (service) => {
      const body = await readJson<{ expectedRevision?: unknown }>(context);
      await service.delete(
        context.req.param("configurationId"),
        requireRevision(body.expectedRevision),
        services.actorPublicId
      );
      return { deleted: true as const };
    }, services.rerankerConfigurations)
  );
}

async function writeConfiguration(
  context: Context,
  apply: (service: RerankerConfigurationService) => Promise<unknown>,
  service: RerankerConfigurationService | null,
  successStatus: 200 | 201 = 200
): Promise<Response> {
  const available = requireService(context, service);
  if (available instanceof Response) return available;
  try {
    const value = await apply(available);
    return value && typeof value === "object" && "deleted" in value
      ? context.json(value as { deleted: true })
      : context.json({ configuration: value }, successStatus);
  } catch (error) {
    const code = error instanceof RerankerConfigurationServiceError
      ? error.code
      : readSafeCode(error);
    const suffix = code.split("_").map((part) =>
      `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("");
    return context.json({
      error: {
        code: `RERANKER_CONFIGURATION_${code.toUpperCase()}`,
        messageKey: `errors.rerankerConfiguration${suffix}`
      }
    }, code === "not_found" ? 404 : code === "revision_conflict" ? 409 : 400);
  }
}

function requireService(
  context: Context,
  service: RerankerConfigurationService | null
): RerankerConfigurationService | Response {
  return service ?? context.json({
    error: { code: "RERANKER_CONFIGURATION_UNAVAILABLE" }
  }, 503);
}

async function readJson<T>(context: Context): Promise<T> {
  try {
    return await context.req.json<T>();
  } catch {
    throw new RerankerConfigurationServiceError("validation_error");
  }
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RerankerConfigurationServiceError("validation_error");
  }
  return Number(value);
}

function readSafeCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
  ) return error.code;
  return "operation_failed";
}
