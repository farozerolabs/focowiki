import type { RuntimeConfig } from "../config.js";
import type { RuntimeLogger } from "../logger.js";
import {
  createRedisClient,
  createRedisCoordinator,
  type RedisCommandClient,
  type RedisCoordinator
} from "./coordination.js";

type ApiRedisClient = RedisCommandClient & {
  on: (event: "error", listener: (error: Error) => void) => unknown;
  connect: () => Promise<unknown>;
  destroy: () => void;
};

export async function connectApiRedis(input: {
  config: RuntimeConfig;
  logger: RuntimeLogger;
  createClient?: (config: RuntimeConfig) => ApiRedisClient;
}): Promise<RedisCoordinator | null> {
  const client = input.createClient?.(input.config) ?? createDefaultApiRedisClient(input.config);
  client.on("error", () => undefined);

  try {
    await client.connect();
    return createRedisCoordinator(client);
  } catch {
    try {
      client.destroy();
    } catch {
      // A failed initial connection can already leave the client closed.
    }
    input.logger.warn("API Redis unavailable; continuing with bounded database reads");
    return null;
  }
}

function createDefaultApiRedisClient(config: RuntimeConfig): ApiRedisClient {
  return createRedisClient(config, { disableReconnect: true }) as unknown as ApiRedisClient;
}
