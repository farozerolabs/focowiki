import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextMutationAcceptance,
  StorageVnextMutationRepository,
  StorageVnextMutationTerminalRepository,
  StorageVnextNormalizedMutationRequest
} from "./ports.js";

export type StorageVnextMutationRepositoryErrorCode =
  | "invalid_input"
  | "resource_missing"
  | "revision_conflict"
  | "destination_unchanged"
  | "content_unchanged"
  | "path_conflict"
  | "idempotency_conflict"
  | "upload_conflict"
  | "deletion_conflict"
  | "maintenance_conflict"
  | "mutation_conflict"
  | "release_candidate_present"
  | "scope_conflict"
  | "object_unverified"
  | "database_error";

export class StorageVnextMutationRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextMutationRepositoryErrorCode) {
    super(`Storage vNext mutation repository error: ${code}`);
    this.name = "StorageVnextMutationRepositoryError";
  }
}

type ExistingRequestRow = {
  request_hash: string;
  operation_public_id: string;
};

type KnowledgeBaseRow = {
  public_id: string;
  name: string;
  description: string | null;
  revision: number | string;
  deleted_at: Date | null;
};

type SourceFileRow = {
  public_id: string;
  directory_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  metadata: Record<string, boolean | number | string | null>;
  revision: number | string;
  deleted_at: Date | null;
  current_revision_public_id: string | null;
  current_checksum_sha256: string | null;
};

type CurrentRevisionRow = {
  source_revision_public_id: string;
  checksum_sha256: string;
};

type DirectoryRow = {
  public_id: string;
  parent_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  revision: number | string;
  deleted_at: Date | null;
};

type LiveConflictRow = { work_kind: string };

export function createPostgresStorageVnextMutationRepository(
  sql: DatabaseClient
): StorageVnextMutationRepository & StorageVnextMutationTerminalRepository {
  return {
    async acceptMutation(input) {
      validateAcceptanceInput(input);
      return sql.begin(async (transaction) => {
        await lockKnowledgeBase(transaction, input.knowledgeBaseId);
        const replay = await readReplay(transaction, input);
        if (replay) return replay;
        const current = await lockCurrentTarget(transaction, input);
        assertCurrentRevision(current.revision, input.expectedResourceRevision);
        await assertNoLiveConflict(transaction, input);
        const checkpoint = await createCandidateCheckpoint(
          transaction,
          input,
          current
        );
        try {
          await insertAcceptedMutation(transaction, input, checkpoint);
        } catch (error) {
          throw mapDatabaseError(error);
        }
        return {
          outcome: "queued" as const,
          operationPublicId: input.operationPublicId,
          state: "queued" as const
        };
      });
    },

    async terminateMutation(input) {
      validateTerminalInput(input);
      return sql.begin(async (transaction) => {
        const existing = await transaction<Array<{
          terminal_state: string;
          result_code: string;
        }>>`
          SELECT terminal_state, result_code
          FROM focowiki.operation_results
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.operationPublicId}
          FOR UPDATE
        `;
        if (existing[0]) {
          return existing[0].terminal_state === input.outcome
            && existing[0].result_code === input.resultCode;
        }
        const candidates = await transaction<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.release_candidates
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND operation_public_id = ${input.operationPublicId}
            AND state IN ('building', 'validating', 'ready')
          FOR UPDATE
        `;
        if (candidates[0]) throw repositoryError("release_candidate_present");
        const work = await transaction<Array<{
          checkpoint: { candidateRevisionPublicId?: string };
        }>>`
          SELECT work.checkpoint
          FROM focowiki.operation_work_items work
          JOIN focowiki.operations operation
            ON operation.knowledge_base_id = work.knowledge_base_id
           AND operation.public_id = work.operation_public_id
          WHERE work.knowledge_base_id = ${input.knowledgeBaseId}
            AND work.operation_public_id = ${input.operationPublicId}
            AND work.work_kind = 'mutation'
            AND work.state IN ('queued', 'running', 'retry')
          FOR UPDATE OF work, operation
        `;
        if (!work[0]) return false;
        const candidateRevisionPublicId = work[0].checkpoint.candidateRevisionPublicId;
        const releasedObjects = candidateRevisionPublicId
          ? await transaction<Array<{ object_id: string }>>`
              DELETE FROM focowiki.source_revisions
              WHERE knowledge_base_id = ${input.knowledgeBaseId}
                AND public_id = ${candidateRevisionPublicId}
                AND revision_role = 'candidate'
              RETURNING object_id
            `
          : [];
        await transaction`
          DELETE FROM focowiki.mutation_path_reservations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND operation_public_id = ${input.operationPublicId}
        `;
        await transaction`
          DELETE FROM focowiki.operation_work_items
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND operation_public_id = ${input.operationPublicId}
            AND work_kind = 'mutation'
        `;
        const operations = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.operations
          SET state = ${input.outcome}, completed_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.operationPublicId}
          RETURNING public_id
        `;
        if (operations.length !== 1) throw repositoryError("scope_conflict");
        await transaction`
          INSERT INTO focowiki.operation_results (
            public_id, knowledge_base_id, operation_kind, terminal_state,
            result_code, safe_message, result_summary, correlation_public_id,
            completed_at, expires_at
          ) VALUES (
            ${input.operationPublicId}, ${input.knowledgeBaseId}, 'mutation',
            ${input.outcome}, ${input.resultCode}, NULL,
            ${transaction.json({
              successorOperationPublicId: input.successorOperationPublicId
            })},
            ${input.successorOperationPublicId}, ${input.completedAt},
            ${input.resultExpiresAt}
          )
        `;
        await markZeroOwnerObjects(
          transaction,
          releasedObjects.map((row) => row.object_id),
          input.completedAt
        );
        return true;
      });
    }
  };
}

