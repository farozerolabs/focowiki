CREATE TEMP TABLE focowiki_migration_failed_generations
ON COMMIT DROP
AS
WITH terminal_jobs AS (
  SELECT DISTINCT ON (job.generation_id)
         job.generation_id,
         coalesce(job.last_error_message, 'Publication job retries were exhausted.') AS message
  FROM focowiki.role_jobs job
  WHERE job.role = 'publication'
    AND job.kind = 'generation_publication'
    AND job.status = 'dead_letter'
    AND job.generation_id IS NOT NULL
  ORDER BY job.generation_id, job.updated_at DESC, job.id
)
SELECT generation.id AS generation_id,
       generation.knowledge_base_id,
       left(terminal.message, 1000) AS message
FROM focowiki.publication_generations generation
JOIN terminal_jobs terminal ON terminal.generation_id = generation.id
WHERE generation.generation_kind = 'normal'
  AND generation.state IN ('frozen', 'building', 'validating');

UPDATE focowiki.publication_generations generation
SET state = 'failed',
    failed_at = now(),
    safe_error_code = 'PUBLICATION_JOB_DEAD_LETTER',
    safe_error_message = terminal.message,
    updated_at = now()
FROM focowiki_migration_failed_generations terminal
WHERE generation.id = terminal.generation_id
  AND generation.knowledge_base_id = terminal.knowledge_base_id;

UPDATE focowiki.publication_progress progress
SET stage = 'failed',
    safe_error_code = generation.safe_error_code,
    safe_error_message = generation.safe_error_message,
    completed_at = coalesce(generation.failed_at, now()),
    heartbeat_at = coalesce(generation.failed_at, now()),
    updated_at = now()
FROM focowiki.publication_generations generation
JOIN focowiki_migration_failed_generations migrated
  ON migrated.generation_id = generation.id
 AND migrated.knowledge_base_id = generation.knowledge_base_id
WHERE progress.knowledge_base_id = generation.knowledge_base_id
  AND progress.generation_id = generation.id
  AND generation.state = 'failed'
  AND progress.stage <> 'failed';

UPDATE focowiki.publication_impacts impact
SET status = 'cancelled',
    claimed_by = NULL,
    claimed_at = NULL,
    heartbeat_at = NULL,
    completed_at = coalesce(generation.failed_at, now()),
    last_error_code = coalesce(generation.safe_error_code, 'PUBLICATION_GENERATION_FAILED'),
    last_error_message = left(
      coalesce(generation.safe_error_message, 'Publication generation failed.'),
      1000
    ),
    updated_at = now()
FROM focowiki.publication_generations generation
WHERE impact.knowledge_base_id = generation.knowledge_base_id
  AND impact.generation_id = generation.id
  AND generation.state = 'failed'
  AND impact.status IN ('pending', 'running');

UPDATE focowiki.source_files source
SET processing_status = 'failed',
    processing_stage = 'projection_generation',
    processing_ended_at = coalesce(generation.failed_at, now()),
    generated_output_status = 'unavailable',
    terminal_failure_stage = 'projection_generation',
    terminal_failure_code = coalesce(generation.safe_error_code, 'PUBLICATION_GENERATION_FAILED'),
    terminal_failure_message = left(
      coalesce(generation.safe_error_message, 'Publication generation failed.'),
      1000
    ),
    terminal_failure_at = coalesce(generation.failed_at, now()),
    terminal_failure_retry_kind = 'publication',
    terminal_failure_correlation_id = generation.id
FROM focowiki.publication_generations generation
JOIN focowiki_migration_failed_generations migrated
  ON migrated.generation_id = generation.id
 AND migrated.knowledge_base_id = generation.knowledge_base_id
WHERE generation.state = 'failed'
  AND source.knowledge_base_id = generation.knowledge_base_id
  AND source.deleted_at IS NULL
  AND source.task_deleted_at IS NULL
  AND source.deletion_intent_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM focowiki.publication_change_facts fact
    WHERE fact.knowledge_base_id = generation.knowledge_base_id
      AND fact.generation_id = generation.id
      AND fact.source_file_id = source.id
  );

UPDATE focowiki.role_jobs job
SET status = 'queued',
    run_after = now(),
    attempt_count = 0,
    locked_by = NULL,
    locked_at = NULL,
    heartbeat_at = NULL,
    completed_at = NULL,
    failed_at = NULL,
    last_error_code = 'PUBLICATION_RECOVERED_AFTER_UPGRADE',
    last_error_message = 'Publication job was requeued after runtime upgrade.',
    updated_at = now()
FROM focowiki.publication_generations generation
WHERE job.generation_id = generation.id
  AND job.knowledge_base_id = generation.knowledge_base_id
  AND job.role = 'publication'
  AND job.kind = 'generation_publication'
  AND job.status = 'dead_letter'
  AND generation.generation_kind = 'normal'
  AND generation.state = 'open';

UPDATE focowiki.runtime_generation
SET generation = 'bounded-publication-recovery-v3'
WHERE singleton = true
  AND generation = 'tree-graph-storage-reconciliation-v2';
