import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { normalizeSourceRelativePath } from "../../domain/source-path.js";
import { createDocumentSourceRevisionPublicId } from
  "../domain/source-revision-identity.js";
import { createStorageVnextUploadIdentity } from
  "../../storage-vnext/upload/identity.js";
import { createDocumentJobPublicId } from "../domain/document-job-identity.js";
import { documentFixedWorkInputFingerprints } from
  "../domain/document-fixed-work-identity.js";
import { readDocumentSemanticContract } from
  "./postgres-document-semantic-contract.js";
import { createPostgresDocumentJobRepository } from
  "./postgres-document-job-repository.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import { terminalizePostgresDocumentWork } from
  "./postgres-document-work-terminalization.js";

export type DocumentReplacementAcceptance = {
  operationPublicId: string;
  documentJobPublicId: string;
  sourceRevisionPublicId: string;
  state: "waiting" | "processing" | "available" | "error"
    | "deleting" | "cancelled" | "superseded";
  replayed: boolean;
};

type DocumentRevisionMutationInput = {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    operationPublicId: string;
    idempotencyKey: string;
    expectedResourceRevision: number;
    runtimeSettingsRevisionPublicId: string;
    maximumAttempts: number;
    objectId: string;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
    logicalPath: string;
    directoryPublicId: string | null;
    title: string;
    metadata: Readonly<Record<string, unknown>>;
    acceptedAt: string;
    expiresAt: string;
    operationKind: "source_replace" | "source_file_move";
    revisionVariant: string;
};

type PublicDocumentRevisionMutationInput = Omit<
  DocumentRevisionMutationInput,
  "operationKind" | "revisionVariant"
>;

export function createPostgresDocumentReplacement(sql: DatabaseClient) {
  const accept = createPostgresDocumentRevisionMutation(sql);
  return (input: PublicDocumentRevisionMutationInput) => accept({
    ...input,
    operationKind: "source_replace",
    revisionVariant: documentRevisionMutationVariant({
      operationKind: "source_replace",
      expectedResourceRevision: input.expectedResourceRevision,
      logicalPath: input.logicalPath
    })
  });
}

export function createPostgresDocumentMove(sql: DatabaseClient) {
  const accept = createPostgresDocumentRevisionMutation(sql);
  return (input: PublicDocumentRevisionMutationInput & {
    activeSourceRevisionPublicId: string;
  }) => accept({
    ...input,
    operationKind: "source_file_move",
    revisionVariant: documentRevisionMutationVariant({
      operationKind: "source_file_move",
      expectedResourceRevision: input.expectedResourceRevision,
      logicalPath: input.logicalPath
    })
  });
}

export function documentRevisionMutationVariant(input: {
  operationKind: "source_replace" | "source_file_move";
  expectedResourceRevision: number;
  logicalPath: string;
}): string {
  if (!Number.isSafeInteger(input.expectedResourceRevision)
    || input.expectedResourceRevision < 1) {
    throw replacementError("invalid_resource_revision");
  }
  const nextResourceRevision = input.expectedResourceRevision + 1;
  return input.operationKind === "source_replace"
    ? `content:resource:${nextResourceRevision}`
    : `presentation:${normalizeSourceRelativePath(input.logicalPath).pathKey}`
      + `:resource:${nextResourceRevision}`;
}

export function isDocumentRevisionMutationBusy(input: {
  activeSourceRevisionPublicId: string | null;
  currentSourceRevisionPublicId: string | null;
  currentJobState: string | null;
}): boolean {
  return input.currentSourceRevisionPublicId
    !== input.activeSourceRevisionPublicId
    && input.currentJobState !== "error";
}

