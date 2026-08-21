import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentWorkKind } from "../domain/document-work-graph.js";
import { createPostgresDocumentArtifactWorkRepository } from
  "./postgres-document-artifact-work-repository.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export const DOCUMENT_PROCESSING_GENERATION = "document-indexing-v13";

export type CreateDocumentJobInput = {
  publicId: string;
  knowledgeBaseId: string;
  operationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  runtimeSettingsRevisionPublicId: string;
  generationModelConfigurationPublicId: string;
  generationModelConfigurationRevision: number;
  embeddingConfigurationRevisionPublicId: string;
  semanticGenerationPublicId: string;
  semanticContractVersion: string;
  maximumAttempts: number;
  acceptedAt: string;
  inputFingerprints: Record<DocumentWorkKind, string>;
};

export function createPostgresDocumentJobRepository(sql: DatabaseClient) {
  return {
    async create(input: CreateDocumentJobInput): Promise<"created" | "existing"> {
      validateCreateInput(input);
      return transaction(sql, async (tx) => {
        const rows = await tx<Array<{ public_id: string }>>`
          INSERT INTO focowiki.document_processing_jobs (
            public_id, knowledge_base_id, operation_public_id,
            source_file_public_id, source_revision_public_id,
            runtime_settings_revision_public_id,
            generation_model_configuration_public_id,
            generation_model_configuration_revision,
            embedding_configuration_revision_public_id,
            semantic_generation_public_id, semantic_contract_version,
            processing_generation, state, maximum_attempts,
            accepted_at, created_at, updated_at
          ) VALUES (
            ${input.publicId}, ${input.knowledgeBaseId}, ${input.operationPublicId},
            ${input.sourceFilePublicId}, ${input.sourceRevisionPublicId},
            ${input.runtimeSettingsRevisionPublicId},
            ${input.generationModelConfigurationPublicId},
            ${input.generationModelConfigurationRevision},
            ${input.embeddingConfigurationRevisionPublicId},
            ${input.semanticGenerationPublicId}, ${input.semanticContractVersion},
            ${DOCUMENT_PROCESSING_GENERATION}, 'waiting',
            ${input.maximumAttempts}, ${input.acceptedAt},
            ${input.acceptedAt}, ${input.acceptedAt}
          )
          ON CONFLICT (knowledge_base_id, source_revision_public_id) DO NOTHING
          RETURNING public_id
        `;
        const existing = await tx<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.document_processing_jobs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_revision_public_id = ${input.sourceRevisionPublicId}
        `;
        if (existing[0]?.public_id !== input.publicId) {
          throw repositoryContractError("document_job_identity_conflict");
        }
        await createPostgresDocumentArtifactWorkRepository(
          tx as unknown as DatabaseClient
        ).createFixedGraph({
          knowledgeBaseId: input.knowledgeBaseId,
          documentJobPublicId: input.publicId,
          sourceFilePublicId: input.sourceFilePublicId,
          sourceRevisionPublicId: input.sourceRevisionPublicId,
          inputFingerprints: input.inputFingerprints,
          maximumAttempts: input.maximumAttempts,
          acceptedAt: input.acceptedAt
        });
        return rows.length === 1 ? "created" : "existing";
      });
    },

    async requestCancellation(input: {
      publicId: string;
      requestedAt: string;
    }): Promise<boolean> {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.document_processing_jobs
        SET cancellation_requested_at = ${assertRepositoryTimestamp(input.requestedAt, "requested_at")},
            updated_at = ${input.requestedAt}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state IN ('waiting', 'processing')
          AND cancellation_requested_at IS NULL
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}

function validateCreateInput(input: CreateDocumentJobInput): void {
  for (const [field, value] of [
    ["public_id", input.publicId],
    ["knowledge_base_id", input.knowledgeBaseId],
    ["operation_public_id", input.operationPublicId],
    ["source_file_public_id", input.sourceFilePublicId],
    ["source_revision_public_id", input.sourceRevisionPublicId],
    ["runtime_settings_revision_public_id", input.runtimeSettingsRevisionPublicId],
    ["generation_model_configuration_public_id", input.generationModelConfigurationPublicId],
    ["embedding_configuration_revision_public_id", input.embeddingConfigurationRevisionPublicId],
    ["semantic_generation_public_id", input.semanticGenerationPublicId],
    ["semantic_contract_version", input.semanticContractVersion]
  ] as const) assertRepositoryIdentity(value, field);
  assertRepositoryPositiveInteger(input.maximumAttempts, "maximum_attempts", 100);
  assertRepositoryTimestamp(input.acceptedAt, "accepted_at");
  if (!Number.isSafeInteger(input.generationModelConfigurationRevision)
    || input.generationModelConfigurationRevision < 1) {
    throw repositoryContractError("invalid_generation_model_revision");
  }
}

function transaction<T>(
  sql: DatabaseClient,
  callback: (transactionSql: TransactionSql) => Promise<T>
): Promise<T> {
  return typeof sql.begin === "function"
    ? sql.begin(callback as never) as Promise<T>
    : callback(sql as unknown as TransactionSql);
}
