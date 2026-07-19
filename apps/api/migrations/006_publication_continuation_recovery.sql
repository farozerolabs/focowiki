CREATE TEMP TABLE focowiki_migration_continuation_generations
ON COMMIT DROP
AS
SELECT generation.id AS generation_id,
       generation.knowledge_base_id
FROM focowiki.publication_generations generation
WHERE generation.generation_kind = 'normal'
  AND generation.state = 'failed'
  AND generation.safe_error_code = 'PUBLICATION_RETRIES_EXHAUSTED'
  AND generation.safe_error_message IN (
    'Publication impacts are pending',
    'Publication was interrupted',
    'Publication generation state changed',
    'Publication activation must be retried',
    'Immutable object write is already in progress'
  );

UPDATE focowiki.publication_impacts impact
SET status = 'pending',
    run_after = now(),
    attempt_count = 0,
    claimed_by = NULL,
    claimed_at = NULL,
    heartbeat_at = NULL,
    completed_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
FROM focowiki_migration_continuation_generations migrated
WHERE impact.knowledge_base_id = migrated.knowledge_base_id
  AND impact.generation_id = migrated.generation_id
  AND impact.status IN ('failed', 'cancelled');

UPDATE focowiki.publication_progress progress
SET stage = 'pending',
    processed_impact_count = counts.completed_count,
    heartbeat_at = now(),
    completed_at = NULL,
    safe_error_code = NULL,
    safe_error_message = NULL,
    updated_at = now()
FROM (
  SELECT migrated.knowledge_base_id,
         migrated.generation_id,
         count(*) FILTER (WHERE impact.status = 'completed')::bigint AS completed_count
  FROM focowiki_migration_continuation_generations migrated
  LEFT JOIN focowiki.publication_impacts impact
    ON impact.knowledge_base_id = migrated.knowledge_base_id
   AND impact.generation_id = migrated.generation_id
  GROUP BY migrated.knowledge_base_id, migrated.generation_id
) counts
WHERE progress.knowledge_base_id = counts.knowledge_base_id
  AND progress.generation_id = counts.generation_id;

UPDATE focowiki.role_jobs job
SET status = 'queued',
    run_after = now(),
    attempt_count = 0,
    locked_by = NULL,
    locked_at = NULL,
    heartbeat_at = NULL,
    completed_at = NULL,
    failed_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
FROM focowiki_migration_continuation_generations migrated
WHERE job.knowledge_base_id = migrated.knowledge_base_id
  AND job.generation_id = migrated.generation_id
  AND job.role = 'publication'
  AND job.kind = 'generation_publication'
  AND job.status IN ('failed', 'dead_letter', 'cancelled');

UPDATE focowiki.source_files source
SET processing_status = 'completed',
    processing_stage = 'projection_generation',
    processing_ended_at = now(),
    generated_output_status = 'pending',
    terminal_failure_stage = NULL,
    terminal_failure_code = NULL,
    terminal_failure_message = NULL,
    terminal_failure_at = NULL,
    terminal_failure_retry_kind = NULL,
    terminal_failure_correlation_id = NULL
FROM focowiki_migration_continuation_generations migrated
WHERE source.knowledge_base_id = migrated.knowledge_base_id
  AND source.deleted_at IS NULL
  AND source.task_deleted_at IS NULL
  AND source.deletion_intent_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM focowiki.publication_change_facts fact
    WHERE fact.knowledge_base_id = migrated.knowledge_base_id
      AND fact.generation_id = migrated.generation_id
      AND fact.source_file_id = source.id
  );

UPDATE focowiki.runtime_generation
SET generation = 'publication-continuation-recovery-v6'
WHERE singleton = true
  AND generation = 'publication-retry-budget-recovery-v5';
