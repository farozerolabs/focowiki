import type { MiddlewareHandler } from "hono";
import type { RateLimitConfig, RuntimeConfig } from "../config.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { getRateLimitClientKey } from "./request.js";

type RequestContext = Parameters<MiddlewareHandler>[0];

export async function requireRateLimit(input: {
  config: RuntimeConfig;
  redis: RedisCoordinator | null;
  context: RequestContext;
  scope: string;
  limit: RateLimitConfig;
  id?: string;
}): Promise<Response | null> {
  if (!input.redis) {
    return null;
  }

  const id = input.id ?? getRateLimitClientKey(input.config, input.context);
  const result = await input.redis.hitRateLimit(input.scope, id, input.limit);

  if (result.allowed) {
    return null;
  }

  input.context.header("retry-after", String(input.limit.windowSeconds));
  return input.context.json(
    {
      error: {
        code: "RATE_LIMITED",
        messageKey: "errors.rateLimited"
      }
    },
    429
  );
}
