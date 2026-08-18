import type { DatabaseClient } from "../../db/client.js";
import type { DocumentReceiptKind } from
  "../application/document-work-port.js";
import {
  assertRepositoryIdentity,
  assertRepositorySha256,
  repositoryContractError
} from "./document-repository-validation.js";

export type DocumentArtifactReceipt = {
  publicId: string;
  documentJobPublicId: string;
  workPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  kind: DocumentReceiptKind;
  key: string;
  inputFingerprintSha256: string;
  outputFingerprintSha256: string;
  value: Readonly<Record<string, unknown>>;
  committedAt: string;
};

type ReceiptRow = {
  public_id: string;
  document_job_public_id: string;
  work_public_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  receipt_kind: DocumentReceiptKind;
  receipt_key: string;
  input_fingerprint_sha256: string;
  output_fingerprint_sha256: string;
  receipt: Record<string, unknown>;
  committed_at: string | Date;
};

export function createPostgresDocumentReceiptRepository(sql: DatabaseClient) {
  return {
    async findReusable(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicId: string;
      kind: DocumentReceiptKind;
      key: string;
      inputFingerprintSha256: string;
    }): Promise<DocumentArtifactReceipt | null> {
      if (Buffer.byteLength(input.key, "utf8") > 1_024) {
        throw repositoryContractError("invalid_receipt_key");
      }
      const rows = await sql<ReceiptRow[]>`
        SELECT public_id, document_job_public_id, work_public_id,
               source_file_public_id, source_revision_public_id,
               receipt_kind, receipt_key, input_fingerprint_sha256,
               output_fingerprint_sha256, receipt, committed_at
        FROM focowiki.document_artifact_receipts
        WHERE knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND source_revision_public_id = ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")}
          AND receipt_kind = ${input.kind}
          AND receipt_key = ${input.key}
          AND input_fingerprint_sha256 = ${assertRepositorySha256(input.inputFingerprintSha256, "input_fingerprint")}
        LIMIT 1
      `;
      return rows[0] ? mapReceipt(rows[0]) : null;
    },

    async findForRevision(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicId: string;
      kind: DocumentReceiptKind;
      key: string;
    }): Promise<DocumentArtifactReceipt | null> {
      if (Buffer.byteLength(input.key, "utf8") > 1_024) {
        throw repositoryContractError("invalid_receipt_key");
      }
      const rows = await sql<ReceiptRow[]>`
        SELECT public_id, document_job_public_id, work_public_id,
               source_file_public_id, source_revision_public_id,
               receipt_kind, receipt_key, input_fingerprint_sha256,
               output_fingerprint_sha256, receipt, committed_at
        FROM focowiki.document_artifact_receipts
        WHERE knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND source_revision_public_id = ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")}
          AND receipt_kind = ${input.kind} AND receipt_key = ${input.key}
        ORDER BY committed_at DESC, public_id
        LIMIT 1
      `;
      return rows[0] ? mapReceipt(rows[0]) : null;
    },

    async listForRevision(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicId: string;
    }): Promise<readonly DocumentArtifactReceipt[]> {
      const rows = await sql<ReceiptRow[]>`
        SELECT public_id, document_job_public_id, work_public_id,
               source_file_public_id, source_revision_public_id,
               receipt_kind, receipt_key, input_fingerprint_sha256,
               output_fingerprint_sha256, receipt, committed_at
        FROM focowiki.document_artifact_receipts
        WHERE knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND source_revision_public_id = ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")}
        ORDER BY receipt_kind, receipt_key, public_id
      `;
      return rows.map(mapReceipt);
    }
  };
}

function mapReceipt(row: ReceiptRow): DocumentArtifactReceipt {
  return {
    publicId: row.public_id,
    documentJobPublicId: row.document_job_public_id,
    workPublicId: row.work_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    kind: row.receipt_kind,
    key: row.receipt_key,
    inputFingerprintSha256: row.input_fingerprint_sha256,
    outputFingerprintSha256: row.output_fingerprint_sha256,
    value: row.receipt,
    committedAt: row.committed_at instanceof Date
      ? row.committed_at.toISOString()
      : new Date(row.committed_at).toISOString()
  };
}
