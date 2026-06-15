import { Hono, type MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminSessionManager } from "../auth/session.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { applyAdminCors } from "../security/headers.js";
import { recordSecurityAudit } from "../security/audit.js";
import { requireRateLimit } from "../security/rate-limit.js";
import { getRateLimitClientKey, isTrustedAdminOrigin } from "../security/request.js";

type RequestContext = Parameters<MiddlewareHandler>[0];

export type AdminSecurityServices = {
  config: RuntimeConfig;
  sessionManager: AdminSessionManager | null;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
};

export function registerAdminSecurityMiddlewares(
  app: Hono,
  services: Omit<AdminSecurityServices, "sessionManager">
): void {
  app.use("/admin/api/*", applyAdminCors(services.config));
  app.use("/admin/api/*", async (context, next) => {
    const limited = await requireRateLimit({
      config: services.config,
      redis: services.redis,
      context,
      scope: "admin-api",
      limit: services.config.security?.rateLimits.adminApi ?? {
        max: 600,
        windowSeconds: 60
      }
    });

    if (!limited) {
      await next();
      return;
    }

    await recordAdminAudit({
      ...services,
      context,
      eventType: "admin_api_rate_limited",
      result: "blocked",
      errorCode: "RATE_LIMITED"
    });
    return limited;
  });
}

export function createAdminAuthMiddleware(
  services: AdminSecurityServices
): MiddlewareHandler {
  return async (context, next) => {
    if (containsCredentialQuery(context.req.raw.url)) {
      await recordAdminAudit({
        ...services,
        context,
        eventType: "admin_session",
        result: "blocked",
        errorCode: "CREDENTIALS_IN_URL_NOT_ALLOWED"
      });
      return adminUnauthorized(context);
    }

    if (!services.sessionManager) {
      return missingSessionBackend(context);
    }

    if (!(await services.sessionManager.verifyCookieHeader(context.req.header("cookie")))) {
      await recordAdminAudit({
        ...services,
        context,
        eventType: "admin_session",
        result: "failure",
        errorCode: "UNAUTHORIZED"
      });
      return adminUnauthorized(context);
    }

    await next();
  };
}

export function createAdminWriteProtectionMiddleware(
  services: Pick<AdminSecurityServices, "config" | "repositories">
): MiddlewareHandler {
  return async (context, next) => {
    if (isTrustedAdminOrigin(services.config, context)) {
      await next();
      return;
    }

    await recordAdminAudit({
      ...services,
      context,
      eventType: "admin_origin",
      result: "blocked",
      errorCode: "INVALID_ORIGIN"
    });
    return context.json(
      {
        error: {
          code: "INVALID_ORIGIN",
          messageKey: "errors.securityRequestRejected"
        }
      },
      403
    );
  };
}

export async function limitAdminLoginRequest(input: {
  config: RuntimeConfig;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
  context: RequestContext;
  username: string;
}): Promise<Response | null> {
  const limit = input.config.security?.rateLimits.adminLogin ?? {
    max: 8,
    windowSeconds: 900
  };
  const clientLimited = await requireRateLimit({
    ...input,
    scope: "admin-login-client",
    limit
  });
  const usernameLimited = input.username
    ? await requireRateLimit({
        ...input,
        scope: "admin-login-user",
        id: input.username.toLowerCase(),
        limit
      })
    : null;

  if (!clientLimited && !usernameLimited) {
    return null;
  }

  await recordAdminAudit({
    ...input,
    eventType: "admin_login_rate_limited",
    result: "blocked",
    errorCode: "RATE_LIMITED",
    username: input.username || null
  });
  return clientLimited ?? usernameLimited;
}

export async function limitAdminUploadRequest(input: {
  config: RuntimeConfig;
  redis: RedisCoordinator | null;
  repositories: AdminRepositories | null;
  context: RequestContext;
}): Promise<Response | null> {
  const limited = await requireRateLimit({
    config: input.config,
    redis: input.redis,
    context: input.context,
    scope: "upload",
    id: getRateLimitClientKey(input.config, input.context),
    limit: input.config.security?.rateLimits.upload ?? {
      max: 20,
      windowSeconds: 3_600
    }
  });

  if (!limited) {
    return null;
  }

  await recordAdminAudit({
    ...input,
    eventType: "upload_rate_limited",
    result: "blocked",
    errorCode: "RATE_LIMITED"
  });
  return limited;
}

export async function recordAdminAudit(input: {
  repositories: AdminRepositories | null;
  config: RuntimeConfig;
  context: RequestContext;
  eventType: string;
  result: "success" | "failure" | "blocked";
  errorCode?: string | null;
  username?: string | null;
}): Promise<void> {
  await recordSecurityAudit(input);
}

export function adminUnauthorized(context: RequestContext, messageKey?: string): Response {
  return context.json(
    {
      error: {
        code: "UNAUTHORIZED",
        ...(messageKey ? { messageKey } : {})
      }
    },
    401
  );
}

export function missingSessionBackend(context: RequestContext): Response {
  return context.json(
    {
      error: {
        code: "SESSION_BACKEND_UNAVAILABLE"
      }
    },
    503
  );
}

function containsCredentialQuery(rawUrl: string): boolean {
  const searchParams = new URL(rawUrl).searchParams;
  return (
    searchParams.has("token") ||
    searchParams.has("username") ||
    searchParams.has("password")
  );
}
