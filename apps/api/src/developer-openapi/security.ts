import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RuntimeConfig } from "../config.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import { getRateLimitClientKey } from "../security/request.js";
import {
  createPublicOpenApiKeyService,
  type PublicOpenApiKeyRepository,
  type PublicOpenApiKeyService
} from "../public-openapi/keys.js";
import type { StorageVnextOpenApiAuditApplication } from "../storage-vnext/api/openapi-audit-application.js";
import {
  payloadTooLarge,
  rateLimited,
  repositoryUnavailable,
  unauthorized,
  writeDeveloperOpenApiError
} from "./errors.js";

export type DeveloperOpenApiSecurityServices = {
  config: RuntimeConfig;
  apiKeys: PublicOpenApiKeyRepository | null;
  redis: RedisCoordinator | null;
  runtimeSettings?: RuntimeSettingsService | null;
  auditApplication: StorageVnextOpenApiAuditApplication;
};

export function createDeveloperOpenApiKeyService(
  services: DeveloperOpenApiSecurityServices
): PublicOpenApiKeyService | null {
  return services.apiKeys
    ? createPublicOpenApiKeyService({
        repository: services.apiKeys,
        redis: services.redis
      })
    : null;
}

export function requireDeveloperOpenApiAuth(
  services: DeveloperOpenApiSecurityServices,
  keyService: PublicOpenApiKeyService | null
): MiddlewareHandler {
  return async (context, next) => {
    const limited = await checkDeveloperOpenApiRateLimit(services, context);

    if (limited) {
      return limited;
    }

    if (!keyService) {
      return writeDeveloperOpenApiError(context, repositoryUnavailable());
    }

    const token = readBearerToken(context.req.header("authorization"));

    if (!token || !(await keyService.authorize(token)).authorized) {
      await services.auditApplication.record({
        context,
        eventType: "developer_openapi_auth",
        result: "failure",
        errorCode: "UNAUTHORIZED"
      });
      return writeDeveloperOpenApiError(context, unauthorized());
    }

    await next();
  };
}

export function createDeveloperOpenApiBodyLimit(
  config: {
    pagination: Pick<RuntimeConfig["pagination"], "generatedContentMaxBytes">;
  }
): MiddlewareHandler {
  return bodyLimit({
    maxSize: config.pagination.generatedContentMaxBytes,
    onError: (context) => writeDeveloperOpenApiError(context, payloadTooLarge())
  });
}

async function checkDeveloperOpenApiRateLimit(
  services: DeveloperOpenApiSecurityServices,
  context: Parameters<MiddlewareHandler>[0]
): Promise<Response | null> {
  if (!services.redis) {
    return null;
  }

  const limit =
    (await services.runtimeSettings?.getSnapshot())?.rateLimits.publicOpenApi ??
    services.config.security?.rateLimits.publicOpenApi ?? {
      max: 1_200,
      windowSeconds: 60
    };
  const result = await services.redis.hitRateLimit(
    developerOpenApiRateLimitScope(context),
    getRateLimitClientKey(services.config, context),
    limit
  );

  if (result.allowed) {
    return null;
  }

  const retryAfterSeconds = coarseRetryAfterSeconds(result.resetAt);
  context.header("retry-after", String(retryAfterSeconds));
  await services.auditApplication.record({
    context,
    eventType: "developer_openapi_rate_limited",
    result: "blocked",
    errorCode: "RATE_LIMITED"
  });
  return writeDeveloperOpenApiError(context, rateLimited({ retryAfterSeconds }));
}

function developerOpenApiRateLimitScope(
  context: Parameters<MiddlewareHandler>[0]
): string {
  const method = context.req.method.toUpperCase();
  const path = context.req.path;

  if (method !== "GET" && path.includes("/upload-sessions")) {
    return "developer-openapi-upload-session";
  }
  if (method === "DELETE" && path.includes("/source-directories/")) {
    return "developer-openapi-directory-delete";
  }
  return "developer-openapi-read";
}

function readBearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function coarseRetryAfterSeconds(resetAt: string): number {
  const remainingSeconds = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1_000));
  const buckets = [15, 30, 60, 120, 300];

  return buckets.find((bucket) => remainingSeconds <= bucket) ?? 300;
}
