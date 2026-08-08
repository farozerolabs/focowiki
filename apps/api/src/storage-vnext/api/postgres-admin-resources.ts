import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type {
  SourceDirectoryRecord,
  SourceResourceFileFilters,
  SourceResourceFileRecord
} from "../../domain/source-resource.js";

type DirectoryRow = {
  public_id: string;
  knowledge_base_id: string;
  parent_public_id: string | null;
  logical_path: string;
  revision: number | string;
  created_at: Date;
  updated_at: Date;
  direct_file_count: number | string;
  descendant_file_count: number | string;
};

type SourceRow = {
  public_id: string;
  knowledge_base_id: string;
  directory_public_id: string | null;
  logical_path: string;
  status: "pending" | "processing" | "ready" | "failed";
  safe_error_code: string | null;
  safe_error_message: string | null;
  revision: number | string;
  created_at: Date;
  updated_at: Date;
  source_revision_public_id: string | null;
  checksum_sha256: string | null;
  byte_count: number | string | null;
  content_type: string | null;
  generated_path: string | null;
  model_invocation_status: "running" | "completed" | "failed" | "skipped" | null;
  model_invocation_model_name: string | null;
  model_invocation_started_at: Date | null;
  model_invocation_ended_at: Date | null;
  model_invocation_warning_count: number | string | null;
  model_invocation_error_code: string | null;
};

type ResourceCursor = {
  version: 1;
  scope: string;
  logicalPath: string;
  publicId: string;
};

