import type { TransactionSql } from "postgres";
import { createDocumentJobPublicId } from
  "../../document-indexing/domain/document-job-identity.js";
import { DOCUMENT_WORK_KINDS } from
  "../../document-indexing/domain/document-work-graph.js";
import {
  documentFixedWorkInputFingerprint,
  documentFixedWorkPublicId
} from "../../document-indexing/domain/document-fixed-work-identity.js";
import { documentWorkResourceLane } from
  "../../document-indexing/application/document-work-resource-map.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "../../document-indexing/infrastructure/postgres-document-webhook-event.js";
import { createDocumentSourceRevisionPublicId } from
  "../../document-indexing/domain/source-revision-identity.js";
import type { StorageVnextUploadFinalization } from "./ports.js";
import { createStorageVnextUploadIdentity } from "./identity.js";
import { UploadSessionError } from "../../domain/upload-session.js";
import type { SemanticMaintenanceTarget } from
  "../../semantic/domain/contracts.js";
import { ensurePostgresSemanticContractBootstrap } from
  "../../semantic/infrastructure/postgres-contract-bootstrap.js";

type SessionRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
  state: "draft" | "uploading" | "finalizing";
  expected_entry_count: number | string;
  expected_byte_count: number | string;
  received_entry_count: number | string;
  received_byte_count: number | string;
  settings_revision_public_id: string;
  generation_model_configuration_public_id: string | null;
  generation_model_configuration_revision: number | string | null;
  embedding_configuration_revision_public_id: string | null;
  semantic_generation_public_id: string | null;
  semantic_contract_version: string;
  maximum_attempts: number | string;
};

type EntryRow = {
  entry_public_id: string;
  source_file_public_id: string;
  logical_path: string;
  normalized_path: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  object_id: string | null;
  state: "pending" | "uploaded" | "verified";
  existing_resource_revision: number | string | null;
};

type DirectoryRow = {
  public_id: string;
  normalized_path: string;
};

type EntrySummaryRow = {
  entry_count: number | string;
  byte_count: number | string;
  invalid_entry_count: number | string;
  upload_required_count: number | string;
  upload_required_byte_count: number | string;
};

const FINALIZATION_PAGE_SIZE = 500;

export async function finalizePostgresStorageVnextUploadSession(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    sessionPublicId: string;
    completedAt: string;
    sourceWorkRetentionMilliseconds: number;
    semanticTarget?: SemanticMaintenanceTarget | null;
  }
): Promise<StorageVnextUploadFinalization> {
  if (input.semanticTarget) {
    await ensurePostgresSemanticContractBootstrap(transaction, {
      knowledgeBaseId: input.knowledgeBaseId,
      target: input.semanticTarget,
      createdAt: input.completedAt
    });
  }
  const sessions = await transaction<SessionRow[]>`
    SELECT session.public_id, session.knowledge_base_id,
           session.operation_public_id, session.state,
           session.expected_entry_count, session.expected_byte_count,
           session.received_entry_count, session.received_byte_count,
           work.settings_revision_public_id,
           semantic.generation_model_configuration_public_id,
           semantic.generation_model_configuration_revision,
           semantic.embedding_configuration_revision_public_id,
           semantic.semantic_generation_public_id,
           coalesce(
             semantic.contract_fingerprint_sha256,
             'document-semantic-disabled-v1'
           ) AS semantic_contract_version,
           settings.settings_values #>>
             '{sections,worker,jobMaxAttempts}' AS maximum_attempts
    FROM focowiki.upload_sessions session
    JOIN focowiki.operation_work_items work
      ON work.operation_public_id = session.operation_public_id
     AND work.knowledge_base_id = session.knowledge_base_id
     AND work.work_kind = 'upload'
    JOIN focowiki.runtime_setting_revisions settings
      ON settings.public_id = work.settings_revision_public_id
    LEFT JOIN LATERAL (
      SELECT generation.public_id AS semantic_generation_public_id,
             generation.generation_model_configuration_public_id,
             generation.generation_model_configuration_revision,
             generation.contract_fingerprint_sha256,
             contract.embedding_configuration_revision_public_id
      FROM focowiki.semantic_generations generation
      LEFT JOIN focowiki.semantic_projection_contracts contract
        ON contract.knowledge_base_id = generation.knowledge_base_id
       AND contract.semantic_generation_public_id = generation.public_id
      WHERE generation.knowledge_base_id = session.knowledge_base_id
        AND generation.generation_role = 'active'
        AND generation.state = 'active'
        AND generation.deleted_at IS NULL
      LIMIT 1
    ) semantic ON true
    WHERE session.public_id = ${input.sessionPublicId}
      AND session.knowledge_base_id = ${input.knowledgeBaseId}
    FOR UPDATE OF session
  `;
  const session = sessions[0];
  if (!session) throw uploadRepositoryError("session_missing");
  assertProcessingContract(session);
  if (session.state === "finalizing") {
    return finalizationResult(session, Number(session.received_entry_count), "replayed");
  }
  const summary = await summarizeEntries(transaction, session);
  assertComplete(session, summary);
  await assertAcceptableScope(transaction, session);
  await finalizeEntryPages(
    transaction,
    session,
    input.completedAt,
    input.sourceWorkRetentionMilliseconds
  );
  await transaction`
    DELETE FROM focowiki.object_owners
    WHERE knowledge_base_id = ${session.knowledge_base_id}
      AND owner_kind = 'live_reservation'
      AND operation_public_id = ${session.operation_public_id}
  `;
  await transaction`
    UPDATE focowiki.upload_sessions
    SET state = 'finalizing', updated_at = ${input.completedAt}
    WHERE public_id = ${session.public_id}
  `;
  return finalizationResult(session, summary.uploadRequiredCount, "accepted");
}

