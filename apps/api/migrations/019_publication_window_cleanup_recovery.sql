CREATE TEMPORARY TABLE retired_publication_cleanup_actions ON COMMIT DROP AS
SELECT public_id, resource_public_id, state
FROM focowiki.cleanup_actions
WHERE action_kind = 'zero_owner_object'
  AND checkpoint ->> 'schemaVersion' = 'publication-job-output-v1'
  AND state IN ('queued', 'running', 'retry');

UPDATE focowiki.cleanup_actions action
SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
    safe_error_code = NULL, completed_at = coalesce(completed_at, now()),
    updated_at = now()
FROM retired_publication_cleanup_actions retired
WHERE action.public_id = retired.public_id;

INSERT INTO focowiki.cleanup_actions (
  public_id, knowledge_base_id, action_kind, cleanup_plane,
  resource_kind, resource_public_id, required, priority,
  sequence_number, idempotency_key, request_hash, checkpoint,
  state, attempt_count, maximum_attempts, not_before,
  created_at, updated_at
)
SELECT 'cleanup-publication-job-output-v2-migration-' || md5(
         retired.public_id || chr(31) || retired.resource_public_id
       ), legacy.knowledge_base_id, 'zero_owner_object',
       'object_storage', 'zero_owner_object', retired.resource_public_id,
       true, 40,
       row_number() OVER (
         ORDER BY retired.resource_public_id COLLATE "C"
       )::integer,
       'publication-job-output-v2:migration:' || md5(retired.public_id),
       md5(retired.resource_public_id || chr(31) || retired.public_id),
       jsonb_build_object(
         'schemaVersion', 'publication-job-output-v2',
         'migratedFrom', retired.public_id
       ),
       'queued', 0, 8,
       CASE WHEN retired.state = 'running' THEN now()
            ELSE now() + interval '1 day' END,
       now(), now()
FROM retired_publication_cleanup_actions retired
JOIN focowiki.cleanup_actions legacy ON legacy.public_id = retired.public_id
JOIN focowiki.object_registrations registration
  ON registration.object_id = retired.resource_public_id
 AND (
   registration.state = 'verified'
   OR (retired.state = 'running' AND registration.state = 'deleting')
 )
ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING;

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

CREATE TEMPORARY TABLE recoverable_publication_jobs ON COMMIT DROP AS
SELECT public_id
FROM focowiki.publication_jobs
WHERE outcome = 'failed'
  AND safe_error_code IN (
    'previous_state_invalid',
    'publication_attempt_limit_exceeded',
    'navigation_chain_invalid',
    'publication_object_metadata_missing'
  );

CREATE TEMPORARY TABLE recoverable_publication_items ON COMMIT DROP AS
SELECT item.public_id, item.knowledge_base_id,
       item.document_job_public_id, item.affected_evidence
FROM recoverable_publication_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
JOIN focowiki.publication_items item
  ON item.public_id = membership.item_public_id;

UPDATE focowiki.operations operation
SET state = 'processing', completed_at = NULL, updated_at = now()
FROM recoverable_publication_items item
JOIN focowiki.document_processing_jobs document_job
  ON document_job.public_id = item.document_job_public_id
WHERE operation.knowledge_base_id = document_job.knowledge_base_id
  AND operation.public_id = document_job.operation_public_id
  AND operation.state = 'failed';

DELETE FROM focowiki.operation_results result
USING recoverable_publication_items item,
      focowiki.document_processing_jobs document_job
WHERE document_job.public_id = item.document_job_public_id
  AND result.knowledge_base_id = document_job.knowledge_base_id
  AND result.public_id = document_job.operation_public_id
  AND result.result_code IN (
    'previous_state_invalid',
    'publication_attempt_limit_exceeded',
    'navigation_chain_invalid',
    'publication_object_metadata_missing'
  );

UPDATE focowiki.cleanup_actions action
SET state = 'retry', attempt_count = greatest(action.attempt_count - 1, 0),
    lease_owner = NULL, lease_expires_at = NULL, safe_error_code = NULL,
    not_before = now(), completed_at = NULL, updated_at = now()
FROM recoverable_publication_items item
WHERE item.affected_evidence ? 'deletionOperationPublicId'
  AND action.knowledge_base_id = item.knowledge_base_id
  AND action.operation_public_id
        = item.affected_evidence->>'deletionOperationPublicId'
  AND action.action_kind = 'document_resource_deletion'
  AND action.state = 'failed'
  AND action.safe_error_code IN (
    'previous_state_invalid',
    'publication_attempt_limit_exceeded',
    'navigation_chain_invalid',
    'publication_object_metadata_missing'
  );

UPDATE focowiki.document_artifact_work work
SET state = CASE work.work_kind
      WHEN 'knowledge_projection' THEN 'waiting_on_projection'
      ELSE 'waiting'
    END,
    lease_owner = NULL, lease_expires_at = NULL,
    next_eligible_at = now(), ended_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false, updated_at = now()
FROM recoverable_publication_items item
WHERE item.document_job_public_id = work.document_job_public_id
  AND work.work_kind IN ('knowledge_projection', 'activate')
  AND work.state = 'error'
  AND work.safe_error_code IN (
    'previous_state_invalid',
    'publication_attempt_limit_exceeded',
    'navigation_chain_invalid',
    'publication_object_metadata_missing'
  );

UPDATE focowiki.document_processing_jobs document_job
SET state = 'processing', active_work_kinds = '{}'::text[],
    blocking_work_kind = 'knowledge_projection', retrying_work_kind = NULL,
    next_attempt_at = NULL, safe_error_code = NULL,
    safe_error_message = NULL, retryable = false,
    failure_count = greatest(document_job.failure_count - 1, 0),
    terminal_at = NULL, revision = document_job.revision + 1,
    updated_at = now()
FROM recoverable_publication_items item
WHERE item.document_job_public_id = document_job.public_id
  AND document_job.state = 'error'
  AND document_job.safe_error_code IN (
    'previous_state_invalid',
    'publication_attempt_limit_exceeded',
    'navigation_chain_invalid',
    'publication_object_metadata_missing'
  );

UPDATE focowiki.publication_items item
SET outcome = 'pending', safe_error_code = NULL, terminal_at = NULL,
    updated_at = now()
FROM recoverable_publication_items recoverable
WHERE recoverable.public_id = item.public_id
  AND item.outcome = 'failed'
  AND item.safe_error_code IN (
    'previous_state_invalid',
    'publication_attempt_limit_exceeded',
    'navigation_chain_invalid',
    'publication_object_metadata_missing'
  );

DELETE FROM focowiki.publication_job_items membership
USING recoverable_publication_jobs recoverable
WHERE membership.job_public_id = recoverable.public_id;

WITH recoverable_knowledge_bases AS (
  SELECT DISTINCT knowledge_base_id
  FROM recoverable_publication_items
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
SET generation = 'storage-vnext-v27-publication-window-cleanup-recovery'
WHERE singleton = true
  AND generation = 'storage-vnext-v26-navigation-chain-reconciliation';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v27-publication-window-cleanup-recovery'
    );
