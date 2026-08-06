import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextCatalogReadPort,
  StorageVnextCurrentSourceFact,
  StorageVnextDirectoryFact,
  StorageVnextKnowledgeBaseFact,
  StorageVnextSourceFileFact,
  StorageVnextSourceFileStatus,
  StorageVnextSourceRevisionFact
} from "../catalog/ports.js";
import {
  decodeStorageVnextCatalogCursor,
  encodeStorageVnextCatalogCursor
} from "../catalog/cursor.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import type { StorageVnextMutationCandidateOverlay } from "./candidate-overlay.js";

type OverlayRequest = {
  knowledgeBaseId: string;
  operationPublicId: string;
  candidatePublicId: string;
};

type MutationRow = {
  knowledge_base_id: string;
  operation_kind: string;
  candidate_public_id: string;
  checkpoint: StorageVnextMutationCandidateOverlay & {
    version: number;
    candidatePublicId?: string;
  };
};

type DirectoryRow = {
  public_id: string;
  knowledge_base_id: string;
  parent_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  revision: number | string;
  deleted_at: Date | null;
};

type SourceFileRow = {
  public_id: string;
  knowledge_base_id: string;
  directory_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  metadata: StorageVnextStructuredMetadata;
  current_revision_public_id: string | null;
  status: StorageVnextSourceFileStatus;
  safe_error_code: string | null;
  safe_error_message: string | null;
  revision: number | string;
  deleted_at: Date | null;
};

type CurrentSourceRow = SourceFileRow & {
  source_revision_public_id: string;
  source_revision_object_id: string;
  source_revision_checksum_sha256: string;
  source_revision_byte_count: number | string;
  source_revision_content_type: string;
  source_revision_created_at: Date;
};

const MUTATION_KINDS = new Set([
  "knowledge_base_metadata",
  "source_file_metadata",
  "source_file_move",
  "source_directory_move",
  "source_replace"
]);

