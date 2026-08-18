import { createHash } from "node:crypto";
import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { GraphRagChunkOutputPort } from
  "../../semantic/graphrag/extraction-gateway.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type { createPostgresDocumentGraphRagChunkRepository } from
  "./postgres-document-graphrag-chunk-repository.js";
import {
  immutableArtifactWriteAttempt,
  ownerIdentity
} from "./production-document-identities.js";

export function createDurableGraphRagChunkOutputPort(input: {
  claimed: ClaimedDocumentArtifactWork;
  modelConfigurationIdentity: string;
  chunks: ReturnType<typeof createPostgresDocumentGraphRagChunkRepository>;
  objectWriter: StorageVnextImmutableObjectWriter;
  bodies: StorageVnextImmutableBodyStore;
  ownership: StorageVnextOwnershipRepository;
  leaseDurationMs: number;
  now(): string;
}): GraphRagChunkOutputPort {
  return {
    async resolve(request) {
      const inputFingerprintSha256 = createHash("sha256")
        .update(input.modelConfigurationIdentity)
        .update("\0")
        .update(request.promptFingerprintSha256)
        .digest("hex");
      const acquisition = await input.chunks.acquire({
        knowledgeBaseId: input.claimed.knowledgeBaseId,
        documentJobPublicId: input.claimed.documentJobPublicId,
        sourceRevisionPublicId: input.claimed.sourceRevisionPublicId,
        chunkNumber: request.chunkNumber,
        inputFingerprintSha256,
        workerId: input.claimed.leaseOwner,
        now: input.now(),
        leaseDurationMs: input.leaseDurationMs
      });
      if (acquisition.state === "completed") {
        const bytes = await input.bodies.readVerified({
          descriptor: {
            objectId: acquisition.receipt.objectId,
            storageKey: acquisition.receipt.storageKey,
            checksum: acquisition.receipt.checksumSha256,
            byteCount: acquisition.receipt.byteCount,
            contentType: acquisition.receipt.contentType,
            objectFormat: acquisition.receipt.objectFormat
          },
          maximumBytes: 300_000,
          signal: request.signal
        });
        return { output: decodeOutput(bytes), reused: true };
      }
      if (acquisition.state === "busy") {
        throw chunkError("graphrag_chunk_busy", true);
      }
      try {
        const output = await request.complete();
        const bytes = new TextEncoder().encode(JSON.stringify({
          schemaVersion: "document-graphrag-chunk-output-v1",
          output
        }));
        const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
        const stored = await input.objectWriter.putVerified({
          bytes,
          objectFormat: "okf-generated-json-v1",
          writeAttemptPublicId: immutableArtifactWriteAttempt(
            input.claimed.documentJobPublicId,
            `graphrag-chunk-${request.chunkNumber}-${inputFingerprintSha256}`,
            checksumSha256
          ),
          createdAt: input.now(),
          signal: request.signal
        });
        await input.ownership.attach({
          publicId: ownerIdentity(
            input.claimed.sourceRevisionPublicId,
            `graphrag_chunk:${stored.objectId}`
          ),
          knowledgeBaseId: input.claimed.knowledgeBaseId,
          objectId: stored.objectId,
          kind: "source_revision",
          ownerPublicId: input.claimed.sourceRevisionPublicId,
          createdAt: input.now()
        });
        const completed = await input.chunks.complete({
          publicId: acquisition.publicId,
          workerId: input.claimed.leaseOwner,
          receipt: {
            objectId: stored.objectId,
            storageKey: stored.storageKey,
            checksumSha256: stored.checksum,
            byteCount: stored.byteCount,
            contentType: stored.contentType,
            objectFormat: stored.objectFormat as "okf-generated-json-v1"
          },
          now: input.now()
        });
        if (!completed) throw chunkError("graphrag_chunk_lease_lost", true);
        return { output, reused: false };
      } catch (error) {
        await input.chunks.fail({
          publicId: acquisition.publicId,
          workerId: input.claimed.leaseOwner,
          safeErrorCode: errorCode(error),
          now: input.now()
        });
        throw error;
      }
    }
  };
}

function decodeOutput(bytes: Uint8Array): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw chunkError("graphrag_chunk_output_invalid", false);
  }
  if (!isRecord(value)
    || value.schemaVersion !== "document-graphrag-chunk-output-v1"
    || typeof value.output !== "string" || !value.output
    || value.output.length > 256_000) {
    throw chunkError("graphrag_chunk_output_invalid", false);
  }
  return value.output;
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string"
    && /^[a-zA-Z0-9_]{1,128}$/u.test(error.code)) return error.code;
  return "graphrag_chunk_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunkError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`GraphRAG chunk output error: ${code}`), {
    code,
    retryable
  });
}