function createPostgresDocumentRevisionMutation(sql: DatabaseClient) {
  return async (input: DocumentRevisionMutationInput): Promise<DocumentReplacementAcceptance> => {
    validateInput(input);
    const normalizedPath = normalizeSourceRelativePath(input.logicalPath).pathKey;
    const sourceRevisionPublicId = createDocumentSourceRevisionPublicId({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: input.sourceFilePublicId,
      checksum: input.checksumSha256,
      variant: input.revisionVariant
    });
    const documentJobPublicId = createDocumentJobPublicId({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceRevisionPublicId
    });
    const requestHash = replacementRequestHash({
      ...input,
      sourceRevisionPublicId,
      normalizedPath
    });
    return sql.begin(async (transaction) => {
      const replay = await transaction<Array<{
        request_hash: string;
        operation_public_id: string;
        document_job_public_id: string;
        source_revision_public_id: string;
        state: string;
      }>>`
        SELECT idempotency.request_hash, idempotency.operation_public_id,
               job.public_id AS document_job_public_id,
               job.source_revision_public_id, job.state
        FROM focowiki.operation_idempotency idempotency
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = idempotency.knowledge_base_id
         AND job.operation_public_id = idempotency.operation_public_id
        WHERE idempotency.knowledge_base_id = ${input.knowledgeBaseId}
          AND idempotency.idempotency_key = ${input.idempotencyKey}
        FOR UPDATE OF idempotency, job
      `;
      if (replay[0]) {
        if (replay[0].request_hash !== requestHash
          || replay[0].source_revision_public_id !== sourceRevisionPublicId) {
          throw replacementError("idempotency_conflict");
        }
        return {
          operationPublicId: replay[0].operation_public_id,
          documentJobPublicId: replay[0].document_job_public_id,
          sourceRevisionPublicId: replay[0].source_revision_public_id,
          state: documentState(replay[0].state),
          replayed: true
        };
      }

      const sources = await transaction<Array<{
        revision: number | string;
        active_source_revision_public_id: string | null;
        current_source_revision_public_id: string | null;
        current_job_public_id: string | null;
        current_operation_public_id: string | null;
        current_job_state: string | null;
      }>>`
        SELECT source.revision, active.active_source_revision_public_id,
               active.current_source_revision_public_id,
               current_job.public_id AS current_job_public_id,
               current_job.operation_public_id AS current_operation_public_id,
               current_job.state AS current_job_state
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        LEFT JOIN focowiki.document_processing_jobs current_job
          ON current_job.knowledge_base_id = active.knowledge_base_id
         AND current_job.source_file_public_id = active.source_file_public_id
         AND current_job.source_revision_public_id =
             active.current_source_revision_public_id
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.public_id = ${input.sourceFilePublicId}
          AND source.deleted_at IS NULL
        FOR UPDATE OF source, active
      `;
      const source = sources[0];
      if (!source || (
        source.active_source_revision_public_id === null
        && source.current_job_state !== "error"
      )) {
        throw replacementError("resource_missing");
      }
      if (Number(source.revision) !== input.expectedResourceRevision) {
        throw replacementError("revision_conflict");
      }
      if (isDocumentRevisionMutationBusy({
        activeSourceRevisionPublicId: source.active_source_revision_public_id,
        currentSourceRevisionPublicId: source.current_source_revision_public_id,
        currentJobState: source.current_job_state
      })) {
        throw replacementError("mutation_conflict");
      }
      if (
        source.current_job_state === "error"
        && source.current_job_public_id
        && source.current_source_revision_public_id
      ) {
        await supersedeFailedCurrentRevision(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          sourceRevisionPublicId: source.current_source_revision_public_id,
          documentJobPublicId: source.current_job_public_id,
          operationPublicId: source.current_operation_public_id,
          supersededAt: input.acceptedAt
        });
      }
      const semantic = await readDocumentSemanticContract(
        transaction,
        input.knowledgeBaseId
      );

      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          expected_resource_revision, target_kind, target_public_id,
          created_at, updated_at
        ) VALUES (
          ${input.operationPublicId}, ${input.knowledgeBaseId}, ${input.operationKind},
          'processing', ${input.expectedResourceRevision}, 'source_file',
          ${input.sourceFilePublicId}, ${input.acceptedAt}, ${input.acceptedAt}
        )
      `;
      await transaction`
        INSERT INTO focowiki.operation_idempotency (
          public_id, knowledge_base_id, idempotency_key, request_hash,
          operation_public_id, expires_at, created_at
        ) VALUES (
          ${createStorageVnextUploadIdentity(
            "idempotency",
            "document-replacement",
            input.knowledgeBaseId,
            input.idempotencyKey
          )}, ${input.knowledgeBaseId}, ${input.idempotencyKey}, ${requestHash},
          ${input.operationPublicId}, ${input.expiresAt}, ${input.acceptedAt}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          public_id, knowledge_base_id, source_file_public_id, object_id,
          checksum_sha256, byte_count, content_type, created_at
        ) VALUES (
          ${sourceRevisionPublicId}, ${input.knowledgeBaseId},
          ${input.sourceFilePublicId}, ${input.objectId}, ${input.checksumSha256},
          ${input.byteCount}, ${input.contentType}, ${input.acceptedAt}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revision_presentations (
          knowledge_base_id, source_file_public_id, source_revision_public_id,
          directory_public_id, logical_path, normalized_path, title, metadata,
          created_at
        ) VALUES (
          ${input.knowledgeBaseId}, ${input.sourceFilePublicId},
          ${sourceRevisionPublicId}, ${input.directoryPublicId},
          ${input.logicalPath}, ${normalizedPath}, ${input.title},
          ${transaction.json(input.metadata as never)}, ${input.acceptedAt}
        )
      `;
      await transaction`
        UPDATE focowiki.source_files
        SET revision = revision + 1, updated_at = ${input.acceptedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND public_id = ${input.sourceFilePublicId}
          AND revision = ${input.expectedResourceRevision}
      `;
      await transaction`
        UPDATE focowiki.source_file_active_revisions
        SET current_source_revision_public_id = ${sourceRevisionPublicId},
            updated_at = ${input.acceptedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
      `;
      const generationModelConfigurationRevision = Number(
        semantic.generation_model_configuration_revision
      );
      await createPostgresDocumentJobRepository(
        transaction as unknown as DatabaseClient
      ).create({
        publicId: documentJobPublicId,
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: input.operationPublicId,
        sourceFilePublicId: input.sourceFilePublicId,
        sourceRevisionPublicId,
        runtimeSettingsRevisionPublicId: input.runtimeSettingsRevisionPublicId,
        generationModelConfigurationPublicId:
          semantic.generation_model_configuration_public_id,
        generationModelConfigurationRevision,
        embeddingConfigurationRevisionPublicId:
          semantic.embedding_configuration_revision_public_id,
        semanticGenerationPublicId: semantic.semantic_generation_public_id,
        semanticContractVersion: semantic.semantic_contract_version,
        maximumAttempts: input.maximumAttempts,
        acceptedAt: input.acceptedAt,
        inputFingerprints: documentFixedWorkInputFingerprints({
          sourceChecksumSha256: input.checksumSha256,
          runtimeSettingsRevisionPublicId: input.runtimeSettingsRevisionPublicId,
          generationModelConfigurationPublicId:
            semantic.generation_model_configuration_public_id,
          generationModelConfigurationRevision,
          embeddingConfigurationRevisionPublicId:
            semantic.embedding_configuration_revision_public_id,
          semanticContractVersion: semantic.semantic_contract_version
        })
      });
      await enqueuePostgresDocumentWebhookEvent(transaction, {
        documentJobPublicId,
        documentJobRevision: 0,
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: input.operationPublicId,
        sourceFilePublicId: input.sourceFilePublicId,
        eventType: "document.waiting",
        state: "waiting",
        occurredAt: input.acceptedAt,
        expiresAt: input.expiresAt
      });
      await transaction`
        INSERT INTO focowiki.object_owners (
          public_id, knowledge_base_id, object_id, owner_kind,
          source_revision_public_id
        ) VALUES (
          ${createStorageVnextUploadIdentity(
            "live-owner",
            "document-replacement",
            sourceRevisionPublicId,
            input.objectId
          )}, ${input.knowledgeBaseId}, ${input.objectId}, 'source_revision',
          ${sourceRevisionPublicId}
        )
      `;
      await transaction`
        UPDATE focowiki.object_registrations
        SET zero_owner_since = NULL
        WHERE object_id = ${input.objectId}
      `;
      return {
        operationPublicId: input.operationPublicId,
        documentJobPublicId,
        sourceRevisionPublicId,
        state: "waiting",
        replayed: false
      };
    });
  };
}

async function supersedeFailedCurrentRevision(
  sql: TransactionSql,
  input: {
    knowledgeBaseId: string;
    sourceRevisionPublicId: string;
    documentJobPublicId: string;
    operationPublicId: string | null;
    supersededAt: string;
  }
): Promise<void> {
  await terminalizePostgresDocumentWork({
    sql,
    documentJobPublicIds: [input.documentJobPublicId],
    state: "superseded",
    terminalAt: input.supersededAt
  });
  await sql`
    UPDATE focowiki.document_processing_jobs
    SET state = 'superseded',
        started_at = coalesce(started_at, accepted_at),
        terminal_at = ${input.supersededAt}, next_attempt_at = NULL,
        safe_error_code = NULL, safe_error_message = NULL,
        retryable = false, active_work_kinds = '{}'::text[],
        blocking_work_kind = NULL, retrying_work_kind = NULL,
        revision = revision + 1,
        updated_at = ${input.supersededAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.documentJobPublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
      AND state = 'error'
  `;
  const identity = createHash("sha256").update([
    "document-correction-v1",
    input.knowledgeBaseId,
    input.documentJobPublicId,
    input.sourceRevisionPublicId
  ].join("\0")).digest("hex");
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      document_job_public_id, source_revision_public_id,
      action_kind, cleanup_plane, search_provider_kind,
      resource_kind, resource_public_id, required, priority,
      sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    ) VALUES (
      ${`cleanup-document-correction-${identity}`}, ${input.knowledgeBaseId},
      ${input.operationPublicId}, ${input.documentJobPublicId},
      ${input.sourceRevisionPublicId}, 'document_revision_purge',
      'postgres', NULL, 'source_revision', ${input.sourceRevisionPublicId},
      true, 20, 0, ${`document-correction-${identity}`}, ${identity},
      '{}'::jsonb, 'queued', 0, 10, ${input.supersededAt},
      ${input.supersededAt}, ${input.supersededAt}
    )
    ON CONFLICT DO NOTHING
  `;
}

function replacementRequestHash(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  expectedResourceRevision: number;
  sourceRevisionPublicId: string;
  normalizedPath: string;
  title: string;
  metadata: Readonly<Record<string, unknown>>;
}): string {
  return createHash("sha256").update(JSON.stringify({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    expectedResourceRevision: input.expectedResourceRevision,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    normalizedPath: input.normalizedPath,
    title: input.title,
    metadata: input.metadata
  })).digest("hex");
}

function validateInput(input: {
  expectedResourceRevision: number;
  maximumAttempts: number;
  checksumSha256: string;
  byteCount: number;
  acceptedAt: string;
  expiresAt: string;
  title: string;
}): void {
  if (!Number.isSafeInteger(input.expectedResourceRevision)
    || input.expectedResourceRevision < 1
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1 || input.maximumAttempts > 100
    || !/^[0-9a-f]{64}$/u.test(input.checksumSha256)
    || !Number.isSafeInteger(input.byteCount) || input.byteCount < 0
    || !input.title
    || !Number.isFinite(Date.parse(input.acceptedAt))
    || Date.parse(input.expiresAt) <= Date.parse(input.acceptedAt)) {
    throw replacementError("invalid_input");
  }
}

function documentState(value: string): DocumentReplacementAcceptance["state"] {
  if ([
    "waiting", "processing", "available", "error",
    "deleting", "cancelled", "superseded"
  ].includes(value)) return value as DocumentReplacementAcceptance["state"];
  throw replacementError("replay_state_invalid");
}


function replacementError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document replacement error: ${code}`), { code });
}
