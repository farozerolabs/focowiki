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
  const rows = await sql<MigrationWorkRow[]>`
    WITH counts AS (
      SELECT
        (SELECT count(*) FROM focowiki.source_files
         WHERE processing_status IN ('queued', 'running')) AS source_files,
        (SELECT count(*) FROM focowiki.source_dispatch_markers
         WHERE status IN ('pending', 'claimed')) AS dispatch_markers,
        (SELECT count(*) FROM focowiki.role_jobs
         WHERE status IN ('queued', 'running')) AS role_jobs,
        (SELECT count(*) FROM focowiki.publication_impacts
         WHERE status IN ('pending', 'running')) AS publication_impacts,
        (SELECT count(*) FROM focowiki.publication_generations generation
         WHERE generation.state IN ('frozen', 'building', 'validating')
            OR (generation.state = 'open' AND EXISTS (
              SELECT 1 FROM focowiki.publication_change_facts fact
              WHERE fact.generation_id = generation.id
            ))) AS frozen_generations,
        (SELECT count(*) FROM focowiki.resource_operations
         WHERE state IN ('accepted', 'validating', 'processing', 'publishing')) AS resource_operations,
        (SELECT count(*) FROM focowiki.deletion_intents
         WHERE state IN ('accepted', 'running')) AS deletion_intents,
        (SELECT count(*) FROM focowiki.upload_sessions
         WHERE state IN ('draft', 'manifest_building', 'manifest_sealed', 'uploading', 'finalizing')) AS upload_sessions,
        (SELECT count(*) FROM focowiki.cleanup_object_deletions
         WHERE status = 'pending') AS cleanup_objects
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
      greatest(
        source_files, dispatch_markers, role_jobs, publication_impacts,
        frozen_generations, resource_operations, deletion_intents,
        upload_sessions, cleanup_objects
      ) > ${MAX_REPORTED_COUNT} AS capped
    FROM counts
  `;
  const row = rows[0];
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
    capped: row?.capped ?? false
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
  };
}

function number(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
