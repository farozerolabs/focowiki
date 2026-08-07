import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

const API_KEY_FILE = "meilisearch-api-key";
const METRICS_KEY_FILE = "meilisearch-metrics-key";
const KEY_CONTRACT_VERSION = "v1";
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_SECRET_LENGTH = 4_096;

const RUNTIME_ACTIONS = [
  "search",
  "documents.*",
  "indexes.*",
  "indexes.swap",
  "stats.get",
  "tasks.get",
  "settings.*"
] as const;
const METRICS_ACTIONS = [
  "metrics.get",
  "stats.get",
  "tasks.delete",
  "tasks.get",
  "version"
] as const;

type KeyRole = "runtime" | "metrics";

type ApiKeyRecord = {
  uid: string;
  key: string;
  actions: string[];
  indexes: string[];
  expiresAt: string | null;
};

type KeyDefinition = {
  uid: string;
  name: string;
  description: string;
  actions: readonly string[];
  indexes: readonly string[];
  expiresAt: null;
  fileName: string;
};

class MeilisearchBootstrapRequestError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

export async function bootstrapMeilisearchKeys(input: {
  endpoint: string;
  masterKey: string;
  indexPrefix: string;
  secretDirectory: string;
  providedApiKey?: string | undefined;
  providedMetricsApiKey?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  maxAttempts?: number | undefined;
  retryDelayMs?: number | undefined;
}): Promise<{ source: "provided" | "managed" }> {
  const endpoint = normalizeEndpoint(input.endpoint);
  const indexPrefix = validateIndexPrefix(input.indexPrefix);
  const providedApiKey = normalizeProvidedSecret(input.providedApiKey);
  const providedMetricsApiKey = normalizeProvidedSecret(
    input.providedMetricsApiKey
  );

  mkdirSync(input.secretDirectory, { recursive: true, mode: 0o700 });
  chmodSync(input.secretDirectory, 0o700);

  if (providedApiKey || providedMetricsApiKey) {
    if (!providedApiKey || !providedMetricsApiKey) {
      throw new Error(
        "Both Meilisearch runtime and metrics keys are required for an external service"
      );
    }
    await verifyProvidedKey({
      endpoint,
      key: providedApiKey,
      role: "runtime",
      paths: ["/indexes?limit=1"],
      fetch: input.fetch ?? globalThis.fetch,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      retryDelayMs: input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    });
    await verifyProvidedKey({
      endpoint,
      key: providedMetricsApiKey,
      role: "metrics",
      paths: ["/version", "/metrics"],
      fetch: input.fetch ?? globalThis.fetch,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      retryDelayMs: input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    });
    persistSecret(input.secretDirectory, API_KEY_FILE, providedApiKey);
    persistSecret(input.secretDirectory, METRICS_KEY_FILE, providedMetricsApiKey);
    return { source: "provided" };
  }

  const masterKey = input.masterKey.trim();
  if (masterKey.length < 16 || masterKey.length > MAX_SECRET_LENGTH) {
    throw new Error("MEILI_MASTER_KEY must contain between 16 and 4096 characters");
  }

  const request = createRequestClient({
    endpoint,
    masterKey,
    fetch: input.fetch ?? globalThis.fetch,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retryDelayMs: input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  });

  for (const definition of createKeyDefinitions(indexPrefix)) {
    const record = await ensureKey(request, definition);
    persistSecret(input.secretDirectory, definition.fileName, record.key);
  }

  return { source: "managed" };
}

async function verifyProvidedKey(input: {
  endpoint: string;
  key: string;
  role: KeyRole;
  paths: readonly string[];
  fetch: typeof globalThis.fetch;
  maxAttempts: number;
  retryDelayMs: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("Meilisearch bootstrap max attempts must be a positive integer");
  }
  if (!Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0) {
    throw new Error("Meilisearch bootstrap retry delay must be a non-negative integer");
  }

  for (const path of input.paths) {
    let verified = false;
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      try {
        const response = await input.fetch(new URL(path, `${input.endpoint}/`), {
          method: "GET",
          headers: {
            authorization: `Bearer ${input.key}`
          },
          signal: AbortSignal.timeout(5_000)
        });
        if (response.ok) {
          verified = true;
          break;
        }
        lastStatus = response.status;
        if (response.status < 500 && response.status !== 429) break;
      } catch {
        lastStatus = null;
      }

      if (attempt < input.maxAttempts) {
        await wait(input.retryDelayMs * attempt);
      }
    }

    if (verified) continue;
    if (lastStatus !== null) {
      throw new Error(
        `Meilisearch ${input.role} key validation failed with status ${lastStatus}`
      );
    }
    throw new Error(`Meilisearch ${input.role} key validation failed`);
  }
}

