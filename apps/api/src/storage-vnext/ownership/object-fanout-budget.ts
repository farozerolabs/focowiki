import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { REQUIRED_GENERATED_NAVIGATION_PATHS } from
  "../../okf/generated-graph-resources.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from
  "../../publication/incremental-defaults.js";
import { STORAGE_VNEXT_EXTENSION_NAVIGATION_STATE_DIRECTORY_COUNT } from
  "../publication/profile.js";

export const MAX_STORAGE_VNEXT_ACTIVE_OBJECTS_PER_SOURCE = 5;
export const MAX_STORAGE_VNEXT_CANDIDATE_ONLY_RATIO = 0.2;
const MIN_STORAGE_VNEXT_RELEASED_OBJECTS =
  REQUIRED_GENERATED_NAVIGATION_PATHS.length + 2
  + STORAGE_VNEXT_EXTENSION_NAVIGATION_STATE_DIRECTORY_COUNT;
const MIN_STORAGE_VNEXT_FANOUT_SAMPLE_SOURCE_COUNT =
  REQUIRED_GENERATED_NAVIGATION_PATHS.length
  + Object.keys(INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner).length
  + MAX_STORAGE_VNEXT_ACTIVE_OBJECTS_PER_SOURCE
  + 2;
const MIN_STORAGE_VNEXT_FANOUT_SAMPLE_OBJECT_COUNT =
  MIN_STORAGE_VNEXT_FANOUT_SAMPLE_SOURCE_COUNT
  * MAX_STORAGE_VNEXT_ACTIVE_OBJECTS_PER_SOURCE
  + MIN_STORAGE_VNEXT_RELEASED_OBJECTS;
const MIN_STORAGE_VNEXT_FILE_FIRST_OBJECT_CEILING = Math.ceil(
  MIN_STORAGE_VNEXT_FANOUT_SAMPLE_OBJECT_COUNT
  * (1 + MAX_STORAGE_VNEXT_CANDIDATE_ONLY_RATIO)
);

export type StorageVnextObjectFanoutMeasurement = {
  sourceFileCount: number;
  activeSourceFileCount?: number;
  changedSourceFileCount?: number;
  activeGeneratedObjectCount: number;
  candidateGeneratedObjectCount: number;
  candidateOnlyObjectCount: number;
};

export type StorageVnextObjectFanoutBudget = StorageVnextObjectFanoutMeasurement & {
  maximumActiveObjects: number;
  maximumCandidateOnlyObjects: number;
  candidateChangeAllowanceUsed: boolean;
  fileFirstCompletenessAllowanceUsed: boolean;
  activeFanoutPassed: boolean;
  candidateRatioPassed: boolean;
  passed: boolean;
};

export function evaluateStorageVnextObjectFanoutBudget(
  measurement: StorageVnextObjectFanoutMeasurement
): StorageVnextObjectFanoutBudget {
  const activeSourceFileCount = measurement.activeSourceFileCount
    ?? measurement.sourceFileCount;
  const changedSourceFileCount = measurement.changedSourceFileCount ?? 0;
  for (const value of [
    measurement.sourceFileCount,
    activeSourceFileCount,
    changedSourceFileCount,
    measurement.activeGeneratedObjectCount,
    measurement.candidateGeneratedObjectCount,
    measurement.candidateOnlyObjectCount
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw Object.assign(new Error("Storage vNext object fan-out input is invalid"), {
        code: "invalid_input"
      });
    }
  }
  const scaleMaximumActiveObjects = scaleMaximumActiveObjectsForSources(
    measurement.sourceFileCount
  );
  const maximumActiveObjects = maximumActiveObjectsForSources(
    measurement.sourceFileCount
  );
  const addedSourceFileCount = Math.max(
    0,
    measurement.sourceFileCount - activeSourceFileCount
  );
  const ratioBudget = Math.ceil(
    measurement.activeGeneratedObjectCount * MAX_STORAGE_VNEXT_CANDIDATE_ONLY_RATIO
  );
  const maximumCandidateOnlyObjects = measurement.activeGeneratedObjectCount === 0
    ? measurement.candidateOnlyObjectCount
    : addedSourceFileCount > 0
      ? Math.max(
          maximumActiveObjects,
          ratioBudget
            + addedSourceFileCount * MAX_STORAGE_VNEXT_ACTIVE_OBJECTS_PER_SOURCE
        )
      : ratioBudget
        + changedSourceFileCount * MAX_STORAGE_VNEXT_ACTIVE_OBJECTS_PER_SOURCE
        + STORAGE_VNEXT_EXTENSION_NAVIGATION_STATE_DIRECTORY_COUNT;
  const candidateChangeAllowanceUsed = measurement.activeGeneratedObjectCount > 0
    && addedSourceFileCount === 0
    && changedSourceFileCount > 0;
  const fileFirstCompletenessAllowanceUsed = measurement.sourceFileCount > 0
    && maximumActiveObjects > scaleMaximumActiveObjects
    && (
      measurement.activeGeneratedObjectCount > scaleMaximumActiveObjects
      || measurement.candidateGeneratedObjectCount > scaleMaximumActiveObjects
    );
  const activeFanoutPassed = measurement.activeGeneratedObjectCount <= maximumActiveObjects
    && measurement.candidateGeneratedObjectCount <= maximumActiveObjects;
  const candidateRatioPassed = measurement.activeGeneratedObjectCount === 0
    || measurement.candidateOnlyObjectCount <= maximumCandidateOnlyObjects;
  return {
    ...measurement,
    activeSourceFileCount,
    changedSourceFileCount,
    maximumActiveObjects,
    maximumCandidateOnlyObjects,
    candidateChangeAllowanceUsed,
    fileFirstCompletenessAllowanceUsed,
    activeFanoutPassed,
    candidateRatioPassed,
    passed: activeFanoutPassed && candidateRatioPassed
  };
}