async function summarizeEntries(
  transaction: TransactionSql,
  session: SessionRow
): Promise<{
  entryCount: number;
  byteCount: number;
  invalidEntryCount: number;
  uploadRequiredCount: number;
  uploadRequiredByteCount: number;
}> {
  const rows = await transaction<EntrySummaryRow[]>`
    SELECT count(*) AS entry_count,
           coalesce(sum(entry.byte_count), 0) AS byte_count,
           count(*) FILTER (
             WHERE entry.state <> 'verified' OR entry.object_id IS NULL
           ) AS invalid_entry_count,
           count(*) FILTER (
             WHERE source.public_id IS NULL
           ) AS upload_required_count,
           coalesce(sum(entry.byte_count) FILTER (
             WHERE source.public_id IS NULL
           ), 0) AS upload_required_byte_count
    FROM focowiki.upload_entries entry
    LEFT JOIN focowiki.source_files source
      ON source.knowledge_base_id = entry.knowledge_base_id
     AND source.public_id = entry.source_file_public_id
     AND source.normalized_path = entry.normalized_path
     AND source.deleted_at IS NULL
    WHERE entry.upload_session_public_id = ${session.public_id}
      AND entry.knowledge_base_id = ${session.knowledge_base_id}
  `;
  const row = rows[0];
  if (!row) throw uploadRepositoryError("session_incomplete");
  return {
    entryCount: uploadCount(row.entry_count),
    byteCount: uploadCount(row.byte_count),
    invalidEntryCount: uploadCount(row.invalid_entry_count),
    uploadRequiredCount: uploadCount(row.upload_required_count),
    uploadRequiredByteCount: uploadCount(row.upload_required_byte_count)
  };
}

function assertComplete(
  session: SessionRow,
  summary: Awaited<ReturnType<typeof summarizeEntries>>
): void {
  if (
    session.state !== "uploading"
    || summary.invalidEntryCount > 0
    || summary.entryCount !== Number(session.expected_entry_count)
    || summary.uploadRequiredCount !== Number(session.received_entry_count)
    || summary.byteCount !== Number(session.expected_byte_count)
    || summary.uploadRequiredByteCount !== Number(session.received_byte_count)
  ) throw uploadRepositoryError("session_incomplete");
}

async function assertAcceptableScope(
  transaction: TransactionSql,
  session: SessionRow
): Promise<void> {
  const scope = await transaction<Array<{ accepted: boolean }>>`
    SELECT knowledge_base.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.upload_entries entry
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = entry.knowledge_base_id
         AND source.normalized_path = entry.normalized_path
         AND source.deleted_at IS NULL
        WHERE entry.upload_session_public_id = ${session.public_id}
          AND entry.knowledge_base_id = ${session.knowledge_base_id}
          AND source.public_id <> entry.source_file_public_id
      ) AS accepted
    FROM focowiki.knowledge_bases knowledge_base
    WHERE knowledge_base.public_id = ${session.knowledge_base_id}
  `;
  if (!scope[0]?.accepted) throw uploadRepositoryError("path_conflict");
}