async function lockKnowledgeBase(
  transaction: TransactionSql,
  knowledgeBaseId: string
): Promise<void> {
  const rows = await transaction<KnowledgeBaseRow[]>`
    SELECT public_id, name, description, revision, deleted_at
    FROM focowiki.knowledge_bases
    WHERE public_id = ${knowledgeBaseId}
    FOR UPDATE
  `;
  if (!rows[0] || rows[0].deleted_at) throw repositoryError("resource_missing");
}

async function readReplay(
  transaction: TransactionSql,
  input: StorageVnextNormalizedMutationRequest
): Promise<StorageVnextMutationAcceptance | null> {
  const rows = await transaction<ExistingRequestRow[]>`
    SELECT request_hash, operation_public_id
    FROM focowiki.operation_idempotency
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND idempotency_key = ${input.idempotencyKey}
    FOR UPDATE
  `;
  if (!rows[0]) return null;
  if (rows[0].request_hash !== input.requestHash) {
    throw repositoryError("idempotency_conflict");
  }
  return {
    outcome: "replayed",
    operationPublicId: rows[0].operation_public_id,
    state: "queued"
  };
}

async function lockCurrentTarget(
  transaction: TransactionSql,
  input: StorageVnextNormalizedMutationRequest
): Promise<KnowledgeBaseRow | SourceFileRow | DirectoryRow> {
  if (input.targetKind === "knowledge_base") {
    const rows = await transaction<KnowledgeBaseRow[]>`
      SELECT public_id, name, description, revision, deleted_at
      FROM focowiki.knowledge_bases
      WHERE public_id = ${input.knowledgeBaseId}
        AND public_id = ${input.targetPublicId}
      FOR UPDATE
    `;
    if (!rows[0] || rows[0].deleted_at) throw repositoryError("resource_missing");
    return rows[0];
  }
  if (input.targetKind === "source_directory") {
    const rows = await transaction<DirectoryRow[]>`
      SELECT public_id, parent_public_id, logical_path, normalized_path,
             title, revision, deleted_at
      FROM focowiki.source_directories
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${input.targetPublicId}
      FOR UPDATE
    `;
    if (!rows[0] || rows[0].deleted_at) throw repositoryError("resource_missing");
    return rows[0];
  }
  const rows = await transaction<Array<Omit<
    SourceFileRow,
    "current_revision_public_id" | "current_checksum_sha256"
  >>>`
    SELECT source.public_id, source.directory_public_id, source.logical_path,
           source.normalized_path, source.title, source.metadata,
           source.revision, source.deleted_at
    FROM focowiki.source_files source
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.public_id = ${input.targetPublicId}
    FOR UPDATE OF source
  `;
  if (!rows[0] || rows[0].deleted_at) throw repositoryError("resource_missing");
  const currentRows = await transaction<CurrentRevisionRow[]>`
    SELECT current.source_revision_public_id, revision.checksum_sha256
    FROM focowiki.source_file_current_revisions current
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = current.knowledge_base_id
     AND revision.source_file_public_id = current.source_file_public_id
     AND revision.public_id = current.source_revision_public_id
    WHERE current.knowledge_base_id = ${input.knowledgeBaseId}
      AND current.source_file_public_id = ${input.targetPublicId}
    FOR UPDATE OF current, revision
  `;
  return {
    ...rows[0],
    current_revision_public_id: currentRows[0]?.source_revision_public_id ?? null,
    current_checksum_sha256: currentRows[0]?.checksum_sha256 ?? null
  };
}

