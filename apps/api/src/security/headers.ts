import type { MiddlewareHandler } from "hono";
import { resolveSecurityConfig, type RuntimeConfig } from "../config.js";
import { isAllowedHost } from "./request.js";

export function applySecurityHeaders(config: RuntimeConfig): MiddlewareHandler {
  return async (context, next) => {
    const security = resolveSecurityConfig(config);

    if (!isAllowedHost(config, context)) {
      return context.json(
        {
          error: {
            code: "UNEXPECTED_HOST"
          }
        },
        400
      );
    }

    await next();

    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "no-referrer");
    context.header("x-frame-options", "DENY");

    if (security.environment === "production") {
      context.header("strict-transport-security", "max-age=15552000; includeSubDomains");
    }
  };
}

export function applyAdminCors(config: RuntimeConfig): MiddlewareHandler {
  return async (context, next) => {
    const security = resolveSecurityConfig(config);
    const origin = context.req.header("origin");

    if (origin && security.adminTrustedOrigins.includes(origin)) {
      context.header("access-control-allow-origin", origin);
      context.header("access-control-allow-credentials", "true");
      context.header("access-control-allow-headers", "content-type");
      context.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      context.header("vary", "Origin");
    }

    if (context.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: context.res.headers
      });
    }

    await next();
  };
}
