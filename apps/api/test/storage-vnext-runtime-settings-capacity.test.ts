import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type CapacityValidator = (input: {
  snapshot: Record<string, unknown>;
  capacity: Record<string, number>;
}) => Array<{ field: string; message: string }>;

type CapacityFactory = (input: {
  config: Record<string, unknown>;
  defaults: Record<string, unknown>;
}) => Record<string, number>;

let validateCapacity: CapacityValidator | undefined;
let createCapacity: CapacityFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/runtime-settings/resource-capacity-validation.ts"
  );
  const loaded = await import(
    /* @vite-ignore */ pathToFileURL(modulePath).href
  ).catch(() => ({})) as Record<string, unknown>;
  validateCapacity = loaded.validateRuntimeSettingsResourceCapacity as
    CapacityValidator | undefined;
  createCapacity = loaded.createRuntimeSettingsResourceCapacity as
    CapacityFactory | undefined;
});

describe("storage vNext runtime settings aggregate capacity", () => {
  it("accepts a coherent snapshot exactly at every resource boundary", () => {
    expect(validateCapacity).toBeTypeOf("function");
    if (!validateCapacity) return;
    expect(validateCapacity({ snapshot: snapshot(), capacity: capacity() })).toEqual([]);
  });

  it.each([
    ["database", { maintenance: { hardDeleteConcurrency: 4 } }, "databaseCapacity"],
    ["search", { search: { maxInFlightTasks: 4 } }, "searchCapacity"],
    ["object-store", { maintenance: { hardDeleteConcurrency: 4 } }, "objectStoreCapacity"],
    ["memory", { search: { indexBatchCompressedBytes: 101 } }, "memoryCapacity"],
    ["CPU", { maintenance: { hardDeleteConcurrency: 5 } }, "cpuCapacity"]
  ] as const)("rejects aggregate %s pressure", (_plane, overrides, field) => {
    expect(validateCapacity).toBeTypeOf("function");
    if (!validateCapacity) return;
    const issues = validateCapacity({
      snapshot: merge(snapshot(), overrides),
      capacity: capacity()
    });
    expect(issues).toContainEqual(expect.objectContaining({ field }));
  });

  it("keeps the active document window independent from phase resource capacity", () => {
    expect(validateCapacity).toBeTypeOf("function");
    if (!validateCapacity) return;
    const changed = merge(snapshot(), {
      worker: {
        sourceFileConcurrency: 16,
        sourceObjectReadConcurrency: 16
      }
    });
    expect(validateCapacity({
      snapshot: changed,
      capacity: capacity()
    })).toEqual([]);
  });

  it("keeps external generation concurrency independent from worker CPU admission", () => {
    expect(createCapacity).toBeTypeOf("function");
    expect(validateCapacity).toBeTypeOf("function");
    if (!createCapacity || !validateCapacity) return;

    const defaults = snapshot();
    delete defaults.activeModel;
    const derived = createCapacity({
      config: {
        database: {
          workerPoolMax: 4
        }
      },
      defaults
    });

    expect(validateCapacity({
      snapshot: {
        ...defaults,
        activeModel: { suggestionConcurrency: 1 }
      },
      capacity: derived
    })).toEqual([]);
  });
});

function snapshot(): Record<string, unknown> {
  return {
    worker: {
      sourceFileConcurrency: 1,
      sourceObjectReadConcurrency: 1
    },
    maintenance: {
      hardDeleteConcurrency: 1
    },
    search: {
      maxInFlightTasks: 3,
      indexBatchCompressedBytes: 100
    },
    activeModel: { suggestionConcurrency: 1 }
  };
}

function capacity(): Record<string, number> {
  return {
    databaseConnections: 4,
    searchTasks: 3,
    objectStoreRequests: 4,
    memoryBytes: 300,
    cpuConcurrency: 5
  };
}

function merge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isRecord(result[key]) && isRecord(value)
      ? merge(result[key], value)
      : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