function assertCurrentRevision(
  currentRevision: number | string,
  expectedRevision: number
): void {
  if (Number(currentRevision) !== expectedRevision) {
    throw repositoryError("revision_conflict");
  }
}

async function assertNoLiveConflict(
  transaction: TransactionSql,
  input: StorageVnextNormalizedMutationRequest
): Promise<void> {
  const rows = await transaction<LiveConflictRow[]>`
    SELECT work.work_kind
    FROM focowiki.operation_work_items work
    JOIN focowiki.operations operation
      ON operation.knowledge_base_id = work.knowledge_base_id
     AND operation.public_id = work.operation_public_id
    WHERE work.knowledge_base_id = ${input.knowledgeBaseId}
      AND work.operation_public_id <> ${input.operationPublicId}
      AND work.state IN ('queued', 'running', 'retry')
      AND (
        work.work_kind IN ('upload', 'maintenance')
        OR (
          work.work_kind IN ('mutation', 'deletion')
          AND (
            operation.target_kind = 'knowledge_base'
            OR operation.target_public_id = ${input.targetPublicId}
          )
        )
      )
    ORDER BY CASE work.work_kind
      WHEN 'deletion' THEN 1
      WHEN 'maintenance' THEN 2
      WHEN 'upload' THEN 3
      ELSE 4
    END
    LIMIT 1
    FOR UPDATE OF work, operation
  `;
  const kind = rows[0]?.work_kind;
  if (kind === "upload") throw repositoryError("upload_conflict");
  if (kind === "deletion") throw repositoryError("deletion_conflict");
  if (kind === "maintenance") throw repositoryError("maintenance_conflict");
  if (kind === "mutation") throw repositoryError("mutation_conflict");
}

