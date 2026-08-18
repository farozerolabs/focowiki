export type WorkerWakeupKind =
  | "document"
  | "deletion"
  | "maintenance"
  | "cleanup";

type WakeupPublisher = {
  publish(channel: string, message: string): Promise<number>;
};

type WakeupSubscriber = {
  on?(event: "error", listener: (error: unknown) => void): unknown;
  off?(event: "error", listener: (error: unknown) => void): unknown;
  connect(): Promise<unknown>;
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void
  ): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  close(): Promise<unknown>;
};

export function createRedisWorkerWakeup(input: {
  publisher: WakeupPublisher;
  createSubscriber(): WakeupSubscriber;
  channel: string;
}) {
  if (!input.channel || Buffer.byteLength(input.channel, "utf8") > 512) {
    throw new Error("Worker wakeup channel is invalid");
  }
  const subscriber = input.createSubscriber();
  const waiters = new Set<() => void>();
  let started = false;
  let closed = false;
  let pending = false;
  const wakeAll = (): void => {
    pending = true;
    for (const wake of [...waiters]) wake();
  };

  return {
    async start(): Promise<void> {
      if (started || closed) return;
      subscriber.on?.("error", wakeAll);
      await subscriber.connect();
      await subscriber.subscribe(input.channel, wakeAll);
      started = true;
    },
    async notify(kind: WorkerWakeupKind): Promise<void> {
      if (closed) return;
      await input.publisher.publish(input.channel, kind);
    },
    async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
      if (closed || signal.aborted) return;
      if (!Number.isSafeInteger(milliseconds)
        || milliseconds < 1
        || milliseconds > 300_000) {
        throw new Error("Worker wakeup wait is invalid");
      }
      if (pending) {
        pending = false;
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, milliseconds);
        timer.unref?.();
        waiters.add(finish);
        signal.addEventListener("abort", finish, { once: true });
        function finish(): void {
          clearTimeout(timer);
          waiters.delete(finish);
          signal.removeEventListener("abort", finish);
          pending = false;
          resolve();
        }
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const wake of [...waiters]) wake();
      if (started) await subscriber.unsubscribe(input.channel);
      await subscriber.close();
      subscriber.off?.("error", wakeAll);
    }
  };
}
