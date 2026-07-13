import type { MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import { recordSecurityAudit } from "../security/audit.js";
import { getRateLimitClientKey } from "../security/request.js";
import {
  createPublicOpenApiKeyService,
  type PublicOpenApiKeyService
} from "../public-openapi/keys.js";
import { rateLimited, repositoryUnavailable, unauthorized, writeDeveloperOpenApiError } from "./errors.js";

export type DeveloperOpenApiSecurityServices = {
  config: RuntimeConfig;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  runtimeSettings?: RuntimeSettingsService | null;
};

export function createDeveloperOpenApiKeyService(
  services: DeveloperOpenApiSecurityServices
): PublicOpenApiKeyService | null {
  return services.repositories?.publicApiKeys
    ? createPublicOpenApiKeyService({
        repository: services.repositories.publicApiKeys,
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
      await recordSecurityAudit({
        repositories: services.repositories,
        config: services.config,
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
  await recordSecurityAudit({
    repositories: services.repositories,
    config: services.config,
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