async function createCandidateCheckpoint(
  transaction: TransactionSql,
  input: StorageVnextNormalizedMutationRequest,
  current: KnowledgeBaseRow | SourceFileRow | DirectoryRow
): Promise<Record<string, unknown>> {
  if (input.normalizedCandidatePath) {
    await assertNoReservedDestination(transaction, input);
  }
  const base = {
    version: 1,
    kind: input.kind,
    targetKind: input.targetKind,
    targetPublicId: input.targetPublicId,
    expectedResourceRevision: input.expectedResourceRevision,
    candidateLogicalPath: input.candidateLogicalPath ?? null,
    normalizedCandidatePath: input.normalizedCandidatePath ?? null
  };
  if (input.kind === "knowledge_base_metadata") {
    const knowledgeBase = current as KnowledgeBaseRow;
    const candidateName = input.name ?? knowledgeBase.name;
    const candidateDescription = input.description === undefined
      ? knowledgeBase.description
      : input.description;
    if (candidateName === knowledgeBase.name
      && candidateDescription === knowledgeBase.description) {
      throw repositoryError("destination_unchanged");
    }
    return {
      ...base,
      currentName: knowledgeBase.name,
      currentDescription: knowledgeBase.description,
      candidateName,
      candidateDescription
    };
  }
  if (input.kind === "source_file_metadata") {
    const source = current as SourceFileRow;
    const candidateTitle = input.title ?? source.title;
    if (candidateTitle === source.title
      && sameJson(input.metadata, source.metadata)) {
      throw repositoryError("destination_unchanged");
    }
    return {
      ...base,
      currentTitle: source.title,
      currentMetadata: source.metadata,
      candidateTitle,
      candidateMetadata: input.metadata,
      currentLogicalPath: source.logical_path
    };
  }
  if (input.kind === "source_directory_move") {
    const directory = current as DirectoryRow;
    assertChangedPath(directory.normalized_path, input.normalizedCandidatePath);
    if (input.normalizedCandidatePath!.startsWith(`${directory.normalized_path}/`)) {
      throw repositoryError("scope_conflict");
    }
    const terminalFailureCode = missingDirectoryParent(input)
      ? "RESOURCE_PATH_CONFLICT"
      : null;
    if (!terminalFailureCode) {
      await assertDirectoryDestination(transaction, input, directory.public_id);
    }
    return {
      ...base,
      currentParentPublicId: directory.parent_public_id,
      currentLogicalPath: directory.logical_path,
      currentNormalizedPath: directory.normalized_path,
      currentTitle: directory.title,
      candidateParentPublicId: input.destinationParentPublicId,
      candidateTitle: input.candidateLogicalPath!.split("/").at(-1)!,
      ...(terminalFailureCode ? { terminalFailureCode } : {})
    };
  }
  const source = current as SourceFileRow;
  if (input.kind === "source_file_move") {
    assertChangedPath(source.normalized_path, input.normalizedCandidatePath);
    const terminalFailureCode = missingFileParent(input)
      ? "RESOURCE_PATH_CONFLICT"
      : null;
    if (!terminalFailureCode) {
      await assertFileDestination(transaction, input, source.public_id);
    }
    return {
      ...base,
      currentDirectoryPublicId: source.directory_public_id,
      currentLogicalPath: source.logical_path,
      currentNormalizedPath: source.normalized_path,
      candidateDirectoryPublicId: input.destinationDirectoryPublicId,
      ...(terminalFailureCode ? { terminalFailureCode } : {})
    };
  }
  if (source.current_checksum_sha256 === input.checksumSha256) {
    throw repositoryError("content_unchanged");
  }
  await assertVerifiedObject(transaction, input);
  const terminalFailureCode = input.normalizedCandidatePath
    && missingFileParent(input)
    ? "RESOURCE_PATH_CONFLICT"
    : null;
  if (input.normalizedCandidatePath) {
    assertChangedPath(source.normalized_path, input.normalizedCandidatePath);
    if (!terminalFailureCode) {
      await assertFileDestination(transaction, input, source.public_id);
    }
  }
  return {
    ...base,
    currentTitle: source.title,
    currentMetadata: source.metadata,
    currentDirectoryPublicId: source.directory_public_id,
    currentLogicalPath: source.logical_path,
    currentNormalizedPath: source.normalized_path,
    currentRevisionPublicId: source.current_revision_public_id,
    candidateDirectoryPublicId: input.destinationDirectoryPublicId
      ?? source.directory_public_id,
    candidateRevisionPublicId: input.candidateRevisionPublicId,
    candidateTitle: input.candidateTitle,
    candidateMetadata: input.candidateMetadata,
    objectId: input.objectId,
    checksumSha256: input.checksumSha256,
    byteCount: input.byteCount,
    contentType: input.contentType,
    ...(terminalFailureCode ? { terminalFailureCode } : {})
  };
}

