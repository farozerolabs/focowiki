import type { RuntimeLogger } from "../logger.js";

export type WorkerRedisEventClient = {
  on: {
    (event: "error", listener: (error: Error) => void): unknown;
    (event: "ready", listener: () => void): unknown;
  };
};

export function registerWorkerRedisRuntimeEvents(input: {
  client: WorkerRedisEventClient;
  logger: RuntimeLogger;
  role: "source" | "publication" | "projection_repair" | "lexical_rebuild" | "maintenance";
}): void {
  let interruptionReported = false;

  input.client.on("error", () => {
    if (interruptionReported) {
      return;
    }
    interruptionReported = true;
    input.logger.warn("redis.worker_connection_interrupted", {
      role: input.role
    });
  });
  input.client.on("ready", () => {
    if (interruptionReported) {
      input.logger.info("redis.worker_connection_restored", { role: input.role });
    }
    interruptionReported = false;
  });
}
