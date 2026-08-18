import { describe, expect, it, vi } from "vitest";
import { createRedisWorkerWakeup } from
  "../src/document-indexing/infrastructure/redis-worker-wakeup.js";

describe("Redis unified-worker wakeup", () => {
  it("wakes polling immediately and coalesces pending notifications", async () => {
    let listener: (() => void) | null = null;
    const subscriber = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(async (_channel: string, next: () => void) => {
        listener = next;
      }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn()
    };
    const publisher = { publish: vi.fn().mockResolvedValue(1) };
    const wakeup = createRedisWorkerWakeup({
      publisher,
      createSubscriber: () => subscriber,
      channel: "focowiki:worker:wakeup"
    });

    await wakeup.start();
    const waiting = wakeup.wait(30_000, new AbortController().signal);
    listener!();
    await waiting;
    listener!();
    await wakeup.wait(30_000, new AbortController().signal);
    await wakeup.notify("document");
    await wakeup.close();

    expect(publisher.publish).toHaveBeenCalledWith(
      "focowiki:worker:wakeup", "document"
    );
    expect(subscriber.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriber.close).toHaveBeenCalledOnce();
  });

  it("falls back safely when the subscription emits an error", async () => {
    let errorListener: (() => void) | null = null;
    const wakeup = createRedisWorkerWakeup({
      publisher: { publish: vi.fn().mockResolvedValue(0) },
      createSubscriber: () => ({
        connect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((_event: "error", listener: () => void) => {
          errorListener = listener;
        }),
        off: vi.fn()
      }),
      channel: "focowiki:worker:wakeup"
    });
    await wakeup.start();
    const waiting = wakeup.wait(30_000, new AbortController().signal);
    errorListener!();
    await waiting;
    await wakeup.close();
    expect(errorListener).not.toBeNull();
  });
});