export type StorageVnextAdminResourceRead = {
  listDirectories(input: {
    knowledgeBaseId: string;
    parentDirectoryId: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: SourceDirectoryRecord[]; nextCursor: string | null }>;
  getDirectory(input: {
    knowledgeBaseId: string;
    directoryId: string;
  }): Promise<SourceDirectoryRecord | null>;
  listSourceFiles(input: {
    knowledgeBaseId: string;
    directoryId: string | null | undefined;
    filters: SourceResourceFileFilters;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: SourceResourceFileRecord[]; nextCursor: string | null }>;
  getSourceFile(input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<SourceResourceFileRecord | null>;
};

export function createPostgresStorageVnextAdminResourceRead(
  sql: DatabaseClient
): StorageVnextAdminResourceRead {
  return {
    async listDirectories(input) {
      const limit = assertLimit(input.limit);
      const scope = cursorScope("directories", input);
      const cursor = decodeCursor(input.cursor, scope);
      const rows = await readDirectories(sql, {
        ...input,
        cursor,
        limit: limit + 1,
        directoryId: null
      });
      return page(rows, limit, scope, mapDirectory);
    },

    async getDirectory(input) {
      const rows = await readDirectories(sql, {
        ...input,
        parentDirectoryId: null,
        cursor: null,
        limit: 1,
        directoryId: input.directoryId
      });
      return rows[0] ? mapDirectory(rows[0]) : null;
    },

    async listSourceFiles(input) {
      const limit = assertLimit(input.limit);
      const scope = cursorScope("source-files", input);
      const cursor = decodeCursor(input.cursor, scope);
      const rows = await readSourceFiles(sql, {
        ...input,
        cursor,
        limit: limit + 1,
        sourceFileId: null
      });
      return page(rows, limit, scope, mapSourceFile);
    },

    async getSourceFile(input) {
      const rows = await readSourceFiles(sql, {
        ...input,
        directoryId: undefined,
        filters: emptyFilters(),
        cursor: null,
        limit: 1,
        sourceFileId: input.sourceFileId
      });
      return rows[0] ? mapSourceFile(rows[0]) : null;
    }
  };
}

async function readDirectories(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    parentDirectoryId: string | null;
    directoryId: string | null;
    cursor: ResourceCursor | null;
    limit: number;
  }
) {
  return sql<DirectoryRow[]>`
    SELECT directory.public_id, directory.knowledge_base_id,
           directory.parent_public_id, directory.logical_path,
           directory.revision, directory.created_at, directory.updated_at,
           (SELECT count(*) FROM focowiki.source_files source
            WHERE source.knowledge_base_id = directory.knowledge_base_id
              AND source.directory_public_id = directory.public_id
              AND source.deleted_at IS NULL) AS direct_file_count,
           (SELECT count(*) FROM focowiki.source_files source
            WHERE source.knowledge_base_id = directory.knowledge_base_id
              AND source.deleted_at IS NULL
              AND (source.normalized_path LIKE directory.normalized_path || '/%'))
             AS descendant_file_count
    FROM focowiki.source_directories directory
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = directory.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
      AND directory.deleted_at IS NULL
      AND (${input.directoryId}::text IS NULL
        OR directory.public_id = ${input.directoryId})
      AND (${input.directoryId}::text IS NOT NULL
        OR directory.parent_public_id IS NOT DISTINCT FROM ${input.parentDirectoryId})
      AND (
        ${input.cursor?.logicalPath ?? null}::text IS NULL
        OR (directory.logical_path, directory.public_id) >
           (${input.cursor?.logicalPath ?? null}::text, ${input.cursor?.publicId ?? null}::text)
      )
    ORDER BY directory.logical_path COLLATE "C", directory.public_id COLLATE "C"
    LIMIT ${input.limit}
  `;
}

async function readSourceFiles(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    directoryId: string | null | undefined;
    filters: SourceResourceFileFilters;
    sourceFileId: string | null;
    cursor: ResourceCursor | null;
    limit: number;
  }
) {
  const lifecycleStatuses = sourceStatuses(input.filters.state ?? null);
  const generatedStatus = input.filters.generatedOutputStatus ?? generatedFromState(
    input.filters.state ?? null
  );
  const stageStatuses = statusesFromStage(input.filters.currentStage ?? null);
  return sql<SourceRow[]>`
    SELECT source.public_id, source.knowledge_base_id,
           source.directory_public_id, source.logical_path, source.status,
           source.safe_error_code, source.safe_error_message, source.revision,
           source.created_at, source.updated_at,
           revision.public_id AS source_revision_public_id,
           revision.checksum_sha256, revision.byte_count, revision.content_type,
           generated.logical_path AS generated_path,
           CASE
             WHEN source.model_invocation_source_revision_public_id = revision.public_id
               THEN source.model_invocation_status
             ELSE NULL
           END AS model_invocation_status,
           source.model_invocation_model_name,
           source.model_invocation_started_at, source.model_invocation_ended_at,
           source.model_invocation_warning_count, source.model_invocation_error_code
    FROM focowiki.source_files source
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = source.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    LEFT JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = source.knowledge_base_id
     AND current_revision.source_file_public_id = source.public_id
    LEFT JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = current_revision.knowledge_base_id
     AND revision.source_file_public_id = current_revision.source_file_public_id
     AND revision.public_id = current_revision.source_revision_public_id
    LEFT JOIN focowiki.release_roots active_root
      ON active_root.knowledge_base_id = source.knowledge_base_id
     AND active_root.root_role = 'active'
    LEFT JOIN LATERAL focowiki.resolve_release_catalog(
      active_root.public_id
    ) generated
      ON generated.source_file_public_id = source.public_id
     AND generated.entry_kind = 'source'
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.deleted_at IS NULL
      AND (${input.sourceFileId}::text IS NULL OR source.public_id = ${input.sourceFileId})
      AND (
        ${input.sourceFileId}::text IS NOT NULL
        OR coalesce((
          SELECT operation.state
          FROM focowiki.operations operation
          WHERE operation.knowledge_base_id = source.knowledge_base_id
            AND operation.operation_kind = 'source_processing'
            AND operation.target_kind = 'source_file'
            AND operation.target_public_id = source.public_id
          ORDER BY operation.created_at DESC, operation.public_id DESC
          LIMIT 1
        ), '') <> 'deleted'
      )
      AND (${input.directoryId === undefined} OR source.directory_public_id
        IS NOT DISTINCT FROM ${input.directoryId ?? null})
      AND (${input.filters.pathQuery ?? null}::text IS NULL OR strpos(
        lower(source.logical_path), lower(${input.filters.pathQuery ?? null})
      ) > 0)
      AND (${input.filters.sourceFileIdPrefix ?? null}::text IS NULL OR
        source.public_id LIKE ${`${input.filters.sourceFileIdPrefix ?? ""}%`})
      AND (${lifecycleStatuses}::text[] IS NULL OR source.status = ANY(${lifecycleStatuses}))
      AND (${stageStatuses}::text[] IS NULL OR source.status = ANY(${stageStatuses}))
      AND (${input.filters.modelInvocationStatus ?? null}::text IS NULL
        OR (${input.filters.modelInvocationStatus ?? null} = 'not_recorded'
          AND (
            source.model_invocation_status IS NULL
            OR source.model_invocation_source_revision_public_id IS DISTINCT FROM revision.public_id
          ))
        OR (
          source.model_invocation_source_revision_public_id = revision.public_id
          AND source.model_invocation_status = ${input.filters.modelInvocationStatus ?? null}
        ))
      AND (${generatedStatus}::text IS NULL OR
        (${generatedStatus} = 'visible' AND generated.logical_path IS NOT NULL) OR
        (${generatedStatus} = 'unavailable' AND source.status = 'failed') OR
        (${generatedStatus} = 'pending' AND generated.logical_path IS NULL
          AND source.status <> 'failed'))
      AND (${input.filters.startedFrom ?? null}::timestamptz IS NULL
        OR source.created_at >= ${input.filters.startedFrom ?? null})
      AND (${input.filters.startedTo ?? null}::timestamptz IS NULL
        OR source.created_at <= ${input.filters.startedTo ?? null})
      AND (${input.filters.endedFrom ?? null}::timestamptz IS NULL OR (
        source.status IN ('ready', 'failed')
        AND source.updated_at >= ${input.filters.endedFrom ?? null}
      ))
      AND (${input.filters.endedTo ?? null}::timestamptz IS NULL OR (
        source.status IN ('ready', 'failed')
        AND source.updated_at <= ${input.filters.endedTo ?? null}
      ))
      AND (${input.filters.errorState ?? null}::text IS NULL
        OR (${input.filters.errorState ?? null} = 'with_error' AND source.status = 'failed')
        OR (${input.filters.errorState ?? null} = 'without_error' AND source.status <> 'failed'))
      AND (${input.filters.errorCodeQuery ?? null}::text IS NULL OR strpos(
        lower(coalesce(source.safe_error_code, '')),
        lower(${input.filters.errorCodeQuery ?? null})
      ) > 0)
      AND (${input.filters.actionState ?? null}::text IS NULL
        OR (${input.filters.actionState ?? null} = 'openable'
          AND generated.logical_path IS NOT NULL)
        OR (${input.filters.actionState ?? null} = 'retryable'
          AND source.status = 'failed')
        OR (${input.filters.actionState ?? null} = 'none'
          AND generated.logical_path IS NULL AND source.status <> 'failed'))
      AND (
        ${input.cursor?.logicalPath ?? null}::text IS NULL
        OR (source.logical_path, source.public_id) >
           (${input.cursor?.logicalPath ?? null}::text, ${input.cursor?.publicId ?? null}::text)
      )
    ORDER BY source.logical_path COLLATE "C", source.public_id COLLATE "C"
    LIMIT ${input.limit}
  `;
}

function mapDirectory(row: DirectoryRow): SourceDirectoryRecord {
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    parentDirectoryId: row.parent_public_id,
    name: nameOf(row.logical_path),
    relativePath: row.logical_path,
    depth: row.logical_path.split("/").length,
    resourceRevision: count(row.revision),
    directFileCount: count(row.direct_file_count),
    descendantFileCount: count(row.descendant_file_count),
    deleting: false,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapSourceFile(row: SourceRow): SourceResourceFileRecord {
  const modelInvocationCurrent = row.model_invocation_status !== null;
  const failure = row.status === "failed" ? {
    stage: "metadata_resolution" as const,
    code: row.safe_error_code ?? "SOURCE_PROCESSING_FAILED",
    message: row.safe_error_message ?? "Source processing failed.",
    occurredAt: row.updated_at.toISOString(),
    retryKind: "source_processing" as const,
    correlationId: row.public_id
  } : null;
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    directoryId: row.directory_public_id,
    name: nameOf(row.logical_path),
    relativePath: row.logical_path,
    contentType: row.content_type ?? "text/markdown; charset=utf-8",
    sizeBytes: count(row.byte_count ?? 0),
    checksumSha256: row.checksum_sha256 ?? "",
    resourceRevision: count(row.revision),
    contentRevision: count(row.revision),
    activeRevisionId: row.source_revision_public_id ?? "",
    processingStatus: processingStatus(row.status),
    currentStage: row.status === "ready" ? "generation_activation" : "metadata_resolution",
    terminalFailure: failure,
    generatedOutputStatus: row.generated_path
      ? "visible"
      : row.status === "failed" ? "unavailable" : "pending",
    generatedPath: row.generated_path,
    modelInvocationStatus: row.model_invocation_status,
    modelInvocationModelName: modelInvocationCurrent ? row.model_invocation_model_name : null,
    modelInvocationStartedAt: modelInvocationCurrent
      ? row.model_invocation_started_at?.toISOString() ?? null : null,
    modelInvocationEndedAt: modelInvocationCurrent
      ? row.model_invocation_ended_at?.toISOString() ?? null : null,
    modelInvocationWarningCount: !modelInvocationCurrent
      || row.model_invocation_warning_count === null
      ? null : count(row.model_invocation_warning_count),
    modelInvocationErrorCode: modelInvocationCurrent ? row.model_invocation_error_code : null,
    deleting: false,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function processingStatus(status: SourceRow["status"]): SourceResourceFileRecord["processingStatus"] {
  if (status === "pending") return "queued";
  if (status === "processing") return "running";
  if (status === "ready") return "completed";
  return "failed";
}

function sourceStatuses(state: SourceResourceFileFilters["state"]): string[] | null {
  if (!state) return null;
  if (state === "queued") return ["pending"];
  if (state === "running") return ["processing"];
  if (state === "failed") return ["failed"];
  return ["ready"];
}

function generatedFromState(state: SourceResourceFileFilters["state"]) {
  if (state === "visible") return "visible" as const;
  if (state === "pending_publication") return "pending" as const;
  return null;
}

function statusesFromStage(stage: SourceResourceFileFilters["currentStage"]): string[] | null {
  if (!stage) return null;
  if (stage === "generation_activation") return ["ready"];
  if (stage === "metadata_resolution") return ["pending", "processing", "failed"];
  return [];
}

function emptyFilters(): SourceResourceFileFilters {
  return {
    pathQuery: null,
    sourceFileIdPrefix: null,
    state: null,
    currentStage: null,
    generatedOutputStatus: null,
    modelInvocationStatus: null,
    startedFrom: null,
    startedTo: null,
    endedFrom: null,
    endedTo: null,
    errorState: null,
    errorCodeQuery: null,
    actionState: null
  };
}

function page<TRow extends { logical_path: string; public_id: string }, T>(
  rows: TRow[],
  limit: number,
  scope: string,
  map: (row: TRow) => T
) {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && last
      ? encodeCursor({
          version: 1,
          scope,
          logicalPath: last.logical_path,
          publicId: last.public_id
        })
      : null
  };
}

function cursorScope(kind: string, input: object): string {
  const queryIdentity = Object.fromEntries(
    Object.entries(input).filter(([field]) => field !== "cursor" && field !== "limit")
  );
  return createHash("sha256").update(JSON.stringify({ kind, ...queryIdentity })).digest("hex");
}

function encodeCursor(cursor: ResourceCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | null, scope: string): ResourceCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ResourceCursor>;
    if (
      value.version !== 1 || value.scope !== scope
      || typeof value.logicalPath !== "string"
      || typeof value.publicId !== "string" || !value.publicId
    ) throw new Error("invalid");
    return value as ResourceCursor;
  } catch {
    throw new Error("Invalid storage vNext resource cursor");
  }
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Invalid storage vNext resource page limit");
  }
  return limit;
}

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function count(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid storage vNext resource count");
  }
  return parsed;
}
