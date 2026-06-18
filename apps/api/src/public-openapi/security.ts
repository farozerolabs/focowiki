import type { MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";

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
    "content-type": publicContentType(path)
  });
  const origin = context.req.header("origin");

  if (origin && config.corsOrigins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }

  return headers;
}

export function isAllowedPublicLogicalPath(path: string): boolean {
  if (
    path === "index.md" ||
    path === "log.md" ||
    path === "schema.md" ||
    path === "_index/manifest.json" ||
    path === "_index/search.json" ||
    path === "_index/links.json" ||
    path === "_graph/index.md" ||
    path === "_graph/manifest.json" ||
    path === "_graph/nodes.jsonl"
  ) {
    return true;
  }

  return (
    /^pages\/[^/\\\u0000-\u001f\u007f]+\.md$/u.test(path) ||
    /^_graph\/edges\/[0-9]{4}\.jsonl$/u.test(path) ||
    /^_graph\/by-file\/[^/\\\u0000-\u001f\u007f]+\.json$/u.test(path)
  );
}

function publicContentType(path: string): string {
  if (path.endsWith(".jsonl")) {
    return "application/x-ndjson; charset=utf-8";
  }

  return path.endsWith(".json")
    ? "application/json; charset=utf-8"
    : "text/markdown; charset=utf-8";
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
