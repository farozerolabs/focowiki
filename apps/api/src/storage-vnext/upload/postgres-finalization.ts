import type { TransactionSql } from "postgres";
import { createStorageVnextSourceRevisionPublicId } from "../catalog/source-revision-service.js";
import { createStorageVnextSourceWorkIdempotency } from
  "../source-processing/identity.js";
import type { StorageVnextUploadFinalization } from "./ports.js";
import { createStorageVnextUploadIdentity } from "./identity.js";

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
  }
): Promise<StorageVnextUploadFinalization> {
  const sessions = await transaction<SessionRow[]>`
    SELECT session.public_id, session.knowledge_base_id,
           session.operation_public_id, session.state,
           session.expected_entry_count, session.expected_byte_count,
           session.received_entry_count, session.received_byte_count,
           work.settings_revision_public_id
    FROM focowiki.upload_sessions session
    JOIN focowiki.operation_work_items work
      ON work.operation_public_id = session.operation_public_id
     AND work.knowledge_base_id = session.knowledge_base_id
    WHERE session.public_id = ${input.sessionPublicId}
      AND session.knowledge_base_id = ${input.knowledgeBaseId}
    FOR UPDATE OF session
  `;
  const session = sessions[0];
  if (!session) throw uploadRepositoryError("session_missing");
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
  sourceWorkRetentionMilliseconds: number
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
        completedAt,
        sourceWorkRetentionMilliseconds
      ));
    await insertAcceptedEntries(transaction, accepted);
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
  accepted: readonly ReturnType<typeof acceptedEntry>[]
): Promise<void> {
  if (accepted.length === 0) return;
  await transaction`
    INSERT INTO focowiki.source_files ${transaction(
      accepted.map((item) => item.sourceFile),
      "public_id", "knowledge_base_id", "directory_public_id", "logical_path",
      "normalized_path", "title", "metadata", "status", "revision"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.source_revisions ${transaction(
      accepted.map((item) => item.sourceRevision),
      "public_id", "knowledge_base_id", "source_file_public_id", "object_id",
      "checksum_sha256", "byte_count", "content_type", "revision_role",
      "expires_at", "created_at"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.source_file_current_revisions ${transaction(
      accepted.map((item) => item.currentRevision),
      "knowledge_base_id", "source_file_public_id", "source_revision_public_id", "revision"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.operations ${transaction(
      accepted.map((item) => item.operation),
      "public_id", "knowledge_base_id", "operation_kind", "state",
      "expected_resource_revision", "target_kind", "target_public_id"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.operation_work_items ${transaction(
      accepted.map((item) => item.work),
      "operation_public_id", "knowledge_base_id", "work_kind", "state",
      "operation_revision", "settings_revision_public_id", "attempt_count",
      "lease_owner", "lease_expires_at", "next_attempt_at", "safe_error_code",
      "checkpoint"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.operation_idempotency ${transaction(
      accepted.map((item) => item.idempotency),
      "public_id", "knowledge_base_id", "idempotency_key", "request_hash",
      "operation_public_id", "expires_at", "created_at"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.object_owners ${transaction(
      accepted.map((item) => item.sourceOwner),
      "public_id", "knowledge_base_id", "object_id", "owner_kind",
      "source_revision_public_id"
    )}
  `;
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
  completedAt: string,
  sourceWorkRetentionMilliseconds: number
) {
  const revisionPublicId = createStorageVnextSourceRevisionPublicId({
    knowledgeBaseId: session.knowledge_base_id,
    sourceFilePublicId: entry.source_file_public_id,
    checksum: entry.checksum_sha256
  });
  const operationPublicId = createStorageVnextUploadIdentity(
    "source-operation",
    session.knowledge_base_id,
    revisionPublicId
  );
  const idempotency = createStorageVnextSourceWorkIdempotency({
    knowledgeBaseId: session.knowledge_base_id,
    operationPublicId,
    sourceRevisionPublicId: revisionPublicId
  });
  const directoryPath = entry.normalized_path.split("/").slice(0, -1).join("/");
  const fileName = entry.logical_path.split("/").at(-1)!;
  return {
    sourceFile: {
      public_id: entry.source_file_public_id,
      knowledge_base_id: session.knowledge_base_id,
      directory_public_id: directoryPath ? directories.get(directoryPath) ?? null : null,
      logical_path: entry.logical_path,
      normalized_path: entry.normalized_path,
      title: fileName.replace(/\.md$/iu, ""),
      metadata: {},
      status: "pending",
      revision: 1
    },
    sourceRevision: {
      public_id: revisionPublicId,
      knowledge_base_id: session.knowledge_base_id,
      source_file_public_id: entry.source_file_public_id,
      object_id: entry.object_id!,
      checksum_sha256: entry.checksum_sha256,
      byte_count: Number(entry.byte_count),
      content_type: entry.content_type,
      revision_role: "current",
      expires_at: null,
      created_at: completedAt
    },
    currentRevision: {
      knowledge_base_id: session.knowledge_base_id,
      source_file_public_id: entry.source_file_public_id,
      source_revision_public_id: revisionPublicId,
      revision: 1
    },
    operation: {
      public_id: operationPublicId,
      knowledge_base_id: session.knowledge_base_id,
      operation_kind: "source_processing",
      state: "accepted",
      expected_resource_revision: 1,
      target_kind: "source_file",
      target_public_id: entry.source_file_public_id
    },
    work: {
      operation_public_id: operationPublicId,
      knowledge_base_id: session.knowledge_base_id,
      work_kind: "source",
      state: "queued",
      operation_revision: 1,
      settings_revision_public_id: session.settings_revision_public_id,
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: null,
      safe_error_code: null,
      checkpoint: { sourceRevisionPublicId: revisionPublicId }
    },
    idempotency: {
      public_id: createStorageVnextUploadIdentity(
        "idempotency",
        "source-processing",
        session.knowledge_base_id,
        revisionPublicId
      ),
      knowledge_base_id: session.knowledge_base_id,
      idempotency_key: idempotency.key,
      request_hash: idempotency.requestHash,
      operation_public_id: operationPublicId,
      expires_at: new Date(
        Date.parse(completedAt) + sourceWorkRetentionMilliseconds
      ).toISOString(),
      created_at: completedAt
    },
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
