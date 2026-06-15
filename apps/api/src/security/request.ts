import type { MiddlewareHandler } from "hono";
import { resolveSecurityConfig, type RuntimeConfig } from "../config.js";

type RequestContext = Parameters<MiddlewareHandler>[0];

export function getClientIp(config: RuntimeConfig, context: RequestContext): string {
  const security = resolveSecurityConfig(config);

  if (security.trustedProxy) {
    const forwardedFor = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();

    if (forwardedFor) {
      return forwardedFor;
    }
  }

  return context.req.header("x-real-ip")?.trim() || "local";
}

export function getRateLimitClientKey(config: RuntimeConfig, context: RequestContext): string {
  return getClientIp(config, context).replace(/[^a-zA-Z0-9:._-]/g, "_");
}

export function getRequestOrigin(context: RequestContext): string | null {
  const origin = context.req.header("origin");

  if (origin) {
    return normalizeOrigin(origin);
  }

  const referer = context.req.header("referer");
  return referer ? normalizeOrigin(referer) : null;
}

export function isTrustedAdminOrigin(config: RuntimeConfig, context: RequestContext): boolean {
  const origin = getRequestOrigin(context);
  return Boolean(origin && resolveSecurityConfig(config).adminTrustedOrigins.includes(origin));
}

export function getRequestHost(config: RuntimeConfig, context: RequestContext): string | null {
  const security = resolveSecurityConfig(config);
  const rawHost =
    security.trustedProxy && context.req.header("x-forwarded-host")
      ? context.req.header("x-forwarded-host")
      : context.req.header("host");
  const host = rawHost?.split(",")[0]?.trim().toLowerCase();

  if (!host) {
    return null;
  }

  return host.replace(/:\d+$/, "");
}

export function isAllowedHost(config: RuntimeConfig, context: RequestContext): boolean {
  const security = resolveSecurityConfig(config);

  if (security.environment !== "production" || security.allowedHosts.length === 0) {
    return true;
  }

  const host = getRequestHost(config, context);
  return Boolean(host && security.allowedHosts.includes(host));
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
