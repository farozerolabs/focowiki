import type { createStorageVnextWebhookWorker } from "./worker.js";

type WebhookWorker = ReturnType<typeof createStorageVnextWebhookWorker>;

export async function runWebhookDeliveryLoop(input: {
  worker: WebhookWorker;
  pollIntervalMilliseconds: number;
  leaseDurationMilliseconds: number;
  signal: AbortSignal;
  onCycle(outcome: Awaited<ReturnType<WebhookWorker["runBatch"]>>): void;
  onError(error: unknown): void;
}): Promise<void> {
  assertPositiveInteger(input.pollIntervalMilliseconds, "poll interval");
  assertPositiveInteger(input.leaseDurationMilliseconds, "lease duration");
  while (!input.signal.aborted) {
    try {
      const outcome = await input.worker.runBatch({
        leaseExpiresAt: new Date(
          Date.now() + input.leaseDurationMilliseconds
        ).toISOString(),
        signal: input.signal
      });
      input.onCycle(outcome);
    } catch (error) {
      if (!input.signal.aborted) input.onError(error);
    }
    await wait(input.pollIntervalMilliseconds, input.signal);
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Webhook ${name} must be a positive integer`);
  }
}
