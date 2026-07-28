import type { DatabaseClient } from "./client.js";

const MAX_REPORTED_COUNT = 1_000_000;

type MigrationWorkRow = {
  source_files: number | string;
  dispatch_markers: number | string;
  role_jobs: number | string;
  publication_impacts: number | string;
  frozen_generations: number | string;
  resource_operations: number | string;
  deletion_intents: number | string;
  upload_sessions: number | string;
  cleanup_objects: number | string;
  maintenance_candidate_generations: number | string;
  capped: boolean;
};

type MigrationCapabilitiesRow = {
  maintenance_requests: boolean;
  projection_repairs: boolean;
  projection_repair_subtasks: boolean;
  lexical_rebuilds: boolean;
  lexical_rebuild_work_items: boolean;
  projection_compactions: boolean;
};

type BoundedCountRow = {
  count: number | string;
  capped: boolean;
};

export type MigrationWorkSnapshot = {
  sourceFiles: number;
  dispatchMarkers: number;
  roleJobs: number;
  publicationImpacts: number;
  frozenGenerations: number;
  resourceOperations: number;
  deletionIntents: number;
  uploadSessions: number;
  cleanupObjects: number;
  knowledgeBaseMaintenanceRequests: number;
  projectionRepairs: number;
  lexicalRebuilds: number;
  projectionCompactions: number;
  maintenanceCandidateGenerations: number;
  total: number;
  capped: boolean;
};

export class MigrationWorkNotDrainedError extends Error {
  public readonly code = "MIGRATION_WORK_NOT_DRAINED";

  public constructor(public readonly snapshot: MigrationWorkSnapshot) {
    super(
      "Database migration requires all asynchronous work to finish before services stop. "
      + `Safe unfinished counts: ${JSON.stringify(snapshot)}`
    );
    this.name = "MigrationWorkNotDrainedError";
  }
}

export async function assertMigrationWorkDrained(sql: DatabaseClient): Promise<void> {
  const snapshot = await inspectMigrationWork(sql);
  if (snapshot.total > 0) throw new MigrationWorkNotDrainedError(snapshot);
}

