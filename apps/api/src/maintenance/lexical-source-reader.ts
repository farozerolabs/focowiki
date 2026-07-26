import type { LexicalRebuildWorkSource } from "../application/ports/lexical-rebuild-work-repository.js";
import type { StorageAdapter } from "../storage/s3.js";

export type LexicalSourceRead = {
  source: LexicalRebuildWorkSource;
  body: string;
  bytes: number;
  latencyMs: number;
  retryCount: number;
  release: () => void;
};

export type LexicalSourceReadRetry = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: (() => number) | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
};

type NormalizedLexicalSourceReadRetry = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export type LexicalSourceReader = {
  updateLimits: (input: { concurrency: number; maxInFlightBytes: number }) => void;
  read: (source: LexicalRebuildWorkSource) => Promise<LexicalSourceRead>;
};

export function createLexicalSourceReader(input: {
  storage: Pick<StorageAdapter, "getObjectText">;
  concurrency: number;
  maxInFlightBytes: number;
  maxObjectBytes: number;
  requestTimeoutMs?: number | undefined;
  retry?: LexicalSourceReadRetry | undefined;
}): LexicalSourceReader {
  const requestGate = createConcurrencyGate(input.concurrency);
  const byteGate = createByteGate(input.maxInFlightBytes);

  return {
    updateLimits(limits) {
      requestGate.update(limits.concurrency);
      byteGate.update(limits.maxInFlightBytes);
    },
    async read(source) {
      const releaseBytes = await byteGate.acquire(Math.max(1, source.sizeBytes));
      const releaseRequest = await requestGate.acquire();
      const startedAt = performance.now();
      try {
        const retry = normalizeRetry(input.retry);
        let retryCount = 0;
        for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
          try {
            const body = await readSourceObject({
              storage: input.storage,
              objectKey: source.objectKey,
              maxObjectBytes: input.maxObjectBytes,
              timeoutMs: input.requestTimeoutMs ?? 30_000
            });
            if (body === null) {
              throw new LexicalSourceReadError(
                "LEXICAL_SOURCE_OBJECT_UNAVAILABLE",
                "The source object is unavailable"
              );
            }
            return {
              source,
              body,
              bytes: Buffer.byteLength(body, "utf8"),
              latencyMs: performance.now() - startedAt,
              retryCount,
              release: releaseBytes
            };
          } catch (error) {
            if (
              error instanceof LexicalSourceReadError
              || !isTransientSourceReadError(error)
              || attempt >= retry.maxAttempts
            ) {
              throw classifySourceReadError(error);
            }
            retryCount += 1;
            await retry.sleep(retryDelayMs(retry, attempt));
          }
        }
        throw new LexicalSourceReadError(
          "LEXICAL_SOURCE_READ_FAILED",
          "The source object could not be read"
        );
      } catch (error) {
        releaseBytes();
        if (error instanceof LexicalSourceReadError) throw error;
        throw classifySourceReadError(error);
      } finally {
        releaseRequest();
      }
    }
  };
}

async function readSourceObject(input: {
  storage: Pick<StorageAdapter, "getObjectText">;
  objectKey: string;
  maxObjectBytes: number;
  timeoutMs: number;
}): Promise<string | null> {
  const controller = new AbortController();
  const timeoutMs = positiveInteger(input.timeoutMs);
  let timeout: NodeJS.Timeout | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("Source object read timed out"), {
        name: "TimeoutError"
      }));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([
      input.storage.getObjectText(input.objectKey, {
        maxBytes: input.maxObjectBytes,
        signal: controller.signal
      }),
      deadline
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class LexicalSourceReadError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "LexicalSourceReadError";
    this.code = code;
  }
}

function createConcurrencyGate(initial: number): {
  acquire: () => Promise<() => void>;
  update: (concurrency: number) => void;
} {
  let concurrency = positiveInteger(initial);
  let active = 0;
  const queue: Array<(release: () => void) => void> = [];
  const drain = () => {
    while (active < concurrency && queue.length > 0) {
      const resolve = queue.shift()!;
      active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        drain();
      });
    }
  };
  return {
    acquire() {
      return new Promise((resolve) => {
        queue.push(resolve);
        drain();
      });
    },
    update(nextConcurrency) {
      concurrency = positiveInteger(nextConcurrency);
      drain();
    }
  };
}

function createByteGate(initialMaxWeight: number): {
  acquire: (weight: number) => Promise<() => void>;
  update: (maxWeight: number) => void;
} {
  let maxWeight = positiveInteger(initialMaxWeight);
  let activeWeight = 0;
  const queue: Array<{
    weight: number;
    resolve: (release: () => void) => void;
  }> = [];

  const drain = () => {
    while (queue.length > 0) {
      const next = queue[0]!;
      const boundedWeight = Math.min(next.weight, maxWeight);
      if (activeWeight > 0 && activeWeight + boundedWeight > maxWeight) return;
      queue.shift();
      activeWeight += boundedWeight;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        activeWeight -= boundedWeight;
        drain();
      });
    }
  };

  return {
    acquire(weight) {
      return new Promise((resolve) => {
        queue.push({ weight: positiveInteger(weight), resolve });
        drain();
      });
    },
    update(nextMaxWeight) {
      maxWeight = positiveInteger(nextMaxWeight);
      drain();
    }
  };
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Lexical rebuild limits must be positive integers");
  }
  return value;
}

function normalizeRetry(
  input: LexicalSourceReadRetry | undefined
): NormalizedLexicalSourceReadRetry {
  return {
    maxAttempts: positiveInteger(input?.maxAttempts ?? 3),
    baseDelayMs: positiveInteger(input?.baseDelayMs ?? 250),
    maxDelayMs: positiveInteger(input?.maxDelayMs ?? 2_000),
    random: input?.random ?? Math.random,
    sleep: input?.sleep ?? sleep
  };
}

function retryDelayMs(
  retry: NormalizedLexicalSourceReadRetry,
  attempt: number
): number {
  const exponential = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * (2 ** Math.max(0, attempt - 1))
  );
  const jitter = Math.max(0, Math.min(1, retry.random()));
  return Math.max(1, Math.round(exponential * (0.5 + jitter * 0.5)));
}

function isTransientSourceReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const statusCode = Number(
    candidate.$metadata?.httpStatusCode ?? candidate.statusCode ?? 0
  );
  return [
    "AbortError",
    "TimeoutError",
    "RequestTimeout",
    "SlowDown",
    "Throttling",
    "InternalError",
    "ServiceUnavailable"
  ].includes(name)
    || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)
    || statusCode === 429
    || statusCode >= 500;
}

function classifySourceReadError(error: unknown): LexicalSourceReadError {
  if (error instanceof LexicalSourceReadError) return error;
  if (error && typeof error === "object") {
    const candidate = error as {
      name?: unknown;
      code?: unknown;
      statusCode?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const statusCode = Number(
      candidate.$metadata?.httpStatusCode ?? candidate.statusCode ?? 0
    );
    if (
      name === "TimeoutError"
      || name === "RequestTimeout"
      || name === "AbortError"
      || code === "ETIMEDOUT"
    ) {
      return new LexicalSourceReadError(
        "LEXICAL_SOURCE_READ_TIMEOUT",
        "The source object read timed out"
      );
    }
    if (
      name === "SlowDown"
      || name === "Throttling"
      || statusCode === 429
    ) {
      return new LexicalSourceReadError(
        "LEXICAL_SOURCE_READ_THROTTLED",
        "The source object service is temporarily busy"
      );
    }
  }
  return new LexicalSourceReadError(
    "LEXICAL_SOURCE_READ_FAILED",
    "The source object could not be read"
  );
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
