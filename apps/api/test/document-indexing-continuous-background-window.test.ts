import { describe, expect, it, vi } from "vitest";
import { createContinuousBackgroundWindow } from
  "../src/document-indexing/application/continuous-background-window.js";

describe("continuous background window", () => {
  it("refills one released slot before unrelated active documents complete", async () => {
    const abort = new AbortController();
    const a = deferred<void>();
    const b = deferred<void>();
    const c = deferred<void>();
    const started: string[] = [];
    const claim = vi.fn(async (limit: number) => {
      const remaining = ["a", "b", "c"].filter((id) => !started.includes(id));
      return remaining.slice(0, limit).map((publicId) => ({ publicId }));
    });
    const process = vi.fn(async (job: { publicId: string }) => {
      started.push(job.publicId);
      await ({ a, b, c }[job.publicId as "a" | "b" | "c"]).promise;
    });
    const window = createContinuousBackgroundWindow({
      capacity: 2,
      claim,
      process,
      waitForWork: (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      })
    });

    const running = window.run(abort.signal);
    await eventually(() => expect(started).toEqual(["a", "b"]));
    a.resolve();
    await eventually(() => expect(started).toEqual(["a", "b", "c"]));
    expect(b.settled).toBe(false);
    expect(claim.mock.calls.map(([limit]) => limit)).toEqual([2, 1]);

    b.resolve();
    c.resolve();
    abort.abort();
    await running;
  });

  it("contains one document failure and keeps refilling", async () => {
    const abort = new AbortController();
    const handled: string[] = [];
    let claimCount = 0;
    const onError = vi.fn();
    const window = createContinuousBackgroundWindow({
      capacity: 1,
      async claim() {
        claimCount += 1;
        return claimCount === 1 ? [{ publicId: "failed" }]
          : claimCount === 2 ? [{ publicId: "next" }] : [];
      },
      async process(job) {
        handled.push(job.publicId);
        if (job.publicId === "failed") throw new Error("document failed");
        abort.abort();
      },
      waitForWork: async () => undefined,
      onError
    });

    await window.run(abort.signal);

    expect(handled).toEqual(["failed", "next"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not attach wakeup races while every slot is occupied", async () => {
    const abort = new AbortController();
    const active = deferred<void>();
    const started = deferred<void>();
    const waitForWork = vi.fn((signal: AbortSignal) => {
      if (waitForWork.mock.calls.length === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    let claimed = false;
    const window = createContinuousBackgroundWindow({
      capacity: 1,
      async claim() {
        if (claimed) return [];
        claimed = true;
        return [{ publicId: "active" }];
      },
      async process() {
        started.resolve();
        await active.promise;
        abort.abort();
      },
      waitForWork
    });

    const running = window.run(abort.signal);
    await started.promise;
    await Promise.resolve();
    expect(waitForWork).toHaveBeenCalledTimes(0);
    active.resolve();
    await running;
  });

  it("stops an idle wait without polling the claim repository", async () => {
    const abort = new AbortController();
    const claim = vi.fn(async () => []);
    const waitForWork = vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const window = createContinuousBackgroundWindow({
      capacity: 2,
      claim,
      async process() { throw new Error("unexpected document"); },
      waitForWork
    });

    const running = window.run(abort.signal);
    await eventually(() => expect(waitForWork).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(claim).toHaveBeenCalledTimes(1);
    abort.abort();
    await running;
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("propagates shutdown to active work and does not claim replacements", async () => {
    const abort = new AbortController();
    const started = deferred<void>();
    const stopped = deferred<void>();
    const claim = vi.fn(async () => [{ publicId: "active" }]);
    const window = createContinuousBackgroundWindow({
      capacity: 1,
      claim,
      async process(_document, signal) {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stopped.resolve();
      },
      waitForWork: (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      })
    });

    const running = window.run(abort.signal);
    await started.promise;
    abort.abort();
    await running;

    expect(stopped.settled).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("lets multiple replicas share a queue without duplicate processing", async () => {
    const abort = new AbortController();
    const queued = ["a", "b", "c", "d"];
    const processed: string[] = [];
    const claim = async (limit: number) => queued.splice(0, limit)
      .map((publicId) => ({ publicId }));
    const process = async (document: { publicId: string }) => {
      processed.push(document.publicId);
      if (processed.length === 4) abort.abort();
    };
    const waitForWork = (signal: AbortSignal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const first = createContinuousBackgroundWindow({
      capacity: 2, claim, process, waitForWork
    });
    const second = createContinuousBackgroundWindow({
      capacity: 2, claim, process, waitForWork
    });

    await Promise.all([first.run(abort.signal), second.run(abort.signal)]);

    expect([...processed].sort()).toEqual(["a", "b", "c", "d"]);
    expect(new Set(processed).size).toBe(4);
  });

  it("lets a later file from the same upload use the latest active corpus", async () => {
    const abort = new AbortController();
    const blocked = deferred<void>();
    const queued = ["source-a", "source-b", "source-c"];
    const active = new Set<string>();
    const observations: Array<{ source: string; active: string[] }> = [];
    const refreshedPages = new Set<string>();
    const window = createContinuousBackgroundWindow({
      capacity: 2,
      async claim(limit) {
        return queued.splice(0, limit).map((publicId) => ({ publicId }));
      },
      async process(job) {
        observations.push({ source: job.publicId, active: [...active].sort() });
        if (job.publicId === "source-b") {
          await blocked.promise;
          active.add(job.publicId);
          if (active.size === 3) abort.abort();
          return;
        }
        active.add(job.publicId);
        if (job.publicId === "source-c" && active.has("source-a")) {
          refreshedPages.add("source-a");
          refreshedPages.add("source-c");
          blocked.resolve();
        }
        if (active.size === 3) abort.abort();
      },
      waitForWork: (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      })
    });

    await window.run(abort.signal);

    expect(observations.find((item) => item.source === "source-c")?.active)
      .toContain("source-a");
    expect(refreshedPages).toEqual(new Set(["source-a", "source-c"]));
    expect(active).toEqual(new Set(["source-a", "source-b", "source-c"]));
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const state = { settled: false };
  const promise = new Promise<T>((complete) => {
    resolve = (value) => {
      state.settled = true;
      complete(value);
    };
  });
  return {
    promise,
    resolve,
    get settled() { return state.settled; }
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}
