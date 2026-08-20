import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type {
  SearchProviderDocument,
  SearchProviderOperationReceipt
} from "../../application/ports/search-provider-runtime.js";
import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";
import type { StorageVnextSearchDocument } from
  "../../storage-vnext/search/documents.js";
import type { OpenSearchClientPort } from "./opensearch-client-port.js";
import { normalizeOpenSearchError } from "./opensearch-errors.js";
import { serializeOpenSearchDocument } from "./opensearch-index-schema.js";

type BulkLimits = {
  maximumDocuments: number;
  maximumBytes: number;
  maximumInFlight: number;
  maximumAttempts: number;
  retryDelayMs: number;
  deadlineMs: number;
};

type SerializedDocument = {
  id: string;
  source: Record<string, unknown>;
};

export function createOpenSearchBulkWriter(input: {
  client: Pick<OpenSearchClientPort, "bulk">;
  tokenizer: LexicalTokenizer;
  limits: BulkLimits;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}) {
  assertLimits(input.limits);
  if (!input.tokenizer.contractVersion) throw mappingError();
  const sleep = input.sleep ?? wait;
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  return async (request: {
    indexUid: string;
    documents: readonly SearchProviderDocument[];
    correlation: string;
  }): Promise<SearchProviderOperationReceipt> => {
    if (!request.indexUid || !request.correlation || request.documents.length === 0) {
      throw requestError(false);
    }
    const serialized = request.documents.map((document) => serialize(document));
    const groups = partition(serialized, request.indexUid, input.limits);
    const startedAt = now();
    let nextGroup = 0;
    let firstError: unknown = null;
    const workers = Array.from({
      length: Math.min(input.limits.maximumInFlight, groups.length)
    }, async () => {
      while (firstError === null) {
        const groupIndex = nextGroup;
        nextGroup += 1;
        const group = groups[groupIndex];
        if (!group) return;
        try {
          await writeGroup(group, request.indexUid, startedAt);
        } catch (error) {
          firstError ??= error;
        }
      }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
    return { state: "completed" };
  };

  function serialize(document: SearchProviderDocument): SerializedDocument {
    const serialized = serializeOpenSearchDocument({
      document: document as StorageVnextSearchDocument,
      tokenizer: input.tokenizer
    });
    return {
      id: serialized._id,
      source: serialized._source
    };
  }

  async function writeGroup(
    group: readonly SerializedDocument[],
    indexUid: string,
    startedAt: number
  ): Promise<void> {
    let pending = [...group];
    for (let attempt = 1; attempt <= input.limits.maximumAttempts; attempt += 1) {
      assertDeadline(startedAt);
      const body = pending.flatMap((document) => [{
        index: { _index: indexUid, _id: document.id }
      }, document.source]);
      let response: unknown;
      try {
        response = (await input.client.bulk({ body }, {
          maxRetries: 0,
          requestTimeout: remainingMilliseconds(startedAt)
        })).body;
      } catch (error) {
        const mapped = normalizeOpenSearchError(error);
        if (!mapped.retryable || attempt === input.limits.maximumAttempts) throw mapped;
        await delay(attempt, startedAt);
        continue;
      }
      assertDeadline(startedAt);
      const outcomes = parseBulkOutcomes(response, pending);
      const terminal = outcomes.find((outcome) => outcome.error !== null);
      if (terminal?.error) throw terminal.error;
      pending = outcomes
        .filter((outcome) => outcome.retry)
        .map((outcome) => outcome.document);
      if (pending.length === 0) return;
      if (attempt === input.limits.maximumAttempts) {
        throw new SearchProviderError("SEARCH_ENGINE_OVERLOADED", true);
      }
      await delay(attempt, startedAt);
    }
  }

  async function delay(attempt: number, startedAt: number) {
    const delayMs = withBoundedJitter(
      input.limits.retryDelayMs * attempt,
      random()
    );
    if (now() - startedAt + delayMs >= input.limits.deadlineMs) {
      throw new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true);
    }
    await sleep(delayMs);
    assertDeadline(startedAt);
  }

  function assertDeadline(startedAt: number) {
    if (now() - startedAt >= input.limits.deadlineMs) {
      throw new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true);
    }
  }

  function remainingMilliseconds(startedAt: number): number {
    return Math.max(1, input.limits.deadlineMs - (now() - startedAt));
  }
}

function withBoundedJitter(delayMs: number, randomValue: number): number {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw requestError(false);
  }
  const radius = Math.floor(delayMs / 4);
  const offset = Math.min(
    radius * 2,
    Math.floor(randomValue * (radius * 2 + 1))
  );
  return delayMs - radius + offset;
}

function partition(
  documents: readonly SerializedDocument[],
  indexUid: string,
  limits: BulkLimits
): SerializedDocument[][] {
  const output: SerializedDocument[][] = [];
  let current: SerializedDocument[] = [];
  let currentBytes = 0;
  for (const document of documents) {
    const documentBytes = lineBytes({
      index: { _index: indexUid, _id: document.id }
    }) + lineBytes(document.source);
    if (documentBytes > limits.maximumBytes) throw mappingError();
    if (
      current.length >= limits.maximumDocuments
      || currentBytes + documentBytes > limits.maximumBytes
    ) {
      output.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(document);
    currentBytes += documentBytes;
  }
  if (current.length > 0) output.push(current);
  return output;
}

function parseBulkOutcomes(
  value: unknown,
  documents: readonly SerializedDocument[]
): Array<{
  document: SerializedDocument;
  retry: boolean;
  error: SearchProviderError | null;
}> {
  const record = objectValue(value);
  const items = Array.isArray(record?.items) ? record.items : null;
  if (!items || items.length !== documents.length) throw requestError(false);
  return items.map((item, index) => {
    const operation = objectValue(objectValue(item)?.index);
    const status = operation?.status;
    const id = operation?._id;
    if (!Number.isSafeInteger(status) || id !== documents[index]!.id) {
      throw requestError(false);
    }
    const numericStatus = Number(status);
    if (numericStatus >= 200 && numericStatus < 300) {
      return { document: documents[index]!, retry: false, error: null };
    }
    if ([408, 429, 502, 503, 504].includes(numericStatus)) {
      return { document: documents[index]!, retry: true, error: null };
    }
    return {
      document: documents[index]!,
      retry: false,
      error: itemError(numericStatus, objectValue(operation?.error)?.type)
    };
  });
}

function itemError(status: number, type: unknown): SearchProviderError {
  if (status === 401) {
    return new SearchProviderError("SEARCH_ENGINE_AUTHENTICATION_FAILED", false);
  }
  if (status === 403) {
    return new SearchProviderError("SEARCH_ENGINE_AUTHORIZATION_FAILED", false);
  }
  if (typeof type === "string" && /mapping|mapper|document_parsing/u.test(type)) {
    return mappingError();
  }
  return requestError(false);
}

function assertLimits(limits: BulkLimits): void {
  for (const value of [
    limits.maximumDocuments,
    limits.maximumBytes,
    limits.maximumInFlight,
    limits.maximumAttempts,
    limits.deadlineMs
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw requestError(false);
  }
  if (
    limits.maximumDocuments > 10_000
    || limits.maximumAttempts > 20
    || limits.maximumBytes > 100_000_000
    || limits.deadlineMs > 3_600_000
    || !Number.isSafeInteger(limits.retryDelayMs)
    || limits.retryDelayMs < 0
  ) throw requestError(false);
}

function lineBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mappingError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_MAPPING_INVALID", false);
}

function requestError(retryable: boolean): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", retryable);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
