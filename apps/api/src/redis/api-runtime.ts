import type { RuntimeConfig } from "../config.js";
import type { RuntimeLogger } from "../logger.js";
import {
  createRedisClient,
  createRedisCoordinator,
  type RedisCommandClient,
  type RedisCoordinator
} from "./coordination.js";
import { createResilientRedisCoordinator } from "./resilient-coordinator.js";

type ApiRedisClient = RedisCommandClient & {
  isReady: boolean;
  on: {
    (event: "error", listener: (error: Error) => void): unknown;
    (event: "ready", listener: () => void): unknown;
  };
  connect: () => Promise<unknown>;
  destroy: () => void;
};

export async function connectApiRedis(input: {
  config: RuntimeConfig;
  logger: RuntimeLogger;
  createClient?: (config: RuntimeConfig) => ApiRedisClient;
}): Promise<RedisCoordinator | null> {
  const client = input.createClient?.(input.config) ?? createDefaultApiRedisClient(input.config);
  let interruptionReported = false;
  client.on("error", () => {
    if (interruptionReported) {
      return;
    }
    interruptionReported = true;
    input.logger.warn("API Redis connection interrupted; continuing with bounded database reads");
  });
  client.on("ready", () => {
    if (interruptionReported) {
      input.logger.info("API Redis connection restored");
    }
    interruptionReported = false;
  });

  try {
    await client.connect();
    return createResilientRedisCoordinator({
      client,
      coordinator: createRedisCoordinator(client),
      sessionWrites: "required"
    });
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
  return createRedisClient(config) as unknown as ApiRedisClient;
}
