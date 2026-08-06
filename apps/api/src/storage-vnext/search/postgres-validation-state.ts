import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextSearchProjectionRepository
} from "./projection-repository.js";
import { storageVnextSearchRepositoryError as repositoryError } from "./postgres-repository-errors.js";

type ValidationStateRepository = Pick<
  StorageVnextSearchProjectionRepository,
  | "beginCandidateValidation"
  | "completeCandidateValidation"
  | "failCandidateValidation"
>;

type ValidationRow = {
  projection_role: string;
  state: string;
  document_count: number | string;
  schema_checksum_sha256: string;
  settings_checksum_sha256: string;
  document_checksum_sha256: string | null;
  correlation_public_id: string | null;
  provider_task_uid: number | string | null;
};

export function createPostgresStorageVnextSearchValidationState(
  sql: DatabaseClient
): ValidationStateRepository {
  return {
    async beginCandidateValidation(input) {
      assertId(input.candidatePublicId);
      assertOrdinal(input.expectedDocumentCount);
      assertChecksum(input.documentChecksum);
      assertChecksum(input.schemaChecksum);
      assertChecksum(input.settingsChecksum);
      return sql.begin(async (transaction) => {
        const candidate = await requireCandidate(transaction, input.candidatePublicId);
        if (
          Number(candidate.document_count) !== input.expectedDocumentCount
          || candidate.schema_checksum_sha256 !== input.schemaChecksum
          || candidate.settings_checksum_sha256 !== input.settingsChecksum
        ) throw repositoryError("validation_conflict");
        if (candidate.state === "ready") {
          if (candidate.document_checksum_sha256 !== input.documentChecksum) {
            throw repositoryError("validation_conflict");
          }
          return { outcome: "completed" as const };
        }
        if (candidate.state !== "indexing" && candidate.state !== "validating") {
          throw repositoryError("invalid_state");
        }
        if (
          candidate.correlation_public_id
          || candidate.provider_task_uid !== null
        ) throw repositoryError("invalid_state");
        if (
          candidate.document_checksum_sha256
          && candidate.document_checksum_sha256 !== input.documentChecksum
        ) throw repositoryError("validation_conflict");
        await transaction`
          UPDATE focowiki.search_projections
          SET state = 'validating',
              document_checksum_sha256 = ${input.documentChecksum},
              revision = revision + CASE WHEN state = 'indexing' THEN 1 ELSE 0 END,
              updated_at = now()
          WHERE public_id = ${input.candidatePublicId}
        `;
        return { outcome: "validate" as const };
      });
    },

    async completeCandidateValidation(input) {
      assertId(input.candidatePublicId);
      assertChecksum(input.documentChecksum);
      await sql.begin(async (transaction) => {
        const candidate = await requireCandidate(transaction, input.candidatePublicId);
        if (candidate.document_checksum_sha256 !== input.documentChecksum) {
          throw repositoryError("validation_conflict");
        }
        if (candidate.state === "ready") return;
        if (candidate.state !== "validating") throw repositoryError("invalid_state");
        await transaction`
          UPDATE focowiki.search_projections
          SET state = 'ready', revision = revision + 1, updated_at = now()
          WHERE public_id = ${input.candidatePublicId}
            AND correlation_public_id IS NULL AND provider_task_uid IS NULL
        `;
      });
    },

    async failCandidateValidation(input) {
      assertId(input.candidatePublicId);
      assertSafeErrorCode(input.safeErrorCode);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET state = 'failed', safe_error_code = ${input.safeErrorCode},
            correlation_public_id = NULL, provider_task_uid = NULL,
            revision = revision + CASE
              WHEN state = 'failed' AND safe_error_code = ${input.safeErrorCode}
                THEN 0 ELSE 1 END,
            updated_at = now()
        WHERE public_id = ${input.candidatePublicId}
          AND projection_role = 'candidate'
          AND state IN ('preparing', 'indexing', 'validating', 'failed')
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("invalid_state");
    }
  };
}

async function requireCandidate(sql: TransactionSql, publicId: string) {
  const rows = await sql<ValidationRow[]>`
    SELECT projection_role, state, document_count, schema_checksum_sha256,
           settings_checksum_sha256, document_checksum_sha256,
           correlation_public_id, provider_task_uid
    FROM focowiki.search_projections
    WHERE public_id = ${publicId}
    FOR UPDATE
  `;
  const candidate = rows[0];
  if (!candidate) throw repositoryError("projection_not_found");
  if (candidate.projection_role !== "candidate") {
    throw repositoryError("projection_conflict");
  }
  return candidate;
}

function assertId(value: string) {
  if (!value || Buffer.byteLength(value) > 255) {
    throw repositoryError("invalid_input");
  }
}

function assertChecksum(value: string) {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw repositoryError("invalid_input");
}

function assertOrdinal(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw repositoryError("invalid_input");
}

function assertSafeErrorCode(value: string) {
  if (!value || Buffer.byteLength(value) > 128) throw repositoryError("invalid_input");
}
