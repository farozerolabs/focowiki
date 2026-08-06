import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextPublicationSnapshotPort
} from "../publication/projection-loader.js";
import type { StorageVnextMutationCandidateOverlay } from "./candidate-overlay.js";

type DirectoryCounts = ReadonlyMap<string, number>;

export function createPostgresStorageVnextMutationCandidateSnapshot(input: {
  sql: DatabaseClient;
  mutation: StorageVnextMutationCandidateOverlay;
  snapshot: StorageVnextPublicationSnapshotPort;
}): StorageVnextPublicationSnapshotPort {
  return {
    ...input.snapshot,

    async readDirectoryDescendantFileCounts(request) {
      assertScope(input.mutation, request.knowledgeBaseId);
      if (input.mutation.kind === "source_directory_move") {
        return readDirectoryMoveCounts(input.sql, input.mutation, request);
      }
      const counts = await input.snapshot.readDirectoryDescendantFileCounts(request);
      if (
        !["source_file_move", "source_replace"].includes(input.mutation.kind)
        || !input.mutation.candidateLogicalPath
      ) return counts;
      const rows = await input.sql<Array<{ source_count: number | string }>>`
        SELECT count(*) AS source_count
        FROM focowiki.source_files source
        JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = source.knowledge_base_id
         AND current_revision.source_file_public_id = source.public_id
        WHERE source.knowledge_base_id = ${request.knowledgeBaseId}
          AND source.public_id = ${input.mutation.targetPublicId}
          AND source.deleted_at IS NULL
          AND source.status = 'ready'
      `;
      return adjustStorageVnextDirectoryCountsForSourcePathChange({
        counts,
        currentSourceLogicalPath: requiredPath(input.mutation.currentLogicalPath),
        candidateSourceLogicalPath: input.mutation.candidateLogicalPath,
        sourceCount: Number(rows[0]?.source_count ?? 0)
      });
    }
  };
}

export function adjustStorageVnextDirectoryCountsForSourcePathChange(input: {
  counts: DirectoryCounts;
  currentSourceLogicalPath: string;
  candidateSourceLogicalPath: string;
  sourceCount: number;
}): Map<string, number> {
  if (
    !input.currentSourceLogicalPath
    || !input.candidateSourceLogicalPath
    || !Number.isSafeInteger(input.sourceCount)
    || input.sourceCount < 0
  ) throw candidateSnapshotError("invalid_input");
  return new Map([...input.counts].map(([directoryPath, count]) => {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw candidateSnapshotError("invalid_input");
    }
    const currentContribution = containsSource(directoryPath, input.currentSourceLogicalPath)
      ? input.sourceCount
      : 0;
    const candidateContribution = containsSource(
      directoryPath,
      input.candidateSourceLogicalPath
    ) ? input.sourceCount : 0;
    const adjusted = count - currentContribution + candidateContribution;
    if (adjusted < 0) throw candidateSnapshotError("count_conflict");
    return [directoryPath, adjusted];
  }));
}

async function readDirectoryMoveCounts(
  sql: DatabaseClient,
  mutation: StorageVnextMutationCandidateOverlay,
  request: {
    knowledgeBaseId: string;
    directoryPaths: readonly string[];
  }
): Promise<Map<string, number>> {
  if (request.directoryPaths.length === 0) return new Map();
  const currentLogicalPath = requiredPath(mutation.currentLogicalPath);
  const candidateLogicalPath = requiredPath(mutation.candidateLogicalPath);
  const rows = await sql<Array<{
    directory_path: string;
    descendant_file_count: number | string;
  }>>`
    WITH requested AS (
      SELECT DISTINCT directory_path
      FROM unnest(${request.directoryPaths}::text[]) directory_path
    ), effective_source AS (
      SELECT CASE WHEN (
                    source.logical_path = ${currentLogicalPath}
                    OR left(source.logical_path, length(${currentLogicalPath}) + 1)
                      = ${`${currentLogicalPath}/`}
                  )
               THEN ${candidateLogicalPath}
                 || substring(source.logical_path FROM length(${currentLogicalPath}) + 1)
               ELSE source.logical_path END AS logical_path
      FROM focowiki.source_files source
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = source.knowledge_base_id
       AND current_revision.source_file_public_id = source.public_id
      WHERE source.knowledge_base_id = ${request.knowledgeBaseId}
        AND source.deleted_at IS NULL
        AND source.status = 'ready'
    )
    SELECT requested.directory_path,
           count(source.logical_path) AS descendant_file_count
    FROM requested
    LEFT JOIN effective_source source ON (
      requested.directory_path = 'pages'
      OR left(
        source.logical_path,
        length(substring(requested.directory_path FROM 7)) + 1
      ) = substring(requested.directory_path FROM 7) || '/'
    )
    GROUP BY requested.directory_path
    ORDER BY requested.directory_path COLLATE "C"
  `;
  return new Map(rows.map((row) => [
    row.directory_path,
    Number(row.descendant_file_count)
  ]));
}

function containsSource(directoryPath: string, sourceLogicalPath: string): boolean {
  if (directoryPath === "pages") return true;
  if (!directoryPath.startsWith("pages/")) {
    throw candidateSnapshotError("invalid_input");
  }
  return sourceLogicalPath.startsWith(`${directoryPath.slice(6)}/`);
}

function assertScope(
  mutation: StorageVnextMutationCandidateOverlay,
  knowledgeBaseId: string
): void {
  if (!knowledgeBaseId || mutation.knowledgeBaseId !== knowledgeBaseId) {
    throw candidateSnapshotError("scope_conflict");
  }
}

function requiredPath(value: string | null | undefined): string {
  if (!value) throw candidateSnapshotError("candidate_state_invalid");
  return value;
}

function candidateSnapshotError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext mutation candidate snapshot error: ${code}`),
    { code }
  );
}