export async function inspectMigrationWork(
  sql: DatabaseClient
): Promise<MigrationWorkSnapshot> {
  const capabilities = await inspectMigrationCapabilities(sql);
  const rows = await sql<MigrationWorkRow[]>`
    WITH resumable_deletions AS MATERIALIZED (
      SELECT DISTINCT
             intent.id AS deletion_intent_id,
             operation.id AS operation_id,
             hard_delete.id AS role_job_id,
             generation.id AS generation_id
      FROM focowiki.deletion_intents intent
      JOIN focowiki.resource_operation_targets target
        ON target.target_kind = intent.target_kind
       AND target.target_id = intent.target_id
      JOIN focowiki.resource_operations operation
        ON operation.id = target.operation_id
       AND operation.knowledge_base_id = intent.knowledge_base_id
      JOIN focowiki.role_jobs hard_delete
        ON hard_delete.knowledge_base_id = intent.knowledge_base_id
       AND hard_delete.role = 'maintenance'
       AND hard_delete.kind = 'hard_delete'
       AND hard_delete.payload_json->>'deletionIntentId' = intent.id
      JOIN focowiki.publication_change_facts owned_fact
        ON owned_fact.knowledge_base_id = intent.knowledge_base_id
       AND owned_fact.operation_id = operation.id
       AND owned_fact.deletion_intent_id = intent.id
      JOIN focowiki.publication_generations generation
        ON generation.id = owned_fact.generation_id
       AND generation.knowledge_base_id = intent.knowledge_base_id
       AND coalesce(
             to_jsonb(generation)->>'generation_kind',
             'normal'
           ) = 'normal'
      WHERE intent.state IN ('accepted', 'running')
        AND operation.state = 'publishing'
        AND hard_delete.status IN ('queued', 'running')
        AND (
          generation.state = 'frozen'
          OR (
            generation.state = 'failed'
            AND (
              generation.safe_error_message LIKE '%DIRECTORY_NAVIGATION_COUNT_MISMATCH:%'
              OR generation.safe_error_message LIKE '%DIRECTORY_STATISTICS_MISMATCH:%'
            )
            AND EXISTS (
              SELECT 1
              FROM focowiki.publication_generations repair_generation
              WHERE repair_generation.knowledge_base_id = intent.knowledge_base_id
                AND repair_generation.predecessor_generation_id =
                      generation.predecessor_generation_id
                AND coalesce(
                      to_jsonb(repair_generation)->>'generation_kind',
                      'normal'
                    ) = 'projection_repair'
                AND repair_generation.state IN ('frozen', 'building', 'validating')
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.publication_change_facts fact
          WHERE fact.knowledge_base_id = generation.knowledge_base_id
            AND fact.generation_id = generation.id
            AND NOT (
              (
                coalesce(
                  to_jsonb(fact) -> 'planning_payload_json',
                  '{}'::jsonb
                ) ? 'preplannedImpacts'
                AND jsonb_typeof(
                  coalesce(
                    to_jsonb(fact) -> 'planning_payload_json',
                    '{}'::jsonb
                  ) -> 'preplannedImpacts'
                ) = 'array'
              )
              OR (
                coalesce(
                  to_jsonb(fact) -> 'planning_payload_json',
                  '{}'::jsonb
                ) ? 'impactPlanner'
                AND jsonb_typeof(
                  coalesce(
                    to_jsonb(fact) -> 'planning_payload_json',
                    '{}'::jsonb
                  ) -> 'impactPlanner'
                ) = 'object'
              )
            )
        )
        AND (
          (
            intent.target_kind = 'source_file'
            AND operation.operation_kind = 'source_file_delete'
            AND owned_fact.kind = 'source_deleted'
            AND hard_delete.payload_json->>'targetKind' = 'source_file'
            AND hard_delete.payload_json->>'sourceFileId' = intent.target_id
            AND EXISTS (
              SELECT 1
              FROM focowiki.source_files source
              WHERE source.id = intent.target_id
                AND source.knowledge_base_id = intent.knowledge_base_id
                AND source.deletion_intent_id = intent.id
                AND source.deleted_at IS NOT NULL
            )
          )
          OR (
            intent.target_kind = 'source_directory'
            AND operation.operation_kind = 'source_directory_delete'
            AND owned_fact.kind = 'directory_deleted'
            AND hard_delete.payload_json->>'targetKind' = 'source_directory'
            AND hard_delete.payload_json->>'sourceDirectoryId' = intent.target_id
            AND EXISTS (
              SELECT 1
              FROM focowiki.source_directories directory
              WHERE directory.id = intent.target_id
                AND directory.knowledge_base_id = intent.knowledge_base_id
                AND directory.deletion_intent_id = intent.id
                AND directory.deleted_at IS NOT NULL
            )
          )
        )
    ),
    counts AS (
      SELECT
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.source_files
          WHERE processing_status IN ('queued', 'running')
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_source_files) AS source_files,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.source_dispatch_markers
          WHERE status IN ('pending', 'claimed')
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_dispatch_markers) AS dispatch_markers,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.role_jobs job
          WHERE job.status IN ('queued', 'running')
            AND NOT EXISTS (
              SELECT 1
              FROM resumable_deletions deletion
              WHERE deletion.role_job_id = job.id
            )
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_role_jobs) AS role_jobs,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.publication_impacts
          WHERE status IN ('pending', 'running')
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_publication_impacts) AS publication_impacts,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.publication_generations generation
          WHERE coalesce(
              to_jsonb(generation)->>'generation_kind',
              'normal'
            ) NOT IN ('projection_repair', 'lexical_rebuild')
            AND (
              generation.state IN ('frozen', 'building', 'validating')
              OR (generation.state = 'open' AND EXISTS (
                SELECT 1 FROM focowiki.publication_change_facts fact
                WHERE fact.generation_id = generation.id
              ))
            )
            AND NOT EXISTS (
              SELECT 1
              FROM resumable_deletions deletion
              WHERE deletion.generation_id = generation.id
            )
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_frozen_generations) AS frozen_generations,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.resource_operations operation
          WHERE operation.state IN (
              'accepted', 'validating', 'processing', 'publishing'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM resumable_deletions deletion
              WHERE deletion.operation_id = operation.id
            )
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_resource_operations) AS resource_operations,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.deletion_intents intent
          WHERE intent.state IN ('accepted', 'running')
            AND NOT EXISTS (
              SELECT 1
              FROM resumable_deletions deletion
              WHERE deletion.deletion_intent_id = intent.id
            )
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_deletion_intents) AS deletion_intents,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.upload_sessions
          WHERE state IN (
              'draft', 'manifest_building', 'manifest_sealed',
              'uploading', 'finalizing'
            )
            AND expires_at > now()
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_upload_sessions) AS upload_sessions,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.cleanup_object_deletions
          WHERE status = 'pending'
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_cleanup_objects) AS cleanup_objects,
        (SELECT count(*) FROM (
          SELECT 1 FROM focowiki.publication_generations generation
          WHERE coalesce(
              to_jsonb(generation)->>'generation_kind',
              'normal'
            ) IN ('projection_repair', 'lexical_rebuild')
            AND generation.state IN ('frozen', 'building', 'validating')
          LIMIT ${MAX_REPORTED_COUNT + 1}
        ) bounded_maintenance_generations) AS maintenance_candidate_generations
    )
    SELECT
      least(source_files, ${MAX_REPORTED_COUNT})::int AS source_files,
      least(dispatch_markers, ${MAX_REPORTED_COUNT})::int AS dispatch_markers,
      least(role_jobs, ${MAX_REPORTED_COUNT})::int AS role_jobs,
      least(publication_impacts, ${MAX_REPORTED_COUNT})::int AS publication_impacts,
      least(frozen_generations, ${MAX_REPORTED_COUNT})::int AS frozen_generations,
      least(resource_operations, ${MAX_REPORTED_COUNT})::int AS resource_operations,
      least(deletion_intents, ${MAX_REPORTED_COUNT})::int AS deletion_intents,
      least(upload_sessions, ${MAX_REPORTED_COUNT})::int AS upload_sessions,
      least(cleanup_objects, ${MAX_REPORTED_COUNT})::int AS cleanup_objects,
      least(
        maintenance_candidate_generations,
        ${MAX_REPORTED_COUNT}
      )::int AS maintenance_candidate_generations,
      greatest(
        source_files, dispatch_markers, role_jobs, publication_impacts,
        frozen_generations, resource_operations, deletion_intents,
        upload_sessions, cleanup_objects, maintenance_candidate_generations
      ) > ${MAX_REPORTED_COUNT} AS capped
    FROM counts
  `;
  const row = rows[0];
  const optionalWork = await inspectOptionalMigrationWork(sql, capabilities);
  const snapshot = {
    sourceFiles: number(row?.source_files),
    dispatchMarkers: number(row?.dispatch_markers),
    roleJobs: number(row?.role_jobs),
    publicationImpacts: number(row?.publication_impacts),
    frozenGenerations: number(row?.frozen_generations),
    resourceOperations: number(row?.resource_operations),
    deletionIntents: number(row?.deletion_intents),
    uploadSessions: number(row?.upload_sessions),
    cleanupObjects: number(row?.cleanup_objects),
    maintenanceCandidateGenerations: number(
      row?.maintenance_candidate_generations
    ),
    ...optionalWork,
    capped: (row?.capped ?? false) || optionalWork.capped
  };
  return {
    ...snapshot,
    total: snapshot.sourceFiles
      + snapshot.dispatchMarkers
      + snapshot.roleJobs
      + snapshot.publicationImpacts
      + snapshot.frozenGenerations
      + snapshot.resourceOperations
      + snapshot.deletionIntents
      + snapshot.uploadSessions
      + snapshot.cleanupObjects
      + snapshot.knowledgeBaseMaintenanceRequests
      + snapshot.projectionRepairs
      + snapshot.lexicalRebuilds
      + snapshot.projectionCompactions
      + snapshot.maintenanceCandidateGenerations
  };
}