function maximumActiveObjectsForSources(sourceFileCount: number): number {
  if (sourceFileCount === 0) return MIN_STORAGE_VNEXT_RELEASED_OBJECTS;
  return Math.max(
    sourceFileCount * MAX_STORAGE_VNEXT_ACTIVE_OBJECTS_PER_SOURCE,
    MIN_STORAGE_VNEXT_FILE_FIRST_OBJECT_CEILING
  );
}

function scaleMaximumActiveObjectsForSources(sourceFileCount: number): number {
  if (sourceFileCount === 0) return MIN_STORAGE_VNEXT_RELEASED_OBJECTS;
  return Math.max(
    sourceFileCount * MAX_STORAGE_VNEXT_ACTIVE_OBJECTS_PER_SOURCE,
    MIN_STORAGE_VNEXT_FANOUT_SAMPLE_OBJECT_COUNT
  );
}

export async function measureStorageVnextObjectFanout(
  sql: DatabaseClient | TransactionSql,
  input: { knowledgeBaseId: string; candidateRootPublicId: string }
): Promise<StorageVnextObjectFanoutMeasurement> {
  const rows = await sql<Array<{
    source_file_count: number | string;
    active_source_file_count: number | string;
    changed_source_file_count: number | string;
    active_object_count: number | string;
    candidate_object_count: number | string;
    candidate_only_count: number | string;
  }>>`
    SELECT
      COALESCE(summary.source_file_count, 0) AS source_file_count,
      COALESCE((
        SELECT active_summary.source_file_count
        FROM focowiki.release_roots active_root
        JOIN focowiki.knowledge_base_summaries active_summary
          ON active_summary.knowledge_base_id = active_root.knowledge_base_id
         AND active_summary.release_root_public_id = active_root.public_id
        WHERE active_root.knowledge_base_id = ${input.knowledgeBaseId}
          AND active_root.root_role = 'active'
        LIMIT 1
      ), 0) AS active_source_file_count,
      (SELECT count(*)
       FROM focowiki.release_candidates candidate
       JOIN focowiki.release_candidate_changed_facts fact
         ON fact.candidate_public_id = candidate.public_id
        AND fact.knowledge_base_id = candidate.knowledge_base_id
       WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
         AND candidate.candidate_root_public_id = ${input.candidateRootPublicId}
         AND fact.fact_kind = 'source_file') AS changed_source_file_count,
      (SELECT count(DISTINCT released.object_id)
       FROM (
         SELECT entry.object_id
         FROM focowiki.release_roots active_root
         CROSS JOIN LATERAL focowiki.resolve_release_catalog(
           active_root.public_id
         ) entry
         WHERE active_root.knowledge_base_id = ${input.knowledgeBaseId}
           AND active_root.root_role = 'active'
         UNION
         SELECT shard.object_id
         FROM focowiki.release_roots active_root
         CROSS JOIN LATERAL focowiki.resolve_release_shards(
           active_root.public_id
         ) shard
         WHERE active_root.knowledge_base_id = ${input.knowledgeBaseId}
           AND active_root.root_role = 'active'
       ) released) AS active_object_count,
      (SELECT count(DISTINCT released.object_id)
       FROM (
         SELECT entry.object_id
         FROM focowiki.resolve_release_catalog(
           ${input.candidateRootPublicId}
         ) entry
         UNION
         SELECT shard.object_id
         FROM focowiki.resolve_release_shards(
           ${input.candidateRootPublicId}
         ) shard
       ) released) AS candidate_object_count,
      (SELECT count(DISTINCT candidate.object_id)
       FROM focowiki.object_owners candidate
       WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
         AND candidate.release_root_public_id = ${input.candidateRootPublicId}
         AND candidate.owner_kind = 'candidate_root'
         AND NOT EXISTS (
           SELECT 1
           FROM focowiki.object_owners retained
           WHERE retained.knowledge_base_id = ${input.knowledgeBaseId}
             AND retained.object_id = candidate.object_id
             AND retained.owner_kind IN ('active_root', 'rollback_root', 'shared_segment')
         )) AS candidate_only_count
    FROM focowiki.knowledge_base_summaries summary
    WHERE summary.knowledge_base_id = ${input.knowledgeBaseId}
      AND summary.release_root_public_id = ${input.candidateRootPublicId}
  `;
  const row = rows[0];
  return {
    sourceFileCount: Number(row?.source_file_count ?? 0),
    activeSourceFileCount: Number(row?.active_source_file_count ?? 0),
    changedSourceFileCount: Number(row?.changed_source_file_count ?? 0),
    activeGeneratedObjectCount: Number(row?.active_object_count ?? 0),
    candidateGeneratedObjectCount: Number(row?.candidate_object_count ?? 0),
    candidateOnlyObjectCount: Number(row?.candidate_only_count ?? 0)
  };
}