function missingFileParent(
  input: Extract<StorageVnextNormalizedMutationRequest, {
    kind: "source_file_move" | "source_replace";
  }>
): boolean {
  return !input.destinationDirectoryPublicId
    && Boolean(input.candidateLogicalPath?.split("/").slice(0, -1).join("/"));
}

function missingDirectoryParent(
  input: Extract<StorageVnextNormalizedMutationRequest, {
    kind: "source_directory_move";
  }>
): boolean {
  return !input.destinationParentPublicId
    && Boolean(input.candidateLogicalPath?.split("/").slice(0, -1).join("/"));
}

function assertChangedPath(
  currentNormalizedPath: string,
  candidateNormalizedPath: string | undefined
): void {
  if (!candidateNormalizedPath) throw repositoryError("invalid_input");
  if (candidateNormalizedPath === currentNormalizedPath) {
    throw repositoryError("destination_unchanged");
  }
}

async function assertFileDestination(
  transaction: TransactionSql,
  input: Extract<StorageVnextNormalizedMutationRequest, {
    kind: "source_file_move" | "source_replace";
  }>,
  sourceFilePublicId: string
): Promise<void> {
  const existing = await transaction<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.source_files
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND normalized_path = ${input.normalizedCandidatePath!}
      AND public_id <> ${sourceFilePublicId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing[0]) throw repositoryError("path_conflict");
  const directoryId = input.destinationDirectoryPublicId ?? null;
  const directoryPath = input.candidateLogicalPath!.split("/").slice(0, -1).join("/");
  if (!directoryId && directoryPath) throw repositoryError("scope_conflict");
  if (directoryId) {
    const directories = await transaction<Array<{
      logical_path: string;
      deleted_at: Date | null;
    }>>`
      SELECT logical_path, deleted_at FROM focowiki.source_directories
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${directoryId}
      FOR UPDATE
    `;
    if (!directories[0] || directories[0].deleted_at
      || directories[0].logical_path !== directoryPath) {
      throw repositoryError("scope_conflict");
    }
  }
}

async function assertDirectoryDestination(
  transaction: TransactionSql,
  input: Extract<StorageVnextNormalizedMutationRequest, {
    kind: "source_directory_move";
  }>,
  sourceDirectoryPublicId: string
): Promise<void> {
  const existing = await transaction<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND normalized_path = ${input.normalizedCandidatePath!}
      AND public_id <> ${sourceDirectoryPublicId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing[0]) throw repositoryError("path_conflict");
  const directory = await transaction<Array<{ normalized_path: string }>>`
    SELECT normalized_path
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${sourceDirectoryPublicId}
  `;
  const currentPrefix = directory[0]?.normalized_path;
  if (!currentPrefix) throw repositoryError("resource_missing");
  const directoryCollisions = await transaction<Array<{ public_id: string }>>`
    SELECT destination.public_id
    FROM focowiki.source_directories moving
    JOIN focowiki.source_directories destination
      ON destination.knowledge_base_id = moving.knowledge_base_id
     AND destination.normalized_path = ${input.normalizedCandidatePath!}
       || substring(moving.normalized_path FROM ${currentPrefix.length + 1})
     AND destination.normalized_path NOT LIKE
       ${`${escapeLike(currentPrefix)}/%`} ESCAPE '\\'
    WHERE moving.knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        moving.public_id = ${sourceDirectoryPublicId}
        OR moving.normalized_path LIKE ${`${escapeLike(currentPrefix)}/%`} ESCAPE '\\'
      )
      AND moving.deleted_at IS NULL
      AND destination.deleted_at IS NULL
    LIMIT 1
  `;
  if (directoryCollisions[0]) throw repositoryError("path_conflict");
  const fileCollisions = await transaction<Array<{ public_id: string }>>`
    SELECT destination.public_id
    FROM focowiki.source_files moving
    JOIN focowiki.source_files destination
      ON destination.knowledge_base_id = moving.knowledge_base_id
     AND destination.normalized_path = ${input.normalizedCandidatePath!}
       || substring(moving.normalized_path FROM ${currentPrefix.length + 1})
     AND destination.normalized_path NOT LIKE
       ${`${escapeLike(currentPrefix)}/%`} ESCAPE '\\'
    WHERE moving.knowledge_base_id = ${input.knowledgeBaseId}
      AND moving.normalized_path LIKE ${`${escapeLike(currentPrefix)}/%`} ESCAPE '\\'
      AND moving.deleted_at IS NULL
      AND destination.deleted_at IS NULL
    LIMIT 1
  `;
  if (fileCollisions[0]) throw repositoryError("path_conflict");
  const parentId = input.destinationParentPublicId ?? null;
  const parentPath = input.candidateLogicalPath!.split("/").slice(0, -1).join("/");
  if (!parentId && parentPath) throw repositoryError("scope_conflict");
  if (parentId) {
    const parents = await transaction<Array<{
      logical_path: string;
      deleted_at: Date | null;
    }>>`
      SELECT logical_path, deleted_at FROM focowiki.source_directories
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${parentId}
      FOR UPDATE
    `;
    if (!parents[0] || parents[0].deleted_at
      || parents[0].logical_path !== parentPath) {
      throw repositoryError("scope_conflict");
    }
  }
}