export async function readPostgresStorageVnextMutationCandidateOverlay(
  sql: DatabaseClient,
  request: OverlayRequest
): Promise<StorageVnextMutationCandidateOverlay | null> {
  const rows = await sql<MutationRow[]>`
    SELECT operation.knowledge_base_id, operation.operation_kind,
           candidate.public_id AS candidate_public_id, work.checkpoint
    FROM focowiki.operations operation
    JOIN focowiki.operation_work_items work
      ON work.knowledge_base_id = operation.knowledge_base_id
     AND work.operation_public_id = operation.public_id
     AND work.work_kind = 'mutation'
    JOIN focowiki.release_candidates candidate
      ON candidate.knowledge_base_id = operation.knowledge_base_id
     AND candidate.operation_public_id = operation.public_id
    WHERE operation.knowledge_base_id = ${request.knowledgeBaseId}
      AND operation.public_id = ${request.operationPublicId}
      AND candidate.public_id = ${request.candidatePublicId}
      AND work.state IN ('queued', 'running', 'retry')
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const checkpoint = row.checkpoint;
  if (
    checkpoint.version !== 1
    || checkpoint.knowledgeBaseId !== undefined
      && checkpoint.knowledgeBaseId !== request.knowledgeBaseId
    || checkpoint.candidatePublicId !== undefined
      && checkpoint.candidatePublicId !== request.candidatePublicId
    || checkpoint.kind !== row.operation_kind
    || !MUTATION_KINDS.has(checkpoint.kind)
    || !checkpoint.targetPublicId
    || !Number.isSafeInteger(checkpoint.expectedResourceRevision)
  ) throw candidateOverlayError("candidate_state_invalid");
  return {
    ...checkpoint,
    knowledgeBaseId: row.knowledge_base_id
  };
}

export function createPostgresStorageVnextMutationCandidateCatalog(input: {
  sql: DatabaseClient;
  mutation: StorageVnextMutationCandidateOverlay;
  catalog: StorageVnextCatalogReadPort;
}): StorageVnextCatalogReadPort {
  assertMutation(input.mutation);
  return {
    ...input.catalog,

    async getKnowledgeBase(request) {
      const fact = await input.catalog.getKnowledgeBase(request);
      if (!fact || request.knowledgeBaseId !== input.mutation.knowledgeBaseId) {
        return fact;
      }
      return overlayKnowledgeBase(input.mutation, fact);
    },

    async getDirectory(request) {
      const fact = await input.catalog.getDirectory(request);
      return fact ? overlayDirectory(input.mutation, fact) : null;
    },

    async listDirectories(request) {
      assertScope(input.mutation, request.knowledgeBaseId);
      if ((request.visibility ?? "current") !== "current") {
        return input.catalog.listDirectories(request);
      }
      const limit = assertLimit(request.limit);
      const scope = directoryScope(request);
      const cursor = decodeCatalogCursor(request.cursor, "directory", scope);
      const mutation = input.mutation;
      const directoryMove = mutation.kind === "source_directory_move";
      const currentLogicalPath = mutation.currentLogicalPath ?? "";
      const currentNormalizedPath = mutation.currentNormalizedPath ?? "";
      const candidateLogicalPath = mutation.candidateLogicalPath ?? "";
      const normalizedCandidatePath = mutation.normalizedCandidatePath ?? "";
      const rows = await input.sql<DirectoryRow[]>`
        WITH effective AS (
          SELECT directory.public_id, directory.knowledge_base_id,
                 CASE WHEN ${directoryMove}
                           AND directory.public_id = ${mutation.targetPublicId}
                   THEN ${mutation.candidateParentPublicId ?? null}
                   ELSE directory.parent_public_id END AS parent_public_id,
                 CASE WHEN ${directoryMove} AND (
                            directory.logical_path = ${currentLogicalPath}
                            OR left(directory.logical_path,
                              length(${currentLogicalPath}) + 1)
                              = ${`${currentLogicalPath}/`}
                          )
                   THEN ${candidateLogicalPath}
                     || substring(directory.logical_path
                       FROM length(${currentLogicalPath}) + 1)
                   ELSE directory.logical_path END AS logical_path,
                 CASE WHEN ${directoryMove} AND (
                            directory.normalized_path = ${currentNormalizedPath}
                            OR left(directory.normalized_path,
                              length(${currentNormalizedPath}) + 1)
                              = ${`${currentNormalizedPath}/`}
                          )
                   THEN ${normalizedCandidatePath}
                     || substring(directory.normalized_path
                       FROM length(${currentNormalizedPath}) + 1)
                   ELSE directory.normalized_path END AS normalized_path,
                 CASE WHEN ${directoryMove}
                           AND directory.public_id = ${mutation.targetPublicId}
                   THEN ${mutation.candidateTitle ?? ""}
                   ELSE directory.title END AS title,
                 directory.revision + CASE WHEN ${directoryMove} AND (
                            directory.normalized_path = ${currentNormalizedPath}
                            OR left(directory.normalized_path,
                              length(${currentNormalizedPath}) + 1)
                              = ${`${currentNormalizedPath}/`}
                          ) THEN 1 ELSE 0 END AS revision,
                 directory.deleted_at
          FROM focowiki.source_directories directory
          WHERE directory.knowledge_base_id = ${request.knowledgeBaseId}
            AND directory.deleted_at IS NULL
        )
        SELECT public_id, knowledge_base_id, parent_public_id, logical_path,
               normalized_path, title, revision, deleted_at
        FROM effective
        WHERE (${request.parentPublicId === undefined}
               OR parent_public_id IS NOT DISTINCT FROM ${request.parentPublicId ?? null})
          AND (${cursor?.normalizedPath ?? null}::text IS NULL
            OR normalized_path COLLATE "C"
              > ${cursor?.normalizedPath ?? null}::text COLLATE "C"
            OR (normalized_path = ${cursor?.normalizedPath ?? null}
              AND public_id COLLATE "C"
                > ${cursor?.publicId ?? null}::text COLLATE "C"))
        ORDER BY normalized_path COLLATE "C", public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return page(rows, limit, mapDirectory, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "directory",
          scope,
          normalizedPath: row.normalized_path,
          publicId: row.public_id
        }));
    },

    async listDirectoriesByPublicIds(request) {
      const facts = await input.catalog.listDirectoriesByPublicIds(request);
      return facts.map((fact) => overlayDirectory(input.mutation, fact));
    },

    async getSourceFile(request) {
      const fact = await input.catalog.getSourceFile(request);
      return fact ? await overlaySourceFileWithRevision(input, fact) : null;
    },

    async listSourceFiles(request) {
      assertScope(input.mutation, request.knowledgeBaseId);
      if ((request.visibility ?? "current") !== "current") {
        return input.catalog.listSourceFiles(request);
      }
      return listCandidateSourceFiles(input, request);
    },

    async listSourceFilesByPublicIds(request) {
      const facts = await input.catalog.listSourceFilesByPublicIds(request);
      return Promise.all(facts.map((fact) => overlaySourceFileWithRevision(input, fact)));
    },

    async listCurrentSources(request) {
      assertScope(input.mutation, request.knowledgeBaseId);
      const limit = assertLimit(request.limit);
      const scope = `${request.knowledgeBaseId}:current`;
      const cursor = decodeCatalogCursor(request.cursor, "current_source", scope);
      const rows = await queryCandidateSources(input, {
        knowledgeBaseId: request.knowledgeBaseId,
        directoryPublicId: undefined,
        cursor,
        limit,
        includeRevision: true
      }) as CurrentSourceRow[];
      return page(rows, limit, mapCurrentSource, (row) =>
        encodeStorageVnextCatalogCursor({
          kind: "current_source",
          scope,
          normalizedPath: row.normalized_path,
          publicId: row.public_id
        }));
    },

    async getCurrentSourceRevision(request) {
      assertScope(input.mutation, request.knowledgeBaseId);
      if (
        input.mutation.kind === "source_replace"
        && request.sourceFilePublicId === input.mutation.targetPublicId
      ) {
        return input.catalog.getSourceRevision({
          knowledgeBaseId: request.knowledgeBaseId,
          publicId: requiredString(input.mutation.candidateRevisionPublicId)
        });
      }
      return input.catalog.getCurrentSourceRevision(request);
    }
  };
}

