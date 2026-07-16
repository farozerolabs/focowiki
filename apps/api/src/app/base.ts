import { Hono } from "hono";
import type { RuntimeConfig } from "../config.js";
import { AppError } from "../errors.js";
import { createRuntimeLogger } from "../logger.js";
import { logReadLatency } from "../read-latency-logger.js";
import { applySecurityHeaders } from "../security/headers.js";

export function createBaseApp(
  config: RuntimeConfig,
  logger = createRuntimeLogger(config)
): Hono {
  const app = new Hono();

  app.onError((error, context) => {
    logger.error("Unhandled API error", error);

    if (error instanceof AppError && error.expose) {
      return context.json(
        {
          error: {
            code: error.code
          }
        },
        toSafeHttpStatus(error.status)
      );
    }

    return context.json(
      {
        error: {
          code: "INTERNAL_ERROR"
        }
      },
      500
    );
  });

  app.use("*", applySecurityHeaders(config));
  app.use("*", async (context, next) => {
    if (containsTraversal(context.req.raw.url)) {
      return context.json(
        {
          error: {
            code: "INVALID_PATH"
          }
        },
        400
      );
    }

    await next();
  });
  app.use("*", async (context, next) => {
    const startedAt = performance.now();
    await next();
    logReadLatency({
      logger,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: performance.now() - startedAt
    });
  });
  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.notFound((context) =>
    context.json(
      {
        error: {
          code: "NOT_FOUND"
        }
      },
      404
    )
  );

  return app;
}

function toSafeHttpStatus(status: number): 400 | 401 | 403 | 404 | 409 | 422 | 500 {
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 409 ||
    status === 422
  ) {
    return status;
  }

  return 500;
}

function containsTraversal(rawUrl: string): boolean {
  const path = rawUrl.replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0] ?? "";
  let decoded = path;

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);

      if (next === decoded) {
        break;
      }

      decoded = next;
    } catch {
      return true;
    }
  }

  return decoded
    .split("/")
    .some((segment) => segment === ".." || segment.includes("\\"));
}
