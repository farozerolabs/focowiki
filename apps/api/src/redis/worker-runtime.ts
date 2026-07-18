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
  role: "source" | "publication" | "maintenance";
}): void {
  let interruptionReported = false;

  input.client.on("error", () => {
    if (interruptionReported) {
      return;
    }
    interruptionReported = true;
    input.logger.warn("Worker Redis connection interrupted; processing will resume after recovery", {
      role: input.role
    });
  });
  input.client.on("ready", () => {
    if (interruptionReported) {
      input.logger.info("Worker Redis connection restored", { role: input.role });
    }
    interruptionReported = false;
  });
}