async function listCandidateSourceFiles(
  input: Parameters<typeof createPostgresStorageVnextMutationCandidateCatalog>[0],
  request: Parameters<StorageVnextCatalogReadPort["listSourceFiles"]>[0]
) {
  const limit = assertLimit(request.limit);
  const scope = `${request.knowledgeBaseId}:${request.directoryPublicId === undefined
    ? "*" : request.directoryPublicId ?? "root"}:current`;
  const cursor = decodeCatalogCursor(request.cursor, "source_file", scope);
  const rows = await queryCandidateSources(input, {
    knowledgeBaseId: request.knowledgeBaseId,
    directoryPublicId: request.directoryPublicId,
    cursor,
    limit,
    includeRevision: false
  }) as SourceFileRow[];
  return page(rows, limit, mapSourceFile, (row) =>
    encodeStorageVnextCatalogCursor({
      kind: "source_file",
      scope,
      normalizedPath: row.normalized_path,
      publicId: row.public_id
    }));
}

async function queryCandidateSources(
  input: Parameters<typeof createPostgresStorageVnextMutationCandidateCatalog>[0],
  request: {
    knowledgeBaseId: string;
    directoryPublicId: string | null | undefined;
    cursor: { normalizedPath: string | null; publicId: string } | null;
    limit: number;
    includeRevision: boolean;
  }
): Promise<SourceFileRow[] | CurrentSourceRow[]> {
  const mutation = input.mutation;
  const directoryMove = mutation.kind === "source_directory_move";
  const filePathChange = (mutation.kind === "source_file_move"
    || mutation.kind === "source_replace") && Boolean(mutation.candidateLogicalPath);
  const metadataChange = mutation.kind === "source_file_metadata";
  const replacement = mutation.kind === "source_replace";
  const currentLogicalPath = mutation.currentLogicalPath ?? "";
  const currentNormalizedPath = mutation.currentNormalizedPath ?? "";
  const candidateLogicalPath = mutation.candidateLogicalPath ?? "";
  const normalizedCandidatePath = mutation.normalizedCandidatePath ?? "";
  const candidateRevisionPublicId = mutation.candidateRevisionPublicId ?? "";
  const rows = await input.sql<CurrentSourceRow[]>`
    WITH effective AS (
      SELECT source.public_id, source.knowledge_base_id,
             CASE WHEN ${filePathChange}
                       AND source.public_id = ${mutation.targetPublicId}
               THEN ${mutation.candidateDirectoryPublicId ?? null}
               ELSE source.directory_public_id END AS directory_public_id,
             CASE
               WHEN ${filePathChange}
                    AND source.public_id = ${mutation.targetPublicId}
                 THEN ${candidateLogicalPath}
               WHEN ${directoryMove} AND (
                    source.logical_path = ${currentLogicalPath}
                    OR left(source.logical_path, length(${currentLogicalPath}) + 1)
                      = ${`${currentLogicalPath}/`}
                  ) THEN ${candidateLogicalPath}
                    || substring(source.logical_path
                      FROM length(${currentLogicalPath}) + 1)
               ELSE source.logical_path END AS logical_path,
             CASE
               WHEN ${filePathChange}
                    AND source.public_id = ${mutation.targetPublicId}
                 THEN ${normalizedCandidatePath}
               WHEN ${directoryMove} AND (
                    source.normalized_path = ${currentNormalizedPath}
                    OR left(source.normalized_path,
                      length(${currentNormalizedPath}) + 1)
                      = ${`${currentNormalizedPath}/`}
                  ) THEN ${normalizedCandidatePath}
                    || substring(source.normalized_path
                      FROM length(${currentNormalizedPath}) + 1)
               ELSE source.normalized_path END AS normalized_path,
             CASE WHEN ${metadataChange}
                       AND source.public_id = ${mutation.targetPublicId}
               THEN ${mutation.candidateTitle ?? ""}
               ELSE source.title END AS title,
             CASE WHEN ${metadataChange}
                       AND source.public_id = ${mutation.targetPublicId}
               THEN ${input.sql.json((mutation.candidateMetadata ?? {}) as never)}
               ELSE source.metadata END AS metadata,
             CASE WHEN ${replacement}
                       AND source.public_id = ${mutation.targetPublicId}
               THEN ${candidateRevisionPublicId}
               ELSE current_revision.source_revision_public_id
               END AS current_revision_public_id,
             source.status, source.safe_error_code, source.safe_error_message,
             source.revision + CASE WHEN (
               (${metadataChange || filePathChange || replacement}
                 AND source.public_id = ${mutation.targetPublicId})
               OR (${directoryMove} AND (
                 source.normalized_path = ${currentNormalizedPath}
                 OR left(source.normalized_path,
                   length(${currentNormalizedPath}) + 1)
                   = ${`${currentNormalizedPath}/`}
               ))
             ) THEN 1 ELSE 0 END AS revision,
             source.deleted_at
      FROM focowiki.source_files source
      LEFT JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = source.knowledge_base_id
       AND current_revision.source_file_public_id = source.public_id
      WHERE source.knowledge_base_id = ${request.knowledgeBaseId}
        AND source.deleted_at IS NULL
    )
    SELECT effective.public_id, effective.knowledge_base_id,
           effective.directory_public_id, effective.logical_path,
           effective.normalized_path, effective.title, effective.metadata,
           effective.current_revision_public_id, effective.status,
           effective.safe_error_code, effective.safe_error_message,
           effective.revision, effective.deleted_at,
           revision.public_id AS source_revision_public_id,
           revision.object_id AS source_revision_object_id,
           revision.checksum_sha256 AS source_revision_checksum_sha256,
           revision.byte_count AS source_revision_byte_count,
           revision.content_type AS source_revision_content_type,
           revision.created_at AS source_revision_created_at
    FROM effective
    LEFT JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = effective.knowledge_base_id
     AND revision.source_file_public_id = effective.public_id
     AND revision.public_id = effective.current_revision_public_id
    WHERE (${request.directoryPublicId === undefined}
           OR effective.directory_public_id IS NOT DISTINCT FROM
             ${request.directoryPublicId ?? null})
      AND (${request.cursor?.normalizedPath ?? null}::text IS NULL
        OR effective.normalized_path COLLATE "C"
          > ${request.cursor?.normalizedPath ?? null}::text COLLATE "C"
        OR (effective.normalized_path = ${request.cursor?.normalizedPath ?? null}
          AND effective.public_id COLLATE "C"
            > ${request.cursor?.publicId ?? null}::text COLLATE "C"))
      AND (${!request.includeRevision} OR revision.public_id IS NOT NULL)
    ORDER BY effective.normalized_path COLLATE "C", effective.public_id COLLATE "C"
    LIMIT ${request.limit + 1}
  `;
  return rows;
}

