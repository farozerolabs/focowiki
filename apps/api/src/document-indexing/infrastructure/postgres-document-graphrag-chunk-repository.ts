import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export type DocumentGraphRagChunkReceipt = {
  objectId: string;
  storageKey: string;
  checksumSha256: string;
  byteCount: number;
  contentType: string;
  objectFormat: "okf-generated-json-v1";
};

type ChunkRow = {
  public_id: string;
  state: "waiting" | "running" | "completed" | "error";
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  output_receipt: Record<string, unknown> | null;
};

export function createPostgresDocumentGraphRagChunkRepository(sql: DatabaseClient) {
  return {
    async acquire(input: {
      knowledgeBaseId: string;
      documentJobPublicId: string;
      sourceRevisionPublicId: string;
      chunkNumber: number;
      inputFingerprintSha256: string;
      workerId: string;
      now: string;
      leaseDurationMs: number;
    }): Promise<
      | { state: "completed"; publicId: string; receipt: DocumentGraphRagChunkReceipt }
      | { state: "acquired"; publicId: string }
      | { state: "busy"; publicId: string }
    > {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const documentJobPublicId = assertRepositoryIdentity(
        input.documentJobPublicId,
        "document_job_public_id"
      );
      const sourceRevisionPublicId = assertRepositoryIdentity(
        input.sourceRevisionPublicId,
        "source_revision_public_id"
      );
      const workerId = assertRepositoryIdentity(input.workerId, "worker_id");
      const inputFingerprintSha256 = assertRepositorySha256(
        input.inputFingerprintSha256,
        "input_fingerprint"
      );
      if (!Number.isInteger(input.chunkNumber) || input.chunkNumber < 0
        || input.chunkNumber > 1_000_000) {
        throw repositoryContractError("invalid_chunk_number");
      }
      const now = assertRepositoryTimestamp(input.now, "now");
      const leaseDurationMs = assertRepositoryPositiveInteger(
        input.leaseDurationMs,
        "lease_duration",
        300_000
      );
      const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
      const publicId = `graphrag-chunk-${createHash("sha256")
        .update(JSON.stringify([
          knowledgeBaseId,
          sourceRevisionPublicId,
          input.chunkNumber,
          inputFingerprintSha256
        ]))
        .digest("hex")}`;
      await sql`
        INSERT INTO focowiki.document_graphrag_chunks (
          public_id, knowledge_base_id, document_job_public_id,
          source_revision_public_id, chunk_number,
          input_fingerprint_sha256, state
        ) VALUES (
          ${publicId}, ${knowledgeBaseId}, ${documentJobPublicId},
          ${sourceRevisionPublicId}, ${input.chunkNumber},
          ${inputFingerprintSha256}, 'waiting'
        )
        ON CONFLICT (
          knowledge_base_id, source_revision_public_id,
          chunk_number, input_fingerprint_sha256
        ) DO NOTHING
      `;
      const claimed = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.document_graphrag_chunks chunk
        SET state = 'running', lease_owner = ${workerId},
            lease_expires_at = ${leaseExpiresAt},
            attempt_count = chunk.attempt_count + 1,
            safe_error_code = NULL,
            started_at = coalesce(chunk.started_at, ${now}), ended_at = NULL
        WHERE chunk.knowledge_base_id = ${knowledgeBaseId}
          AND chunk.source_revision_public_id = ${sourceRevisionPublicId}
          AND chunk.chunk_number = ${input.chunkNumber}
          AND chunk.input_fingerprint_sha256 = ${inputFingerprintSha256}
          AND chunk.state <> 'completed'
          AND (chunk.state <> 'running' OR chunk.lease_expires_at <= ${now})
        RETURNING chunk.public_id
      `;
      if (claimed[0]) return { state: "acquired", publicId: claimed[0].public_id };
      const rows = await sql<ChunkRow[]>`
        SELECT public_id, state, lease_owner, lease_expires_at, output_receipt
        FROM focowiki.document_graphrag_chunks
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND source_revision_public_id = ${sourceRevisionPublicId}
          AND chunk_number = ${input.chunkNumber}
          AND input_fingerprint_sha256 = ${inputFingerprintSha256}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) throw repositoryContractError("graphrag_chunk_missing");
      if (row.state === "completed") {
        return {
          state: "completed",
          publicId: row.public_id,
          receipt: parseReceipt(row.output_receipt)
        };
      }
      return { state: "busy", publicId: row.public_id };
    },

    async complete(input: {
      publicId: string;
      workerId: string;
      receipt: DocumentGraphRagChunkReceipt;
      now: string;
    }): Promise<boolean> {
      const receipt = validateReceipt(input.receipt);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.document_graphrag_chunks
        SET state = 'completed', output_receipt = ${sql.json(receipt as never)},
            lease_owner = NULL, lease_expires_at = NULL,
            safe_error_code = NULL, ended_at = ${assertRepositoryTimestamp(input.now, "now")}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async fail(input: {
      publicId: string;
      workerId: string;
      safeErrorCode: string;
      now: string;
    }): Promise<boolean> {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.document_graphrag_chunks
        SET state = 'error', lease_owner = NULL, lease_expires_at = NULL,
            safe_error_code = ${assertRepositoryIdentity(input.safeErrorCode, "safe_error_code")},
            ended_at = ${assertRepositoryTimestamp(input.now, "now")}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}

function parseReceipt(value: Record<string, unknown> | null): DocumentGraphRagChunkReceipt {
  if (!value) throw repositoryContractError("graphrag_chunk_receipt_missing");
  return validateReceipt(value as DocumentGraphRagChunkReceipt);
}

function validateReceipt(
  value: DocumentGraphRagChunkReceipt
): DocumentGraphRagChunkReceipt {
  if (typeof value.objectId !== "string" || !value.objectId
    || typeof value.storageKey !== "string" || !value.storageKey
    || !/^[0-9a-f]{64}$/u.test(value.checksumSha256)
    || !Number.isSafeInteger(value.byteCount) || value.byteCount < 1
    || value.contentType !== "application/json; charset=utf-8"
    || value.objectFormat !== "okf-generated-json-v1") {
    throw repositoryContractError("invalid_graphrag_chunk_receipt");
  }
  return { ...value };
}
