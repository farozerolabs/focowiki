import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextProcessResourceScope,
  StorageVnextProcessResourceScopeError
} from "../src/storage-vnext/cleanup/process-resource-scope.js";
import { createStorageVnextPublicationCleanupAdapter } from
  "../src/storage-vnext/cleanup/adapters/publication.js";
import { createStorageVnextTerminalConvergence } from
  "../src/storage-vnext/cleanup/terminal-convergence.js";

describe("storage vNext process resource scope", () => {
  it("closes streams exactly once and rejects duplicate resource identities", async () => {
    const scope = createStorageVnextProcessResourceScope({ maximumResources: 8 });
    const close = vi.fn(async () => undefined);
    scope.trackClosable({ publicId: "stream-one", kind: "stream", close });
    expect(() => scope.trackClosable({
      publicId: "stream-one",
      kind: "stream",
      close
    })).toThrowError(expect.objectContaining({ code: "duplicate_resource" }));
    await Promise.all([scope.closeAll(), scope.closeAll()]);
    await scope.closeAll();
    expect(close).toHaveBeenCalledOnce();
    expect(scope.snapshot().total).toBe(0);
  });

  it("aborts requests and clears timers", async () => {
    const scope = createStorageVnextProcessResourceScope({ maximumResources: 8 });
    const controller = new AbortController();
    const timeoutCountBefore = timeoutResourceCount();
    const timer = setTimeout(() => undefined, 60_000);
    scope.trackAbortController("request-one", controller);
    scope.trackTimer("timer-one", timer);
    expect(timeoutResourceCount()).toBeGreaterThanOrEqual(timeoutCountBefore + 1);

    await scope.closeAll();

    expect(controller.signal.aborted).toBe(true);
    expect(timeoutResourceCount()).toBeLessThanOrEqual(timeoutCountBefore);
    expect(scope.snapshot().byKind.request).toBe(0);
    expect(scope.snapshot().byKind.timer).toBe(0);
  });

  it("terminates and reaps subprocesses before reporting idle", async () => {
    const scope = createStorageVnextProcessResourceScope({ maximumResources: 8 });
    let exited = false;
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const kill = vi.fn(() => {
      exited = true;
      resolveExit();
    });
    scope.trackSubprocess({
      publicId: "subprocess-one",
      hasExited: () => exited,
      kill,
      exited: exit
    });

    await scope.closeAll();

    expect(kill).toHaveBeenCalledOnce();
    expect(exited).toBe(true);
    expect(() => scope.assertIdle()).not.toThrow();
  });

  it("returns database and search connections in reverse registration order", async () => {
    const scope = createStorageVnextProcessResourceScope({ maximumResources: 8 });
    const events: string[] = [];
    scope.trackClosable({
      publicId: "database-one",
      kind: "database_connection",
      close: async () => { events.push("database"); }
    });
    scope.trackClosable({
      publicId: "search-one",
      kind: "search_connection",
      close: async () => { events.push("search"); }
    });

    await scope.closeAll();

    expect(events).toEqual(["search", "database"]);
    expect(scope.snapshot().byKind.database_connection).toBe(0);
    expect(scope.snapshot().byKind.search_connection).toBe(0);
  });

  it("attempts every close and permits retry of only the resource that failed", async () => {
    const scope = createStorageVnextProcessResourceScope({ maximumResources: 8 });
    let attempts = 0;
    const closeRetry = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient close failure");
    });
    const closeOther = vi.fn(async () => undefined);
    scope.trackClosable({ publicId: "stream-retry", kind: "stream", close: closeRetry });
    scope.trackClosable({ publicId: "stream-other", kind: "stream", close: closeOther });

    await expect(scope.closeAll()).rejects.toBeInstanceOf(AggregateError);
    expect(closeOther).toHaveBeenCalledOnce();
    expect(() => scope.assertIdle()).toThrowError(
      expect.objectContaining({ code: "resources_still_open" })
    );
    await scope.closeAll();
    expect(closeRetry).toHaveBeenCalledTimes(2);
    expect(closeOther).toHaveBeenCalledOnce();
    expect(() => scope.assertIdle()).not.toThrow();
  });

  it("bounds tracked idle handles and seals the scope during cleanup", async () => {
    const scope = createStorageVnextProcessResourceScope({ maximumResources: 1 });
    scope.trackClosable({
      publicId: "stream-limit",
      kind: "stream",
      close: async () => undefined
    });
    expect(() => scope.trackClosable({
      publicId: "stream-over-limit",
      kind: "stream",
      close: async () => undefined
    })).toThrowError(expect.objectContaining({ code: "resource_limit_exceeded" }));
    const closing = scope.closeAll();
    expect(() => scope.trackClosable({
      publicId: "stream-too-late",
      kind: "stream",
      close: async () => undefined
    })).toThrowError(expect.objectContaining({ code: "scope_closed" }));
    await closing;
    expect(() => scope.assertIdle(0)).not.toThrow();
    expect(() => scope.assertIdle(-1)).toThrow(StorageVnextProcessResourceScopeError);
  });

  it("closes process resources before terminal convergence touches shared stores", async () => {
    const scope = createStorageVnextProcessResourceScope({ maximumResources: 4 });
    scope.trackClosable({
      publicId: "stream-terminal",
      kind: "stream",
      close: async () => undefined
    });
    const calls: string[] = [];
    const convergence = createStorageVnextTerminalConvergence({
      maximumTargets: 16,
      adapters: [createStorageVnextPublicationCleanupAdapter({
        async clean({ target }) {
          if (target.resourceKind === "process_resource") {
            await scope.closeAll();
            scope.assertIdle();
          } else {
            expect(scope.snapshot().total).toBe(0);
          }
          calls.push(target.resourceKind);
          return { status: "completed", reasonCode: null, checkpoint: {} };
        }
      })]
    });

    await expect(convergence.converge({
      workPublicId: "operation-process-resource",
      knowledgeBaseId: "knowledge-base-process-resource",
      operationRevision: 1,
      outcome: "completed",
      resultCode: "PUBLICATION_COMPLETED",
      safeMessage: null,
      checkpoint: {},
      completedAt: "2026-08-01T00:00:00.000Z"
    })).resolves.toMatchObject({ status: "completed" });
    expect(calls[0]).toBe("process_resource");
  });
});

function timeoutResourceCount(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}
