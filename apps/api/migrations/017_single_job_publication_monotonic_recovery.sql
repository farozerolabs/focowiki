UPDATE focowiki.publication_jobs
SET attempt_owner = NULL,
    attempt_token = NULL,
    attempt_started_at = NULL,
    attempt_deadline = NULL,
    attempt_count = 0,
    manifest_fingerprint_sha256 = NULL,
    manifest_attempt_token = NULL,
    next_eligible_at = now(),
    safe_error_code = NULL,
    updated_at = now()
WHERE outcome = 'pending';

WITH recoverable_jobs AS (
  SELECT public_id
  FROM focowiki.publication_jobs
  WHERE outcome = 'failed'
    AND safe_error_code = 'publication_page_owner_revision_stale'
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
UPDATE focowiki.operations operation
SET state = 'processing', completed_at = NULL, updated_at = now()
FROM recoverable_operations recoverable
WHERE operation.knowledge_base_id = recoverable.knowledge_base_id
  AND operation.public_id = recoverable.public_id
  AND operation.state = 'failed';

WITH recoverable_jobs AS (
  SELECT public_id
  FROM focowiki.publication_jobs
  WHERE outcome = 'failed'
    AND safe_error_code = 'publication_page_owner_revision_stale'
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
  AND result.result_code = 'publication_page_owner_revision_stale';

WITH recoverable_jobs AS (
  SELECT public_id
  FROM focowiki.publication_jobs
  WHERE outcome = 'failed'
    AND safe_error_code = 'publication_page_owner_revision_stale'
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
  AND action.safe_error_code = 'publication_page_owner_revision_stale';

WITH recoverable_jobs AS (
  SELECT public_id
  FROM focowiki.publication_jobs
  WHERE outcome = 'failed'
    AND safe_error_code = 'publication_page_owner_revision_stale'
)
UPDATE focowiki.document_artifact_work work
SET state = CASE work.work_kind
      WHEN 'knowledge_projection' THEN 'waiting_on_projection'
      ELSE 'waiting'
    END,
    lease_owner = NULL, lease_expires_at = NULL,
    next_eligible_at = now(), ended_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false, updated_at = now()
FROM recoverable_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
JOIN focowiki.publication_items item
  ON item.public_id = membership.item_public_id
WHERE item.document_job_public_id = work.document_job_public_id
  AND ((work.work_kind = 'knowledge_projection'
        AND work.state IN ('waiting_on_projection', 'error'))
    OR (work.work_kind = 'activate'
        AND work.state IN ('waiting', 'error')));

WITH recoverable_jobs AS (
  SELECT public_id
  FROM focowiki.publication_jobs
  WHERE outcome = 'failed'
    AND safe_error_code = 'publication_page_owner_revision_stale'
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
  AND document_job.safe_error_code = 'publication_page_owner_revision_stale';

WITH recoverable_jobs AS MATERIALIZED (
  SELECT public_id
  FROM focowiki.publication_jobs
  WHERE outcome = 'failed'
    AND safe_error_code = 'publication_page_owner_revision_stale'
), recoverable_items AS MATERIALIZED (
  SELECT item.public_id, item.knowledge_base_id,
         item.readiness_sequence
  FROM recoverable_jobs recoverable
  JOIN focowiki.publication_job_items membership
    ON membership.job_public_id = recoverable.public_id
  JOIN focowiki.publication_items item
    ON item.public_id = membership.item_public_id
  WHERE item.outcome = 'failed'
    AND item.safe_error_code = 'publication_page_owner_revision_stale'
), sequence_bases AS (
  SELECT recoverable.knowledge_base_id,
         greatest(
           head.active_readiness_sequence,
           head.latest_readiness_sequence,
           coalesce(max(existing.readiness_sequence), 0)
         ) AS base_sequence
  FROM (SELECT DISTINCT knowledge_base_id FROM recoverable_items) recoverable
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = recoverable.knowledge_base_id
  LEFT JOIN focowiki.publication_items existing
    ON existing.knowledge_base_id = recoverable.knowledge_base_id
  GROUP BY recoverable.knowledge_base_id,
           head.active_readiness_sequence,
           head.latest_readiness_sequence
), rebased AS (
  SELECT item.public_id,
         base.base_sequence + row_number() OVER (
           PARTITION BY item.knowledge_base_id
           ORDER BY item.readiness_sequence, item.public_id COLLATE "C"
         ) AS readiness_sequence
  FROM recoverable_items item
  JOIN sequence_bases base
    ON base.knowledge_base_id = item.knowledge_base_id
)
UPDATE focowiki.publication_items item
SET readiness_sequence = rebased.readiness_sequence,
    outcome = 'pending', safe_error_code = NULL,
    terminal_at = NULL, updated_at = now()
FROM rebased
WHERE item.public_id = rebased.public_id;

WITH recoverable_jobs AS (
  SELECT public_id
  FROM focowiki.publication_jobs
  WHERE outcome = 'failed'
    AND safe_error_code = 'publication_page_owner_revision_stale'
)
DELETE FROM focowiki.publication_job_items membership
USING recoverable_jobs recoverable
WHERE membership.job_public_id = recoverable.public_id;

WITH recoverable_knowledge_bases AS (
  SELECT DISTINCT job.knowledge_base_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_page_owner_revision_stale'
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

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v25-single-job-publication-monotonic-recovery'
WHERE singleton = true
  AND generation = 'storage-vnext-v24-single-job-publication-scale-safety';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation =
        'storage-vnext-v25-single-job-publication-monotonic-recovery'
    );