async function inspectMigrationCapabilities(
  sql: DatabaseClient
): Promise<MigrationCapabilitiesRow> {
  const rows = await sql<MigrationCapabilitiesRow[]>`
    SELECT
      to_regclass(
        'focowiki.knowledge_base_index_maintenance_requests'
      ) IS NOT NULL AS maintenance_requests,
      to_regclass(
        'focowiki.knowledge_base_projection_repairs'
      ) IS NOT NULL AS projection_repairs,
      to_regclass(
        'focowiki.projection_repair_subtasks'
      ) IS NOT NULL AS projection_repair_subtasks,
      to_regclass(
        'focowiki.knowledge_base_lexical_rebuilds'
      ) IS NOT NULL AS lexical_rebuilds,
      to_regclass(
        'focowiki.lexical_rebuild_work_items'
      ) IS NOT NULL AS lexical_rebuild_work_items,
      to_regclass(
        'focowiki.projection_compaction_jobs'
      ) IS NOT NULL AS projection_compactions
    FROM (SELECT 1) AS migration_capabilities
  `;
  return rows[0] ?? {
    maintenance_requests: false,
    projection_repairs: false,
    projection_repair_subtasks: false,
    lexical_rebuilds: false,
    lexical_rebuild_work_items: false,
    projection_compactions: false
  };
}