async function overlaySourceFileWithRevision(
  input: Parameters<typeof createPostgresStorageVnextMutationCandidateCatalog>[0],
  fact: StorageVnextSourceFileFact
): Promise<StorageVnextSourceFileFact> {
  const overlaid = overlaySourceFile(input.mutation, fact);
  if (
    input.mutation.kind !== "source_replace"
    || fact.publicId !== input.mutation.targetPublicId
  ) return overlaid;
  const revision = await input.catalog.getSourceRevision({
    knowledgeBaseId: fact.knowledgeBaseId,
    publicId: requiredString(input.mutation.candidateRevisionPublicId)
  });
  if (!revision || revision.sourceFilePublicId !== fact.publicId) {
    throw candidateOverlayError("candidate_revision_missing");
  }
  return { ...overlaid, currentRevisionPublicId: revision.publicId };
}

function overlayKnowledgeBase(
  mutation: StorageVnextMutationCandidateOverlay,
  fact: StorageVnextKnowledgeBaseFact
): StorageVnextKnowledgeBaseFact {
  if (mutation.kind !== "knowledge_base_metadata") return fact;
  return {
    ...fact,
    name: requiredString(mutation.candidateName),
    description: mutation.candidateDescription ?? null,
    revision: fact.revision + 1
  };
}