async function assertNoReservedDestination(
  transaction: TransactionSql,
  input: StorageVnextNormalizedMutationRequest
): Promise<void> {
  const candidatePath = input.normalizedCandidatePath!;
  const rows = await transaction<Array<{
    operation_public_id: string;
    target_kind: string;
  }>>`
    SELECT operation_public_id, target_kind
    FROM focowiki.mutation_path_reservations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_public_id <> ${input.operationPublicId}
      AND (
        normalized_path = ${candidatePath}
        OR (
          target_kind = 'source_directory'
          AND ${candidatePath} LIKE normalized_path || '/%'
        )
        OR (
          ${input.targetKind} = 'source_directory'
          AND normalized_path LIKE ${`${escapeLike(candidatePath)}/%`} ESCAPE '\\'
        )
      )
    LIMIT 1
    FOR UPDATE
  `;
  if (rows[0]) throw repositoryError("path_conflict");
}

async function assertVerifiedObject(
  transaction: TransactionSql,
  input: Extract<StorageVnextNormalizedMutationRequest, { kind: "source_replace" }>
): Promise<void> {
  const rows = await transaction<Array<{
    checksum_sha256: string;
    byte_count: number | string;
    content_type: string;
    state: string;
  }>>`
    SELECT checksum_sha256, byte_count, content_type, state
    FROM focowiki.object_registrations
    WHERE object_id = ${input.objectId}
    FOR UPDATE
  `;
  const object = rows[0];
  if (!object
    || object.state !== "verified"
    || object.checksum_sha256 !== input.checksumSha256
    || Number(object.byte_count) !== input.byteCount
    || object.content_type !== input.contentType) {
    throw repositoryError("object_unverified");
  }
}

