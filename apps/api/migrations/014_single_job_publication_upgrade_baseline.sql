INSERT INTO focowiki.publication_jobs (
    public_id,
    knowledge_base_id,
    base_active_revision,
    target_readiness_sequence,
    renderer_contract_version,
    settings_snapshot,
    outcome,
    attempt_count,
    next_eligible_at,
    created_at,
    updated_at,
    completed_at
)
SELECT
    'publication-bootstrap-job-' || md5(head.knowledge_base_id),
    head.knowledge_base_id,
    greatest(head.active_revision - 1, 0),
    head.active_readiness_sequence,
    'single-job-upgrade-baseline-v1',
    jsonb_build_object(
      'schemaVersion', 'single-job-upgrade-baseline-v1'
    ),
    'committed',
    0,
    head.updated_at,
    head.updated_at,
    head.updated_at,
    head.updated_at
FROM focowiki.knowledge_base_publication_heads head
WHERE head.active_revision > 0
  AND head.active_job_public_id IS NULL
ON CONFLICT (public_id) DO NOTHING;

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
), recoverable_operations AS (
  SELECT DISTINCT operation.public_id, operation.knowledge_base_id
  FROM recoverable_jobs recoverable
  JOIN focowiki.publication_job_items membership
    ON membership.job_public_id = recoverable.public_id
  JOIN focowiki.publication_items item
    ON item.public_id = membership.item_public_id
  JOIN focowiki.document_processing_jobs document_job
    ON document_job.public_id = item.document_job_public_id
  JOIN focowiki.operations operation
    ON operation.knowledge_base_id = document_job.knowledge_base_id
   AND operation.public_id = document_job.operation_public_id
  JOIN focowiki.operation_results result
    ON result.knowledge_base_id = operation.knowledge_base_id
   AND result.public_id = operation.public_id
   AND result.result_code = 'publication_active_base_changed'
  WHERE operation.state = 'failed'
)
UPDATE focowiki.operations operation
SET state = 'processing', completed_at = NULL, updated_at = now()
FROM recoverable_operations recoverable
WHERE operation.knowledge_base_id = recoverable.knowledge_base_id
  AND operation.public_id = recoverable.public_id;

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
), recoverable_operations AS (
  SELECT DISTINCT operation.public_id, operation.knowledge_base_id
  FROM recoverable_jobs recoverable
  JOIN focowiki.publication_job_items membership
    ON membership.job_public_id = recoverable.public_id
  JOIN focowiki.publication_items item
    ON item.public_id = membership.item_public_id
  JOIN focowiki.document_processing_jobs document_job
    ON document_job.public_id = item.document_job_public_id
  JOIN focowiki.operations operation
    ON operation.knowledge_base_id = document_job.knowledge_base_id
   AND operation.public_id = document_job.operation_public_id
)
DELETE FROM focowiki.operation_results result
USING recoverable_operations recoverable
WHERE result.knowledge_base_id = recoverable.knowledge_base_id
  AND result.public_id = recoverable.public_id
  AND result.result_code = 'publication_active_base_changed';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
), recoverable_deletions AS (
  SELECT DISTINCT item.knowledge_base_id,
         item.affected_evidence->>'deletionOperationPublicId'
           AS operation_public_id
  FROM recoverable_jobs recoverable
  JOIN focowiki.publication_job_items membership
    ON membership.job_public_id = recoverable.public_id
  JOIN focowiki.publication_items item
    ON item.public_id = membership.item_public_id
  WHERE item.affected_evidence ? 'deletionOperationPublicId'
)
UPDATE focowiki.cleanup_actions action
SET state = 'retry', attempt_count = greatest(action.attempt_count - 1, 0),
    lease_owner = NULL, lease_expires_at = NULL, safe_error_code = NULL,
    not_before = now(), completed_at = NULL, updated_at = now()
FROM recoverable_deletions recoverable
WHERE action.knowledge_base_id = recoverable.knowledge_base_id
  AND action.operation_public_id = recoverable.operation_public_id
  AND action.action_kind = 'document_resource_deletion'
  AND action.state = 'failed'
  AND action.safe_error_code = 'publication_active_base_changed';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
)
UPDATE focowiki.document_artifact_work work
SET state = 'waiting_on_projection', lease_owner = NULL,
    lease_expires_at = NULL, next_eligible_at = now(),
    safe_error_code = NULL, safe_error_message = NULL, retryable = false,
    ended_at = NULL, updated_at = now()
