import { createHash } from "node:crypto";

export function createDeterministicEmbedding(input, dimension = 8) {
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 4_096) {
    throw new Error("Embedding dimension must be between 1 and 4096");
  }
  const bytes = createHash("sha512").update(String(input)).digest();
  const values = Array.from({ length: dimension }, (_, index) =>
    (bytes[index % bytes.length] - 127.5) / 127.5
  );
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / magnitude);
}

export function createNormalizedGraphRagOutput(overrides = {}) {
  return {
    schemaVersion: "focowiki-graphrag-output-v1",
    sourceRevisionPublicId: "revision-source-1",
    entities: [],
    mentions: [],
    relationships: [],
    communities: [],
    diagnostics: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...structuredClone(overrides)
  };
}

export function createProviderVectorExpectation(overrides = {}) {
  return {
    family: "content",
    ownerPublicId: "file-source-1",
    sourceFilePublicId: "file-source-1",
    activeGenerationPublicId: "generation-1",
    embeddingRevisionPublicId: "embedding-revision-1",
    dimension: 8,
    vector: createDeterministicEmbedding("file-source-1", 8),
    ...structuredClone(overrides)
  };
}

export function createOperationBarrier(requiredArrivals = 1) {
  if (!Number.isSafeInteger(requiredArrivals) || requiredArrivals < 1) {
    throw new Error("Operation barrier requires at least one arrival");
  }
  let arrivals = 0;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  return {
    ready,
    arrive: async () => {
      arrivals += 1;
      if (arrivals === requiredArrivals) readyResolve();
      await released;
    },
    release: () => release(),
    get arrivals() {
      return arrivals;
    }
  };
}

export function createChangedObjectCounter() {
  const counts = new Map();
  const owners = new Map();
  return {
    record(kind, ownerPublicId) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (!owners.has(kind)) owners.set(kind, new Set());
      owners.get(kind).add(ownerPublicId);
    },
    count(kind) {
      return counts.get(kind) ?? 0;
    },
    ownerPublicIds(kind) {
      return [...(owners.get(kind) ?? [])].sort();
    },
    snapshot() {
      return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
    }
  };
}

export function sampleProcessResources() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    capturedAtEpochMs: Date.now(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    userCpuMicros: cpu.user,
    systemCpuMicros: cpu.system
  };
}

export async function runBoundedConcurrent(items, concurrency, worker) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run()
  ));
  return results;
}
