export type StorageVnextProcessResourceKind =
  | "stream"
  | "request"
  | "timer"
  | "subprocess"
  | "database_connection"
  | "search_connection";

export type StorageVnextProcessResourceSnapshot = {
  total: number;
  byKind: Readonly<Record<StorageVnextProcessResourceKind, number>>;
};

export type StorageVnextProcessResourceScope = {
  trackClosable(input: {
    publicId: string;
    kind: "stream" | "database_connection" | "search_connection";
    close: () => void | Promise<void>;
  }): void;
  trackAbortController(publicId: string, controller: AbortController): void;
  trackTimer(publicId: string, timer: ReturnType<typeof setTimeout>): void;
  trackSubprocess(input: {
    publicId: string;
    hasExited: () => boolean;
    kill: () => void;
    exited: Promise<void>;
  }): void;
  closeAll(): Promise<void>;
  snapshot(): StorageVnextProcessResourceSnapshot;
  assertIdle(maximumOpenResources?: number): void;
};

export type StorageVnextProcessResourceScopeErrorCode =
  | "invalid_input"
  | "duplicate_resource"
  | "resource_limit_exceeded"
  | "scope_closed"
  | "resources_still_open";

export class StorageVnextProcessResourceScopeError extends Error {
  public constructor(public readonly code: StorageVnextProcessResourceScopeErrorCode) {
    super(`Storage vNext process resource scope error: ${code}`);
    this.name = "StorageVnextProcessResourceScopeError";
  }
}

type TrackedResource = {
  publicId: string;
  kind: StorageVnextProcessResourceKind;
  close: () => void | Promise<void>;
};

const RESOURCE_KINDS: readonly StorageVnextProcessResourceKind[] = [
  "stream",
  "request",
  "timer",
  "subprocess",
  "database_connection",
  "search_connection"
];

export function createStorageVnextProcessResourceScope(input: {
  maximumResources: number;
}): StorageVnextProcessResourceScope {
  if (
    !Number.isSafeInteger(input.maximumResources)
    || input.maximumResources < 1
    || input.maximumResources > 1_024
  ) {
    throw scopeError("invalid_input");
  }
  const resources = new Map<string, TrackedResource>();
  let accepting = true;
  let activeClose: Promise<void> | null = null;

  const scope: StorageVnextProcessResourceScope = {
    trackClosable(resource) {
      track(resource);
    },

    trackAbortController(publicId, controller) {
      if (!(controller instanceof AbortController)) throw scopeError("invalid_input");
      track({
        publicId,
        kind: "request",
        close() {
          controller.abort();
          if (!controller.signal.aborted) throw scopeError("resources_still_open");
        }
      });
    },

    trackTimer(publicId, timer) {
      if (timer === null || timer === undefined) throw scopeError("invalid_input");
      track({
        publicId,
        kind: "timer",
        close() {
          clearTimeout(timer);
        }
      });
    },

    trackSubprocess(resource) {
      if (
        typeof resource.hasExited !== "function"
        || typeof resource.kill !== "function"
        || !(resource.exited instanceof Promise)
      ) {
        throw scopeError("invalid_input");
      }
      track({
        publicId: resource.publicId,
        kind: "subprocess",
        async close() {
          if (!resource.hasExited()) {
            resource.kill();
            await resource.exited;
          }
          if (!resource.hasExited()) throw scopeError("resources_still_open");
        }
      });
    },

    async closeAll() {
      accepting = false;
      if (!activeClose) {
        activeClose = closeTrackedResources(resources).finally(() => {
          activeClose = null;
        });
      }
      return activeClose;
    },

    snapshot() {
      const byKind = Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, 0])) as
        Record<StorageVnextProcessResourceKind, number>;
      for (const resource of resources.values()) byKind[resource.kind] += 1;
      return { total: resources.size, byKind };
    },

    assertIdle(maximumOpenResources = 0) {
      if (
        !Number.isSafeInteger(maximumOpenResources)
        || maximumOpenResources < 0
        || maximumOpenResources > input.maximumResources
      ) {
        throw scopeError("invalid_input");
      }
      if (resources.size > maximumOpenResources) {
        throw scopeError("resources_still_open");
      }
    }
  };
  return scope;

  function track(resource: TrackedResource): void {
    assertResource(resource);
    if (!accepting) throw scopeError("scope_closed");
    if (resources.has(resource.publicId)) throw scopeError("duplicate_resource");
    if (resources.size >= input.maximumResources) {
      throw scopeError("resource_limit_exceeded");
    }
    resources.set(resource.publicId, resource);
  }
}

async function closeTrackedResources(
  resources: Map<string, TrackedResource>
): Promise<void> {
  const errors: unknown[] = [];
  const ordered = [...resources.values()].reverse();
  for (const resource of ordered) {
    try {
      await resource.close();
      resources.delete(resource.publicId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Storage vNext process resource cleanup failed");
  }
}

function assertResource(resource: TrackedResource): void {
  if (
    resource.publicId.length === 0
    || Buffer.byteLength(resource.publicId, "utf8") > 255
    || !RESOURCE_KINDS.includes(resource.kind)
    || typeof resource.close !== "function"
  ) {
    throw scopeError("invalid_input");
  }
}

function scopeError(
  code: StorageVnextProcessResourceScopeErrorCode
): StorageVnextProcessResourceScopeError {
  return new StorageVnextProcessResourceScopeError(code);
}