function overlayDirectory(
  mutation: StorageVnextMutationCandidateOverlay,
  fact: StorageVnextDirectoryFact
): StorageVnextDirectoryFact {
  assertScope(mutation, fact.knowledgeBaseId);
  if (mutation.kind !== "source_directory_move") return fact;
  const logicalPath = rewritePrefix(
    fact.logicalPath,
    requiredString(mutation.currentLogicalPath),
    requiredString(mutation.candidateLogicalPath)
  );
  const normalizedPath = rewritePrefix(
    fact.normalizedPath,
    requiredString(mutation.currentNormalizedPath),
    requiredString(mutation.normalizedCandidatePath)
  );
  if (logicalPath === fact.logicalPath && normalizedPath === fact.normalizedPath) {
    return fact;
  }
  return {
    ...fact,
    parentPublicId: fact.publicId === mutation.targetPublicId
      ? mutation.candidateParentPublicId ?? null
      : fact.parentPublicId,
    logicalPath,
    normalizedPath,
    title: fact.publicId === mutation.targetPublicId
      ? requiredString(mutation.candidateTitle)
      : fact.title,
    revision: fact.revision + 1
  };
}

function overlaySourceFile(
  mutation: StorageVnextMutationCandidateOverlay,
  fact: StorageVnextSourceFileFact
): StorageVnextSourceFileFact {
  assertScope(mutation, fact.knowledgeBaseId);
  const targeted = fact.publicId === mutation.targetPublicId;
  const directoryMove = mutation.kind === "source_directory_move";
  const filePathChange = targeted
    && (mutation.kind === "source_file_move" || mutation.kind === "source_replace")
    && Boolean(mutation.candidateLogicalPath);
  const logicalPath = directoryMove
    ? rewritePrefix(
        fact.logicalPath,
        requiredString(mutation.currentLogicalPath),
        requiredString(mutation.candidateLogicalPath)
      )
    : filePathChange ? requiredString(mutation.candidateLogicalPath) : fact.logicalPath;
  const normalizedPath = directoryMove
    ? rewritePrefix(
        fact.normalizedPath,
        requiredString(mutation.currentNormalizedPath),
        requiredString(mutation.normalizedCandidatePath)
      )
    : filePathChange
      ? requiredString(mutation.normalizedCandidatePath)
      : fact.normalizedPath;
  const metadataChange = targeted && mutation.kind === "source_file_metadata";
  const replacement = targeted && mutation.kind === "source_replace";
  const changed = logicalPath !== fact.logicalPath
    || normalizedPath !== fact.normalizedPath
    || metadataChange
    || replacement;
  if (!changed) return fact;
  return {
    ...fact,
    directoryPublicId: filePathChange
      ? mutation.candidateDirectoryPublicId ?? null
      : fact.directoryPublicId,
    logicalPath,
    normalizedPath,
    title: metadataChange ? requiredString(mutation.candidateTitle) : fact.title,
    metadata: metadataChange ? mutation.candidateMetadata ?? {} : fact.metadata,
    currentRevisionPublicId: replacement
      ? requiredString(mutation.candidateRevisionPublicId)
      : fact.currentRevisionPublicId,
    revision: fact.revision + 1
  };
}