FROM recoverable_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
JOIN focowiki.publication_items item
  ON item.public_id = membership.item_public_id
WHERE item.document_job_public_id = work.document_job_public_id
  AND work.work_kind = 'knowledge_projection'
  AND work.state = 'error'
  AND work.safe_error_code = 'publication_active_base_changed';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
)
UPDATE focowiki.document_processing_jobs document_job
SET state = 'processing', active_work_kinds = '{}'::text[],
    blocking_work_kind = 'knowledge_projection', retrying_work_kind = NULL,
    next_attempt_at = NULL, safe_error_code = NULL,
    safe_error_message = NULL, retryable = false,
    failure_count = greatest(document_job.failure_count - 1, 0),
    terminal_at = NULL, revision = document_job.revision + 1,
    updated_at = now()
FROM recoverable_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
JOIN focowiki.publication_items item
  ON item.public_id = membership.item_public_id
WHERE item.document_job_public_id = document_job.public_id
  AND document_job.state = 'error'
  AND document_job.safe_error_code = 'publication_active_base_changed';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
)
UPDATE focowiki.publication_items item
SET outcome = 'pending', safe_error_code = NULL, terminal_at = NULL,
    updated_at = now()
FROM recoverable_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
WHERE membership.item_public_id = item.public_id
  AND item.outcome = 'failed'
  AND item.safe_error_code = 'publication_active_base_changed';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
)
DELETE FROM focowiki.publication_job_items membership
USING recoverable_jobs recoverable
WHERE membership.job_public_id = recoverable.public_id;

WITH recoverable_knowledge_bases AS (
  SELECT DISTINCT job.knowledge_base_id
  FROM focowiki.publication_jobs job
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = job.knowledge_base_id
  WHERE head.active_job_public_id IS NULL
    AND job.outcome = 'failed'
    AND job.safe_error_code = 'publication_active_base_changed'
    AND job.base_active_revision = head.active_revision
), pending AS (
  SELECT item.knowledge_base_id, count(*)::integer AS item_count,
         min(item.created_at) AS oldest_at,
         max(item.created_at) AS latest_at,
         max(item.readiness_sequence) AS latest_sequence
  FROM focowiki.publication_items item
  JOIN recoverable_knowledge_bases recoverable
    ON recoverable.knowledge_base_id = item.knowledge_base_id
  WHERE item.outcome = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM focowiki.publication_job_items membership
      WHERE membership.item_public_id = item.public_id
    )
  GROUP BY item.knowledge_base_id
)
UPDATE focowiki.knowledge_base_publication_heads head
SET pending_item_count = coalesce(pending.item_count, 0),
    oldest_pending_at = pending.oldest_at,
    latest_pending_at = pending.latest_at,
    latest_readiness_sequence = greatest(
      head.latest_readiness_sequence,
      coalesce(pending.latest_sequence, head.latest_readiness_sequence)
    ),
    updated_at = now()
FROM recoverable_knowledge_bases recoverable
LEFT JOIN pending ON pending.knowledge_base_id = recoverable.knowledge_base_id
WHERE head.knowledge_base_id = recoverable.knowledge_base_id;

UPDATE focowiki.knowledge_base_publication_heads head
SET active_job_public_id = bootstrap.public_id
FROM focowiki.publication_jobs bootstrap
WHERE head.active_revision > 0
  AND head.active_job_public_id IS NULL
  AND bootstrap.public_id =
      'publication-bootstrap-job-' || md5(head.knowledge_base_id)
  AND bootstrap.knowledge_base_id = head.knowledge_base_id
  AND bootstrap.outcome = 'committed'
  AND bootstrap.base_active_revision = greatest(head.active_revision - 1, 0)
  AND bootstrap.renderer_contract_version = 'single-job-upgrade-baseline-v1'
  AND bootstrap.target_readiness_sequence = head.active_readiness_sequence;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM focowiki.knowledge_base_publication_heads
    WHERE active_revision > 0 AND active_job_public_id IS NULL
  ) THEN
    RAISE EXCEPTION 'single-job publication upgrade baseline is incomplete'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v22-single-job-publication-upgrade-baseline'
WHERE singleton = true
  AND generation = 'storage-vnext-v21-single-job-publication-foundation';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v22-single-job-publication-upgrade-baseline'
    );
