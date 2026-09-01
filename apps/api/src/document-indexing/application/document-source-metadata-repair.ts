import { analyzeDocumentSourceMarkdown } from
  "../domain/document-source-metadata.js";

export type DocumentSourceMetadataRepairClaim = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  objectId: string;
  checksumSha256: string;
  byteCount: number;
  contentType: string;
  repairStartedAt: string;
};

export type DocumentSourceMetadataRepairRepository = {
  claim(input: {
    now: string;
    staleBefore: string;
    limit: number;
  }): Promise<readonly DocumentSourceMetadataRepairClaim[]>;
  complete(input: DocumentSourceMetadataRepairClaim & {
    title: string;
    metadata: Readonly<Record<string, unknown>>;
    completedAt: string;
  }): Promise<boolean>;
  defer(input: DocumentSourceMetadataRepairClaim & {
    safeErrorCode: string;
    deferredAt: string;
  }): Promise<void>;
};

export type DocumentSourceMetadataRepairBodyStore = {
  readVerified(input: {
    objectId: string;
    checksum: string;
    byteCount: number;
    contentType: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
};

export function createDocumentSourceMetadataRepair(input: {
  concurrency: number;
  maximumSourceBytes: number;
  repository: DocumentSourceMetadataRepairRepository;
  bodies: DocumentSourceMetadataRepairBodyStore;
  onFailure?(input: {
    claim: DocumentSourceMetadataRepairClaim;
    safeErrorCode: string;
  }): void;
}) {
  assertPositiveInteger(input.concurrency, "concurrency");
  assertPositiveInteger(input.maximumSourceBytes, "maximumSourceBytes");
  return {
    async runBatch(request: {
      now: string;
      staleBefore: string;
      limit: number;
      signal: AbortSignal;
    }): Promise<{ claimed: number; completed: number; deferred: number }> {
      assertPositiveInteger(request.limit, "limit");
      const claims = await input.repository.claim({
        now: request.now,
        staleBefore: request.staleBefore,
        limit: request.limit
      });
      let completed = 0;
      let deferred = 0;
      let cursor = 0;
      await Promise.all(Array.from(
        { length: Math.min(input.concurrency, claims.length) },
        async () => {
          while (cursor < claims.length) {
            const claim = claims[cursor++]!;
            throwIfAborted(request.signal);
            try {
              const bytes = await input.bodies.readVerified({
                objectId: claim.objectId,
                checksum: claim.checksumSha256,
                byteCount: claim.byteCount,
                contentType: claim.contentType,
                maxBytes: input.maximumSourceBytes,
                signal: request.signal
              });
              const content = decodeUtf8(bytes);
              const analyzed = analyzeDocumentSourceMarkdown({
                fileName: claim.logicalPath.split("/").at(-1)!,
                content
              });
              if (await input.repository.complete({
                ...claim,
                title: analyzed.resolvedMetadata.title,
                metadata: analyzed.parsedMetadata,
                completedAt: request.now
              })) completed += 1;
            } catch (error) {
              if (request.signal.aborted) throw request.signal.reason ?? error;
              const errorCode = safeErrorCode(error);
              await input.repository.defer({
                ...claim,
                safeErrorCode: errorCode,
                deferredAt: request.now
              });
              input.onFailure?.({ claim, safeErrorCode: errorCode });
              deferred += 1;
            }
          }
        }
      ));
      return { claimed: claims.length, completed, deferred };
    }
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error("Invalid source UTF-8"), {
      code: "source_utf8_invalid"
    });
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (/^[a-z0-9_]{1,80}$/u.test(code)) return code;
  }
  return "source_metadata_repair_failed";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Aborted");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}