async function insertAcceptedMutation(
  transaction: TransactionSql,
  input: StorageVnextNormalizedMutationRequest,
  checkpoint: Record<string, unknown>
): Promise<void> {
  await transaction`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state,
      expected_resource_revision, target_kind, target_public_id,
      candidate_relative_path, created_at, updated_at
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId}, ${input.kind}, 'accepted',
      ${input.expectedResourceRevision}, ${input.targetKind}, ${input.targetPublicId},
      ${input.candidateLogicalPath ?? null}, ${input.createdAt}, ${input.createdAt}
    )
  `;
  await transaction`
    INSERT INTO focowiki.operation_idempotency (
      public_id, knowledge_base_id, idempotency_key, request_hash,
      operation_public_id, expires_at, created_at
    ) VALUES (
      ${mutationIdentity("idempotency", input.knowledgeBaseId, input.idempotencyKey)},
      ${input.knowledgeBaseId}, ${input.idempotencyKey}, ${input.requestHash},
      ${input.operationPublicId}, ${input.expiresAt}, ${input.createdAt}
    )
  `;
  await transaction`
    INSERT INTO focowiki.operation_work_items (
      operation_public_id, knowledge_base_id, work_kind, state,
      operation_revision, settings_revision_public_id, attempt_count,
      lease_owner, lease_expires_at, next_attempt_at, checkpoint, updated_at
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId}, 'mutation', 'queued',
      1, ${input.settingsRevisionPublicId}, 0,
      NULL, NULL, ${input.createdAt}, ${transaction.json(checkpoint as never)}, ${input.createdAt}
    )
  `;
  if (input.normalizedCandidatePath) {
    await transaction`
      INSERT INTO focowiki.mutation_path_reservations (
        knowledge_base_id, normalized_path, operation_public_id,
        target_kind, target_public_id, expires_at, created_at
      ) VALUES (
        ${input.knowledgeBaseId}, ${input.normalizedCandidatePath},
        ${input.operationPublicId}, ${input.targetKind}, ${input.targetPublicId},
        ${input.expiresAt}, ${input.createdAt}
      )
    `;
  }
  if (input.kind === "source_replace") {
    await transaction`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, revision_role,
        expires_at, created_at
      ) VALUES (
        ${input.candidateRevisionPublicId}, ${input.knowledgeBaseId},
        ${input.targetPublicId}, ${input.objectId}, ${input.checksumSha256},
        ${input.byteCount}, ${input.contentType}, 'candidate',
        ${input.expiresAt}, ${input.createdAt}
      )
    `;
    await transaction`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind,
        source_revision_public_id
      ) VALUES (
        ${mutationIdentity("owner", input.knowledgeBaseId, input.candidateRevisionPublicId)},
        ${input.knowledgeBaseId}, ${input.objectId}, 'source_revision',
        ${input.candidateRevisionPublicId}
      )
    `;
  }
}

function validateAcceptanceInput(input: StorageVnextNormalizedMutationRequest): void {
  if (!/^[0-9a-f]{64}$/u.test(input.requestHash)) {
    throw repositoryError("invalid_input");
  }
}

function validateTerminalInput(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  resultCode: string;
  completedAt: string;
  resultExpiresAt: string;
}): void {
  const completed = Date.parse(input.completedAt);
  const expires = Date.parse(input.resultExpiresAt);
  if (!input.knowledgeBaseId || !input.operationPublicId
    || !input.resultCode || input.resultCode.length > 128
    || !Number.isFinite(completed) || !Number.isFinite(expires)
    || expires <= completed) {
    throw repositoryError("invalid_input");
  }
}

async function markZeroOwnerObjects(
  transaction: TransactionSql,
  objectIds: readonly string[],
  zeroOwnerSince: string
): Promise<void> {
  if (objectIds.length === 0) return;
  await transaction`
    UPDATE focowiki.object_registrations object
    SET zero_owner_since = COALESCE(object.zero_owner_since, ${zeroOwnerSince})
    WHERE object.object_id = ANY(${[...new Set(objectIds)]})
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = object.object_id
      )
  `;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function mutationIdentity(kind: string, ...values: string[]): string {
  return `mutation-${kind}-${createHash("sha256")
    .update(values.join("\0"))
    .digest("hex")}`;
}

function mapDatabaseError(error: unknown): Error {
  if (isDatabaseError(error, "23505")) {
    if (error.constraint_name === "operation_idempotency_key") {
      return repositoryError("idempotency_conflict");
    }
    if (error.constraint_name === "mutation_path_reservations_pkey"
      || error.constraint_name === "source_revisions_content_key") {
      return repositoryError("path_conflict");
    }
  }
  return error instanceof Error ? error : repositoryError("database_error");
}

function isDatabaseError(
  error: unknown,
  code: string
): error is Error & { code: string; constraint_name?: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

function repositoryError(
  code: StorageVnextMutationRepositoryErrorCode
): StorageVnextMutationRepositoryError {
  return new StorageVnextMutationRepositoryError(code);
}