async function inspectOptionalMigrationWork(
  sql: DatabaseClient,
  capabilities: MigrationCapabilitiesRow
): Promise<{
  knowledgeBaseMaintenanceRequests: number;
  projectionRepairs: number;
  lexicalRebuilds: number;
  projectionCompactions: number;
  capped: boolean;
}> {
  const maintenanceRequests = capabilities.maintenance_requests
    ? await countMaintenanceRequests(sql)
    : emptyCount();
  const projectionRepairs = capabilities.projection_repairs
    ? capabilities.projection_repair_subtasks
      ? await countProjectionRepairsAndSubtasks(sql)
      : await countProjectionRepairs(sql)
    : emptyCount();
  const lexicalRebuilds = capabilities.lexical_rebuilds
    ? capabilities.lexical_rebuild_work_items
      ? await countLexicalRebuildsAndWork(sql)
      : await countLexicalRebuilds(sql)
    : emptyCount();
  const projectionCompactions = capabilities.projection_compactions
    ? await countProjectionCompactions(sql)
    : emptyCount();

  return {
    knowledgeBaseMaintenanceRequests: maintenanceRequests.count,
    projectionRepairs: projectionRepairs.count,
    lexicalRebuilds: lexicalRebuilds.count,
    projectionCompactions: projectionCompactions.count,
    capped: maintenanceRequests.capped
      || projectionRepairs.capped
      || lexicalRebuilds.capped
      || projectionCompactions.capped
  };
}

async function countMaintenanceRequests(
  sql: DatabaseClient
): Promise<BoundedCount> {
  const rows = await sql<BoundedCountRow[]>`
    WITH active_maintenance_requests AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.knowledge_base_index_maintenance_requests
        WHERE state IN ('queued', 'planning', 'running', 'validating')
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_maintenance_requests
    )
    SELECT
      least(count, ${MAX_REPORTED_COUNT})::int AS count,
      count > ${MAX_REPORTED_COUNT} AS capped
    FROM active_maintenance_requests
  `;
  return boundedCount(rows[0]);
}

async function countProjectionRepairs(
  sql: DatabaseClient
): Promise<BoundedCount> {
  const rows = await sql<BoundedCountRow[]>`
    WITH active_projection_repairs AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.knowledge_base_projection_repairs
        WHERE state IN ('pending', 'running', 'retry')
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_projection_repairs
    )
    SELECT
      least(count, ${MAX_REPORTED_COUNT})::int AS count,
      count > ${MAX_REPORTED_COUNT} AS capped
    FROM active_projection_repairs
  `;
  return boundedCount(rows[0]);
}