function mapDirectory(row: DirectoryRow): StorageVnextDirectoryFact {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    parentPublicId: row.parent_public_id,
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    title: row.title,
    revision: Number(row.revision),
    visibility: row.deleted_at ? "deleted" : "current"
  };
}

function mapSourceFile(row: SourceFileRow): StorageVnextSourceFileFact {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    directoryPublicId: row.directory_public_id,
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    title: row.title,
    metadata: row.metadata,
    currentRevisionPublicId: row.current_revision_public_id,
    status: row.status,
    safeErrorCode: row.safe_error_code,
    safeErrorMessage: row.safe_error_message,
    revision: Number(row.revision),
    visibility: row.deleted_at ? "deleted" : "current"
  };
}

function mapCurrentSource(row: CurrentSourceRow): StorageVnextCurrentSourceFact {
  return {
    sourceFile: mapSourceFile(row),
    sourceRevision: mapSourceRevision(row)
  };
}

function mapSourceRevision(row: CurrentSourceRow): StorageVnextSourceRevisionFact {
  return {
    publicId: row.source_revision_public_id,
    sourceFilePublicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    objectId: row.source_revision_object_id,
    checksum: row.source_revision_checksum_sha256,
    byteCount: Number(row.source_revision_byte_count),
    contentType: row.source_revision_content_type,
    createdAt: row.source_revision_created_at.toISOString()
  };
}

function page<T, R>(
  rows: T[],
  limit: number,
  mapper: (row: T) => R,
  cursor: (row: T) => string
) {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(mapper),
    nextCursor: rows.length > limit && last ? cursor(last) : null
  };
}

function decodeCatalogCursor(
  cursor: string | null,
  kind: "current_source" | "directory" | "source_file",
  scope: string
) {
  if (!cursor) return null;
  const decoded = decodeStorageVnextCatalogCursor({ cursor, kind, scope });
  if (!decoded) throw candidateOverlayError("invalid_cursor");
  if (decoded.kind !== kind || decoded.scope !== scope) {
    throw candidateOverlayError("invalid_cursor");
  }
  return decoded;
}

function directoryScope(request: {
  knowledgeBaseId: string;
  parentPublicId: string | null | undefined;
}) {
  return `${request.knowledgeBaseId}:${request.parentPublicId === undefined
    ? "*" : request.parentPublicId ?? "root"}:current`;
}

function rewritePrefix(value: string, current: string, candidate: string): string {
  if (value === current) return candidate;
  return value.startsWith(`${current}/`)
    ? `${candidate}${value.slice(current.length)}`
    : value;
}

function assertMutation(mutation: StorageVnextMutationCandidateOverlay): void {
  if (!MUTATION_KINDS.has(mutation.kind) || !mutation.targetPublicId) {
    throw candidateOverlayError("candidate_state_invalid");
  }
  if (mutation.kind === "source_directory_move") {
    requiredString(mutation.currentLogicalPath);
    requiredString(mutation.currentNormalizedPath);
    requiredString(mutation.candidateLogicalPath);
    requiredString(mutation.normalizedCandidatePath);
  }
}

function assertScope(
  mutation: StorageVnextMutationCandidateOverlay,
  knowledgeBaseId: string
): void {
  if (!mutation.knowledgeBaseId || mutation.knowledgeBaseId !== knowledgeBaseId) {
    throw candidateOverlayError("scope_conflict");
  }
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw candidateOverlayError("invalid_limit");
  }
  return value;
}

function requiredString(value: string | null | undefined): string {
  if (!value) throw candidateOverlayError("candidate_state_invalid");
  return value;
}

function candidateOverlayError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext mutation candidate overlay error: ${code}`),
    { code }
  );
}