export function createMeilisearchKeyUid(
  indexPrefix: string,
  role: KeyRole
): string {
  const digest = createHash("sha256")
    .update(`focowiki:meilisearch-key:${KEY_CONTRACT_VERSION}:${indexPrefix}:${role}`)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

function createKeyDefinitions(indexPrefix: string): KeyDefinition[] {
  return [
    {
      uid: createMeilisearchKeyUid(indexPrefix, "runtime"),
      name: `Focowiki ${indexPrefix} runtime`,
      description: "Scoped server-side key managed by Focowiki",
      actions: RUNTIME_ACTIONS,
      indexes: [`${indexPrefix}_*`],
      expiresAt: null,
      fileName: API_KEY_FILE
    },
    {
      uid: createMeilisearchKeyUid(indexPrefix, "metrics"),
      name: `Focowiki ${indexPrefix} diagnostics`,
      description: "Read-only diagnostics key managed by Focowiki",
      actions: METRICS_ACTIONS,
      indexes: ["*"],
      expiresAt: null,
      fileName: METRICS_KEY_FILE
    }
  ];
}

async function ensureKey(
  request: ReturnType<typeof createRequestClient>,
  definition: KeyDefinition
): Promise<ApiKeyRecord> {
  const existing = await request<ApiKeyRecord>(
    `/keys/${encodeURIComponent(definition.uid)}`,
    { method: "GET", allowNotFound: true }
  );
  if (existing && matchesDefinition(existing, definition)) return existing;

  if (existing) {
    await request(`/keys/${encodeURIComponent(definition.uid)}`, {
      method: "DELETE"
    });
  }

  const created = await request<ApiKeyRecord>("/keys", {
    method: "POST",
    body: {
      uid: definition.uid,
      name: definition.name,
      description: definition.description,
      actions: definition.actions,
      indexes: definition.indexes,
      expiresAt: definition.expiresAt
    }
  });
  if (!created || !created.key) {
    throw new Error("Meilisearch key creation returned an invalid response");
  }
  return created;
}

function matchesDefinition(record: ApiKeyRecord, definition: KeyDefinition): boolean {
  return (
    record.uid === definition.uid
    && sameStrings(record.actions, definition.actions)
    && sameStrings(record.indexes, definition.indexes)
    && record.expiresAt === definition.expiresAt
    && Boolean(record.key)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function createRequestClient(input: {
  endpoint: string;
  masterKey: string;
  fetch: typeof globalThis.fetch;
  maxAttempts: number;
  retryDelayMs: number;
}) {
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("Meilisearch bootstrap max attempts must be a positive integer");
  }
  if (!Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0) {
    throw new Error("Meilisearch bootstrap retry delay must be a non-negative integer");
  }

  return async function request<T = undefined>(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      body?: unknown;
      allowNotFound?: boolean;
    }
  ): Promise<T | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      try {
        const response = await input.fetch(
          new URL(path, `${input.endpoint}/`),
          {
            method: options.method,
            headers: {
              authorization: `Bearer ${input.masterKey}`,
              ...(options.body ? { "content-type": "application/json" } : {})
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
            signal: AbortSignal.timeout(5_000)
          }
        );
        if (response.status === 404 && options.allowNotFound) return null;
        if (!response.ok) {
          const retryable = response.status >= 500 || response.status === 429;
          if (retryable && attempt < input.maxAttempts) {
            await wait(input.retryDelayMs * attempt);
            continue;
          }
          throw new MeilisearchBootstrapRequestError(
            `Meilisearch key request failed with status ${response.status}`,
            retryable
          );
        }
        if (response.status === 204) return null;
        return await response.json() as T;
      } catch (error) {
        lastError = error;
        if (
          error instanceof MeilisearchBootstrapRequestError
          && !error.retryable
        ) {
          throw error;
        }
        if (attempt === input.maxAttempts) break;
        await wait(input.retryDelayMs * attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Meilisearch key request failed");
  };
}

function persistSecret(directory: string, fileName: string, value: string): void {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SECRET_LENGTH) {
    throw new Error("Meilisearch returned an invalid key");
  }

  const target = join(directory, fileName);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${normalized}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MEILI_HOST must use http or https");
  }
  return value.replace(/\/+$/u, "");
}

function validateIndexPrefix(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(normalized)) {
    throw new Error("SEARCH_INDEX_PREFIX is invalid");
  }
  return normalized;
}

function normalizeProvidedSecret(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized === "bootstrap-pending" ? "" : normalized;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