async function finalizeEntryPages(
  transaction: TransactionSql,
  session: SessionRow,
  completedAt: string,
  retentionMilliseconds: number
): Promise<void> {
  let cursorPath: string | null = null;
  let cursorId: string | null = null;
  while (true) {
    const entries = await readEntryPage(
      transaction,
      session,
      cursorPath,
      cursorId
    );
    if (entries.length === 0) return;
    const uploadRequired = entries.filter((entry) =>
      entry.existing_resource_revision === null);
    const directories = await ensureDirectories(
      transaction,
      session.knowledge_base_id,
      uploadRequired
    );
    const accepted = uploadRequired.map((entry) =>
      acceptedEntry(
        session,
        entry,
        directories,
        completedAt
      ));
    await insertAcceptedEntries(
      transaction,
      accepted,
      new Date(Date.parse(completedAt) + retentionMilliseconds).toISOString()
    );
    const last = entries.at(-1)!;
    cursorPath = last.normalized_path;
    cursorId = last.entry_public_id;
  }
}

async function readEntryPage(
  transaction: TransactionSql,
  session: SessionRow,
  cursorPath: string | null,
  cursorId: string | null
): Promise<EntryRow[]> {
  return transaction<EntryRow[]>`
    SELECT entry.entry_public_id, entry.source_file_public_id,
           entry.logical_path, entry.normalized_path, entry.checksum_sha256,
           entry.byte_count, entry.content_type, entry.object_id, entry.state,
           source.revision AS existing_resource_revision
    FROM focowiki.upload_entries entry
    LEFT JOIN focowiki.source_files source
      ON source.knowledge_base_id = entry.knowledge_base_id
     AND source.public_id = entry.source_file_public_id
     AND source.normalized_path = entry.normalized_path
     AND source.deleted_at IS NULL
    WHERE entry.upload_session_public_id = ${session.public_id}
      AND entry.knowledge_base_id = ${session.knowledge_base_id}
      AND (
        ${cursorPath === null}
        OR (entry.normalized_path COLLATE "C", entry.entry_public_id COLLATE "C")
          > (${cursorPath ?? ""}, ${cursorId ?? ""})
      )
    ORDER BY entry.normalized_path COLLATE "C", entry.entry_public_id COLLATE "C"
    LIMIT ${FINALIZATION_PAGE_SIZE}
  `;
}