async function countProjectionRepairsAndSubtasks(
  sql: DatabaseClient
): Promise<BoundedCount> {
  const rows = await sql<BoundedCountRow[]>`
    WITH active_projection_repairs AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.knowledge_base_projection_repairs
        WHERE state IN ('pending', 'running', 'retry')
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_projection_repairs
    ),
    active_projection_repair_subtasks AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.projection_repair_subtasks
        WHERE state IN ('pending', 'running', 'retry')
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_projection_repair_subtasks
    ),
    active_projection_repair_work AS (
      SELECT repair.count + subtask.count AS count
      FROM active_projection_repairs repair
      CROSS JOIN active_projection_repair_subtasks subtask
    )
    SELECT
      least(count, ${MAX_REPORTED_COUNT})::int AS count,
      count > ${MAX_REPORTED_COUNT} AS capped
    FROM active_projection_repair_work
  `;
  return boundedCount(rows[0]);
}

async function countLexicalRebuilds(
  sql: DatabaseClient
): Promise<BoundedCount> {
  const rows = await sql<BoundedCountRow[]>`
    WITH active_lexical_rebuilds AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.knowledge_base_lexical_rebuilds
        WHERE (
          state IN ('pending', 'running', 'validating', 'activating')
          OR (state = 'failed' AND attempt_count < max_attempts)
        )
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_lexical_rebuilds
    )
    SELECT
      least(count, ${MAX_REPORTED_COUNT})::int AS count,
      count > ${MAX_REPORTED_COUNT} AS capped
    FROM active_lexical_rebuilds
  `;
  return boundedCount(rows[0]);
}

async function countLexicalRebuildsAndWork(
  sql: DatabaseClient
): Promise<BoundedCount> {
  const rows = await sql<BoundedCountRow[]>`
    WITH active_lexical_rebuilds AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.knowledge_base_lexical_rebuilds
        WHERE (
          state IN ('pending', 'running', 'validating', 'activating')
          OR (state = 'failed' AND attempt_count < max_attempts)
        )
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_lexical_rebuilds
    ),
    active_lexical_rebuild_work_items AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.lexical_rebuild_work_items
        WHERE state IN ('pending', 'running', 'retry')
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_lexical_rebuild_work_items
    ),
    active_lexical_rebuild_work AS (
      SELECT rebuild.count + item.count AS count
      FROM active_lexical_rebuilds rebuild
      CROSS JOIN active_lexical_rebuild_work_items item
    )
    SELECT
      least(count, ${MAX_REPORTED_COUNT})::int AS count,
      count > ${MAX_REPORTED_COUNT} AS capped
    FROM active_lexical_rebuild_work
  `;
  return boundedCount(rows[0]);
}

async function countProjectionCompactions(
  sql: DatabaseClient
): Promise<BoundedCount> {
  const rows = await sql<BoundedCountRow[]>`
    WITH active_projection_compactions AS (
      SELECT count(*) AS count
      FROM (
        SELECT 1
        FROM focowiki.projection_compaction_jobs
        WHERE state IN ('pending', 'running')
        LIMIT ${MAX_REPORTED_COUNT + 1}
      ) bounded_projection_compactions
    )
    SELECT
      least(count, ${MAX_REPORTED_COUNT})::int AS count,
      count > ${MAX_REPORTED_COUNT} AS capped
    FROM active_projection_compactions
  `;
  return boundedCount(rows[0]);
}

type BoundedCount = {
  count: number;
  capped: boolean;
};

function boundedCount(row: BoundedCountRow | undefined): BoundedCount {
  return {
    count: number(row?.count),
    capped: row?.capped ?? false
  };
}

function emptyCount(): BoundedCount {
  return { count: 0, capped: false };
}

function number(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
