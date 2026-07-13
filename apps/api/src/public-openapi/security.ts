import type { MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import {
  isAllowedPublicBundleFilePath,
  publicBundleContentType
} from "../public-bundle-path.js";

type RequestContext = Parameters<MiddlewareHandler>[0];

export function applyPublicCors(config: RuntimeConfig): MiddlewareHandler {
  return async (context, next) => {
    const origin = context.req.header("origin");

    if (origin && config.corsOrigins.includes(origin)) {
      context.header("access-control-allow-origin", origin);
      context.header("access-control-allow-methods", "GET,HEAD,OPTIONS");
      context.header("access-control-allow-headers", "authorization,content-type");
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

export function publicResponseHeaders(
  path: string,
  context: RequestContext,
  config: RuntimeConfig
): Headers {
  const headers = new Headers({
    "content-type": publicBundleContentType(path)
  });
  const origin = context.req.header("origin");

  if (origin && config.corsOrigins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }

  return headers;
}

export function isAllowedPublicLogicalPath(path: string): boolean {
  return isAllowedPublicBundleFilePath(path);
}

export function invalidPath(context: RequestContext): Response {
  return context.json(
    {
      error: {
        code: "INVALID_PATH"
      }
    },
    400
  );
}

export function unsupportedPublicMethod(context: RequestContext): Response {
  return context.json(
    {
      error: {
        code: "METHOD_NOT_ALLOWED"
      }
    },
    405
  );
}