async function insertAcceptedEntries(
  transaction: TransactionSql,
  accepted: readonly ReturnType<typeof acceptedEntry>[],
  expiresAt: string
): Promise<void> {
  if (accepted.length === 0) return;
  await transaction`
    INSERT INTO focowiki.source_files ${transaction(
      accepted.map((item) => item.sourceFile),
      "public_id", "knowledge_base_id", "directory_public_id", "logical_path",
      "normalized_path", "title", "metadata", "revision", "created_at", "updated_at"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.source_revisions ${transaction(
      accepted.map((item) => item.sourceRevision),
      "public_id", "knowledge_base_id", "source_file_public_id", "object_id",
      "checksum_sha256", "byte_count", "content_type", "created_at"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.source_file_active_revisions ${transaction(
      accepted.map((item) => item.activeRevision),
      "knowledge_base_id", "source_file_public_id",
      "current_source_revision_public_id", "active_source_revision_public_id",
      "activation_sequence", "updated_at"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.source_revision_presentations ${transaction(
      accepted.map((item) => item.presentation),
      "knowledge_base_id", "source_file_public_id",
      "source_revision_public_id", "directory_public_id",
      "logical_path", "normalized_path", "title", "metadata", "created_at"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.document_processing_jobs ${transaction(
      accepted.map((item) => item.documentJob),
      "public_id", "knowledge_base_id", "operation_public_id",
      "source_file_public_id", "source_revision_public_id",
      "runtime_settings_revision_public_id",
      "generation_model_configuration_public_id",
      "generation_model_configuration_revision",
      "embedding_configuration_revision_public_id",
      "semantic_generation_public_id", "semantic_contract_version",
      "state", "attempt_count", "failure_count", "total_attempt_count",
      "manual_retry_count", "maximum_attempts", "next_attempt_at",
      "required_work_count", "completed_work_count", "active_work_kinds",
      "blocking_work_kind", "retrying_work_kind",
      "cancellation_requested_at", "safe_error_code", "safe_error_message",
      "retryable", "model_status", "model_name", "model_started_at",
      "model_ended_at", "model_warning_count", "model_error_code",
      "accepted_at", "started_at", "terminal_at",
      "service_time_milliseconds", "revision", "created_at", "updated_at"
    )}
  `;
  for (const workPage of pages(
    accepted.flatMap((item) => item.artifactWork),
    2_000
  )) {
    await transaction`
      INSERT INTO focowiki.document_artifact_work ${transaction(
        workPage,
        "public_id", "knowledge_base_id", "document_job_public_id",
        "source_file_public_id", "source_revision_public_id", "work_kind",
        "resource_lane", "input_fingerprint_sha256", "state",
        "attempt_count", "maximum_attempts", "next_eligible_at",
        "wait_time_milliseconds", "service_time_milliseconds", "retryable",
        "created_at", "updated_at"
      )}
    `;
  }
  await transaction`
    INSERT INTO focowiki.object_owners ${transaction(
      accepted.map((item) => item.sourceOwner),
      "public_id", "knowledge_base_id", "object_id", "owner_kind",
      "source_revision_public_id"
    )}
  `;
  await transaction`
    UPDATE focowiki.object_registrations
    SET zero_owner_since = NULL
    WHERE object_id = ANY(${[...new Set(accepted.map((item) => item.sourceOwner.object_id))]})
  `;
  for (const item of accepted) {
    await enqueuePostgresDocumentWebhookEvent(transaction, {
      documentJobPublicId: item.documentJob.public_id,
      documentJobRevision: item.documentJob.revision,
      knowledgeBaseId: item.documentJob.knowledge_base_id,
      operationPublicId: item.documentJob.operation_public_id,
      sourceFilePublicId: item.documentJob.source_file_public_id,
      eventType: "document.waiting",
      state: "waiting",
      occurredAt: item.documentJob.accepted_at,
      expiresAt
    });
  }
}

