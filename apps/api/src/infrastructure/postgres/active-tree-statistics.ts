import type {
  ActiveGenerationProjection
} from "../../application/ports/active-generation-read-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type TreeStatistics = {
  path: string;
  directEntryCount: number;
  directDirectoryCount: number;
  directFileCount: number;
  descendantFileCount: number;
};

type TreeStatisticsRow = {
  path: string;
  direct_entry_count: number;
  direct_directory_count: number;
  direct_file_count: number;
  descendant_file_count: number;
};

export class ActiveTreeStatisticsUnavailableError extends Error {
  public constructor(options?: { cause?: unknown }) {
    super("Active directory statistics are temporarily unavailable.", options);
    this.name = "ActiveTreeStatisticsUnavailableError";
  }
}

export async function hydrateActiveTreeStatistics(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  generationId: string;
  entries: ActiveGenerationProjection[];
}): Promise<ActiveGenerationProjection[]> {
  const directoryEntries = input.entries.filter((entry) =>
    entry.path && readPayloadString(entry.payload, "kind") === "directory"
  );
  const directoryPaths = [...new Set(
    directoryEntries.map((entry) => entry.path!).filter(Boolean)
  )];
  if (directoryPaths.length === 0) return input.entries;

  let persistedRows: TreeStatisticsRow[];
  try {
    persistedRows = await input.sql<TreeStatisticsRow[]>`
      SELECT path, direct_entry_count, direct_directory_count,
             direct_file_count, descendant_file_count
      FROM focowiki.generation_tree_directory_stats
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND generation_id = ${input.generationId}
        AND path = ANY(${directoryPaths})
    `;
  } catch (error) {
    throw new ActiveTreeStatisticsUnavailableError({ cause: error });
  }

  const statistics = new Map<string, TreeStatistics>();
  for (const row of persistedRows) {
    if (statistics.has(row.path)) throw new ActiveTreeStatisticsUnavailableError();
    const value = statisticsFromRow(row);
    if (value) statistics.set(row.path, value);
  }

  for (const entry of directoryEntries) {
    if (!entry.path || statistics.has(entry.path)) continue;
    const value = statisticsFromPayload(entry.path, entry.payload);
    if (value) statistics.set(entry.path, value);
  }

  const unresolvedPaths = directoryPaths.filter((path) => !statistics.has(path));
  if (unresolvedPaths.length > 0) {
    let fallbackRows: TreeStatisticsRow[];
    try {
      fallbackRows = await input.sql<TreeStatisticsRow[]>`
        WITH requested(path) AS MATERIALIZED (
          SELECT unnest(${unresolvedPaths}::text[])
        ),
        direct_counts AS (
          SELECT child.parent_path AS path,
                 count(*) FILTER (
                   WHERE child.payload_json->>'kind' IN ('directory', 'file')
                 )::int AS direct_entry_count,
                 count(*) FILTER (
                   WHERE child.payload_json->>'kind' = 'directory'
                 )::int AS direct_directory_count,
                 count(*) FILTER (
                   WHERE child.payload_json->>'kind' = 'file'
                 )::int AS direct_file_count
          FROM focowiki.active_projection_records child
          WHERE child.knowledge_base_id = ${input.knowledgeBaseId}
            AND child.projection_kind = 'tree'
            AND child.parent_path = ANY(${unresolvedPaths})
          GROUP BY child.parent_path
        ),
        descendant_counts AS (
          SELECT requested.path,
                 count(descendant.record_id)::int AS descendant_file_count
          FROM requested
          LEFT JOIN focowiki.active_projection_records descendant
            ON descendant.knowledge_base_id = ${input.knowledgeBaseId}
           AND descendant.projection_kind = 'tree'
           AND descendant.logical_path >= requested.path || '/'
           AND descendant.logical_path < requested.path || '0'
           AND descendant.payload_json->>'kind' = 'file'
          GROUP BY requested.path
        )
        SELECT requested.path,
               coalesce(direct.direct_entry_count, 0) AS direct_entry_count,
               coalesce(direct.direct_directory_count, 0) AS direct_directory_count,
               coalesce(direct.direct_file_count, 0) AS direct_file_count,
               coalesce(descendant.descendant_file_count, 0) AS descendant_file_count
        FROM requested
        LEFT JOIN direct_counts direct USING (path)
        LEFT JOIN descendant_counts descendant USING (path)
      `;
    } catch (error) {
      throw new ActiveTreeStatisticsUnavailableError({ cause: error });
    }
    for (const row of fallbackRows) {
      if (statistics.has(row.path)) throw new ActiveTreeStatisticsUnavailableError();
      const value = statisticsFromRow(row);
      if (!value) throw new ActiveTreeStatisticsUnavailableError();
      statistics.set(row.path, value);
    }
  }

  if (directoryPaths.some((path) => !statistics.has(path))) {
    throw new ActiveTreeStatisticsUnavailableError();
  }

  return input.entries.map((entry) => {
    const value = entry.path ? statistics.get(entry.path) : null;
    if (!value) return entry;
    return {
      ...entry,
      payload: {
        ...(entry.payload as Record<string, SerializableJson>),
        directEntryCount: value.directEntryCount,
        directDirectoryCount: value.directDirectoryCount,
        directFileCount: value.directFileCount,
        descendantFileCount: value.descendantFileCount
      }
    };
  });
}

function statisticsFromRow(row: TreeStatisticsRow): TreeStatistics | null {
  return createStatistics(row.path, {
    directEntryCount: Number(row.direct_entry_count),
    directDirectoryCount: Number(row.direct_directory_count),
    directFileCount: Number(row.direct_file_count),
    descendantFileCount: Number(row.descendant_file_count)
  });
}

function statisticsFromPayload(
  path: string,
  payload: SerializableJson
): TreeStatistics | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const value = payload as Record<string, SerializableJson>;
  return createStatistics(path, {
    directEntryCount: value.directEntryCount,
    directDirectoryCount: value.directDirectoryCount,
    directFileCount: value.directFileCount,
    descendantFileCount: value.descendantFileCount
  });
}

function createStatistics(
  path: string,
  value: {
    directEntryCount: unknown;
    directDirectoryCount: unknown;
    directFileCount: unknown;
    descendantFileCount: unknown;
  }
): TreeStatistics | null {
  const counts = [
    value.directEntryCount,
    value.directDirectoryCount,
    value.directFileCount,
    value.descendantFileCount
  ];
  if (!counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) {
    return null;
  }
  if (Number(value.directEntryCount)
      !== Number(value.directDirectoryCount) + Number(value.directFileCount)) {
    return null;
  }
  return {
    path,
    directEntryCount: Number(value.directEntryCount),
    directDirectoryCount: Number(value.directDirectoryCount),
    directFileCount: Number(value.directFileCount),
    descendantFileCount: Number(value.descendantFileCount)
  };
}

function readPayloadString(payload: SerializableJson, key: string): string | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const value = (payload as Record<string, SerializableJson>)[key];
  return typeof value === "string" ? value : null;
}
