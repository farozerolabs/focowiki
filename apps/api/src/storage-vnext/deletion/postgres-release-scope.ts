import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextDeletionReleaseScope,
  StorageVnextDeletionReleaseScopePort
} from "./production-release.js";

type SourceRow = {
  public_id: string;
  logical_path: string;
};

type GraphEdgeRow = {
  public_id: string;
  from_source_file_public_id: string;
  to_source_file_public_id: string;
};

export function createPostgresStorageVnextDeletionReleaseScope(
  sql: DatabaseClient
): StorageVnextDeletionReleaseScopePort {
  return {
    async findActivated(input) {
      assertIdentifier(input.knowledgeBaseId);
      assertIdentifier(input.operationPublicId);
      const rows = await sql<Array<{
        release_root_public_id: string;
        search_projection_public_id: string;
      }>>`
        SELECT snapshot.release_root_public_id,
               snapshot.search_projection_public_id
        FROM focowiki.active_snapshots snapshot
        WHERE snapshot.knowledge_base_id = ${input.knowledgeBaseId}
          AND snapshot.activated_by_operation_public_id = ${input.operationPublicId}
        LIMIT 1
      `;
      const row = rows[0];
      return row ? {
        releaseRootPublicId: row.release_root_public_id,
        searchProjectionPublicId: row.search_projection_public_id
      } : null;
    },

    async read(input) {
      validateRead(input);
      if (input.targetKind === "knowledge_base") {
        throw scopeError("invalid_target");
      }
      const normalizedPath = input.targetKind === "source_directory"
        ? requireNormalizedPath(input.normalizedPath)
        : null;
      const sources = await readPendingDeletedSources(sql, input);
      if (sources.length > input.maximumSources) {
        throw scopeError("changed_set_limit");
      }
      const sourceFilePublicIds = sources.map((source) => source.public_id);
      const graphEdges = sourceFilePublicIds.length === 0
        ? []
        : await sql<GraphEdgeRow[]>`
            SELECT edge.public_id,
                   source_node.source_file_public_id
                     AS from_source_file_public_id,
                   related_node.source_file_public_id
                     AS to_source_file_public_id
            FROM focowiki.graph_edges edge
            JOIN focowiki.graph_nodes source_node
              ON source_node.knowledge_base_id = edge.knowledge_base_id
             AND source_node.public_id = edge.from_node_public_id
            JOIN focowiki.graph_nodes related_node
              ON related_node.knowledge_base_id = edge.knowledge_base_id
             AND related_node.public_id = edge.to_node_public_id
            WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
              AND (
                source_node.source_file_public_id
                  = ANY(${sourceFilePublicIds}::text[])
                OR related_node.source_file_public_id
                  = ANY(${sourceFilePublicIds}::text[])
              )
            ORDER BY edge.public_id COLLATE "C"
            LIMIT ${input.maximumGraphEdges + 1}
          `;
      if (graphEdges.length > input.maximumGraphEdges) {
        throw scopeError("dependency_limit");
      }
      return {
        sourceFilePublicIds,
        sourceLogicalPaths: sources.map((source) => source.logical_path),
        directoryLogicalPaths: input.targetKind === "source_directory"
          ? [normalizedPath!]
          : [],
        graphSourceFilePublicIds: stableUnique([
          ...sourceFilePublicIds,
          ...graphEdges.flatMap((edge) => [
            edge.from_source_file_public_id,
            edge.to_source_file_public_id
          ])
        ]),
        graphEdgePublicIds: graphEdges.map((edge) => edge.public_id)
      } satisfies StorageVnextDeletionReleaseScope;
    }
  };
}

async function readPendingDeletedSources(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    maximumSources: number;
  }
): Promise<SourceRow[]> {
  return sql<SourceRow[]>`
    SELECT source.public_id, source.logical_path
    FROM focowiki.source_files source
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.deleted_at IS NOT NULL
    ORDER BY source.public_id COLLATE "C"
    LIMIT ${input.maximumSources + 1}
  `;
}

function validateRead(input: {
  knowledgeBaseId: string;
  targetPublicId: string;
  maximumSources: number;
  maximumGraphEdges: number;
}): void {
  assertIdentifier(input.knowledgeBaseId);
  assertIdentifier(input.targetPublicId);
  for (const limit of [input.maximumSources, input.maximumGraphEdges]) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250_000) {
      throw scopeError("invalid_limit");
    }
  }
}

function assertIdentifier(value: string): void {
  if (!value || Buffer.byteLength(value) > 255 || value.includes("\0")) {
    throw scopeError("invalid_input");
  }
}

function requireNormalizedPath(value: string | null): string {
  if (
    !value
    || Buffer.byteLength(value) > 4_096
    || value.includes("\0")
    || value.startsWith("/")
    || value.endsWith("/")
  ) throw scopeError("invalid_path");
  return value;
}

function scopeError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext deletion release scope error: ${code}`),
    { code }
  );
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en"));
}