function pages<T>(items: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

async function ensureDirectories(
  transaction: TransactionSql,
  knowledgeBaseId: string,
  entries: readonly EntryRow[]
): Promise<Map<string, string>> {
  const paths = directoryPaths(entries);
  if (paths.length === 0) return new Map();
  const existing = await transaction<DirectoryRow[]>`
    SELECT public_id, normalized_path
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND normalized_path = ANY(${paths.map((path) => path.normalizedPath)})
      AND deleted_at IS NULL
  `;
  const identities = new Map(existing.map((row) => [row.normalized_path, row.public_id]));
  const missing = paths.flatMap((path) => {
    if (identities.has(path.normalizedPath)) return [];
    const publicId = createStorageVnextUploadIdentity(
      "directory",
      knowledgeBaseId,
      path.normalizedPath
    );
    identities.set(path.normalizedPath, publicId);
    return [{
      public_id: publicId,
      knowledge_base_id: knowledgeBaseId,
      parent_public_id: path.parentNormalizedPath
        ? identities.get(path.parentNormalizedPath) ?? null
        : null,
      logical_path: path.logicalPath,
      normalized_path: path.normalizedPath,
      title: path.title,
      revision: 1
    }];
  });
  if (missing.length > 0) {
    for (let offset = 0; offset < missing.length; offset += FINALIZATION_PAGE_SIZE) {
      await transaction`
        INSERT INTO focowiki.source_directories ${transaction(
          missing.slice(offset, offset + FINALIZATION_PAGE_SIZE),
          "public_id", "knowledge_base_id", "parent_public_id", "logical_path",
          "normalized_path", "title", "revision"
        )}
        ON CONFLICT (knowledge_base_id, normalized_path) DO NOTHING
      `;
    }
  }
  const current = await transaction<DirectoryRow[]>`
    SELECT public_id, normalized_path
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND normalized_path = ANY(${paths.map((path) => path.normalizedPath)})
      AND deleted_at IS NULL
  `;
  if (current.length !== paths.length) throw uploadRepositoryError("path_conflict");
  return new Map(current.map((row) => [row.normalized_path, row.public_id]));
}

function directoryPaths(entries: readonly EntryRow[]): Array<{
  logicalPath: string;
  normalizedPath: string;
  parentNormalizedPath: string | null;
  title: string;
}> {
  const paths = new Map<string, ReturnType<typeof directoryDescriptor>>();
  for (const entry of entries) {
    const logical = entry.logical_path.split("/").slice(0, -1);
    const normalized = entry.normalized_path.split("/").slice(0, -1);
    for (let depth = 1; depth <= logical.length; depth += 1) {
      const descriptor = directoryDescriptor(logical, normalized, depth);
      paths.set(descriptor.normalizedPath, descriptor);
    }
  }
  return [...paths.values()].sort((left, right) =>
    left.normalizedPath.split("/").length - right.normalizedPath.split("/").length
      || left.normalizedPath.localeCompare(right.normalizedPath));
}

function directoryDescriptor(logical: string[], normalized: string[], depth: number) {
  return {
    logicalPath: logical.slice(0, depth).join("/"),
    normalizedPath: normalized.slice(0, depth).join("/"),
    parentNormalizedPath: depth === 1 ? null : normalized.slice(0, depth - 1).join("/"),
    title: logical[depth - 1]!
  };
}

function acceptedEntry(
  session: SessionRow,
  entry: EntryRow,
  directories: ReadonlyMap<string, string>,
  completedAt: string
) {
  const revisionPublicId = createDocumentSourceRevisionPublicId({
    knowledgeBaseId: session.knowledge_base_id,
    sourceFilePublicId: entry.source_file_public_id,
    checksum: entry.checksum_sha256
  });
  const documentJobPublicId = createDocumentJobPublicId({
    knowledgeBaseId: session.knowledge_base_id,
    sourceRevisionPublicId: revisionPublicId
  });
  const directoryPath = entry.normalized_path.split("/").slice(0, -1).join("/");
  const fileName = entry.logical_path.split("/").at(-1)!;
  const title = fileName.replace(/\.md$/iu, "");
  const directoryPublicId = directoryPath ? directories.get(directoryPath) ?? null : null;
  return {
    sourceFile: {
      public_id: entry.source_file_public_id,
      knowledge_base_id: session.knowledge_base_id,
      directory_public_id: directoryPublicId,
      logical_path: entry.logical_path,
      normalized_path: entry.normalized_path,
      title,
      metadata: {},
      revision: 1,
      created_at: completedAt,
      updated_at: completedAt
    },
    sourceRevision: {
      public_id: revisionPublicId,
      knowledge_base_id: session.knowledge_base_id,
      source_file_public_id: entry.source_file_public_id,
      object_id: entry.object_id!,
      checksum_sha256: entry.checksum_sha256,
      byte_count: Number(entry.byte_count),
      content_type: entry.content_type,
      created_at: completedAt
    },
    activeRevision: {
      knowledge_base_id: session.knowledge_base_id,
      source_file_public_id: entry.source_file_public_id,
      current_source_revision_public_id: revisionPublicId,
      active_source_revision_public_id: null,
      activation_sequence: 0,
      updated_at: completedAt
    },
    presentation: {
      knowledge_base_id: session.knowledge_base_id,
      source_file_public_id: entry.source_file_public_id,
      source_revision_public_id: revisionPublicId,
      directory_public_id: directoryPublicId,
      logical_path: entry.logical_path,
      normalized_path: entry.normalized_path,
      title,
      metadata: {},
      created_at: completedAt
    },
    documentJob: {
      public_id: documentJobPublicId,
      knowledge_base_id: session.knowledge_base_id,
      operation_public_id: session.operation_public_id,
      source_file_public_id: entry.source_file_public_id,
      source_revision_public_id: revisionPublicId,
      runtime_settings_revision_public_id: session.settings_revision_public_id,
      generation_model_configuration_public_id:
        session.generation_model_configuration_public_id,
      generation_model_configuration_revision:
        nullableNumber(session.generation_model_configuration_revision),
      embedding_configuration_revision_public_id:
        session.embedding_configuration_revision_public_id,
      semantic_generation_public_id: session.semantic_generation_public_id,
      semantic_contract_version: session.semantic_contract_version,
      state: "waiting",
      attempt_count: 0,
      failure_count: 0,
      total_attempt_count: 0,
      manual_retry_count: 0,
      maximum_attempts: Number(session.maximum_attempts),
      next_attempt_at: null,
      required_work_count: DOCUMENT_WORK_KINDS.length,
      completed_work_count: 0,
      active_work_kinds: [],
      blocking_work_kind: "prepare",
      retrying_work_kind: null,
      cancellation_requested_at: null,
      safe_error_code: null,
      safe_error_message: null,
      retryable: false,
      model_status: null,
      model_name: null,
      model_started_at: null,
      model_ended_at: null,
      model_warning_count: null,
      model_error_code: null,
      accepted_at: completedAt,
      started_at: null,
      terminal_at: null,
      service_time_milliseconds: 0,
      revision: 0,
      created_at: completedAt,
      updated_at: completedAt
    },
    artifactWork: DOCUMENT_WORK_KINDS.map((workKind) => ({
      public_id: documentFixedWorkPublicId(documentJobPublicId, workKind),
      knowledge_base_id: session.knowledge_base_id,
      document_job_public_id: documentJobPublicId,
      source_file_public_id: entry.source_file_public_id,
      source_revision_public_id: revisionPublicId,
      work_kind: workKind,
      resource_lane: documentWorkResourceLane(workKind),
      input_fingerprint_sha256: documentFixedWorkInputFingerprint(workKind, {
        sourceChecksumSha256: entry.checksum_sha256,
        runtimeSettingsRevisionPublicId: session.settings_revision_public_id,
        generationModelConfigurationPublicId:
          session.generation_model_configuration_public_id,
        generationModelConfigurationRevision: nullableNumber(
          session.generation_model_configuration_revision
        ),
        embeddingConfigurationRevisionPublicId:
          session.embedding_configuration_revision_public_id,
        semanticContractVersion: session.semantic_contract_version
      }),
      state: "waiting",
      attempt_count: 0,
      maximum_attempts: Number(session.maximum_attempts),
      next_eligible_at: completedAt,
      wait_time_milliseconds: 0,
      service_time_milliseconds: 0,
      retryable: false,
      created_at: completedAt,
      updated_at: completedAt
    })),
    sourceOwner: {
      public_id: createStorageVnextUploadIdentity(
        "live-owner",
        "source-revision",
        revisionPublicId,
        entry.object_id!
      ),
      knowledge_base_id: session.knowledge_base_id,
      object_id: entry.object_id!,
      owner_kind: "source_revision",
      source_revision_public_id: revisionPublicId
    }
  };
}

function assertProcessingContract(session: SessionRow): void {
  const maximumAttempts = Number(session.maximum_attempts);
  const completeSemanticContract = Boolean(
    session.generation_model_configuration_public_id
    && session.generation_model_configuration_revision !== null
    && session.embedding_configuration_revision_public_id
    && session.semantic_generation_public_id
  );
  if (!completeSemanticContract) {
    throw new UploadSessionError("UPLOAD_PROCESSING_CONFIGURATION_REQUIRED");
  }
  if (!Number.isSafeInteger(maximumAttempts)
    || maximumAttempts < 1
    || maximumAttempts > 100) {
    throw uploadRepositoryError("processing_contract_invalid");
  }
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function finalizationResult(
  session: SessionRow,
  acceptedRevisionCount: number,
  outcome: "accepted" | "replayed"
): StorageVnextUploadFinalization {
  return {
    outcome,
    acceptedRevisionCount,
    sourceWorkCount: acceptedRevisionCount,
    downstreamProcessingState: "queued",
    session: {
      knowledgeBaseId: session.knowledge_base_id,
      operationPublicId: session.operation_public_id,
      sessionPublicId: session.public_id,
      temporaryObjectIds: []
    }
  };
}

function uploadCount(value: number | string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw uploadRepositoryError("session_incomplete");
  }
  return count;
}

function uploadRepositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext upload repository error: ${code}`), { code });
}
