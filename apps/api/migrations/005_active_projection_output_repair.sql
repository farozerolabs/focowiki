ALTER TABLE focowiki.document_processing_jobs
    ADD COLUMN processing_generation text
    DEFAULT 'document-indexing-v12' NOT NULL;

ALTER TABLE focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_generation_check CHECK (
        processing_generation <> ''
        AND octet_length(processing_generation) <= 255
    );

ALTER TABLE focowiki.document_processing_jobs
    ALTER COLUMN processing_generation
    SET DEFAULT 'document-indexing-v13';

CREATE INDEX document_processing_jobs_generation_reset_idx
    ON focowiki.document_processing_jobs (
      processing_generation, state, readiness_sequence
    )
    WHERE state IN ('waiting', 'processing', 'error');

INSERT INTO focowiki.projection_scope_object_refs (
    scope_public_id, rendered_sequence, knowledge_base_id, object_id, created_at
)
SELECT DISTINCT output.scope_public_id, output.rendered_sequence,
       output.knowledge_base_id, registration.object_id, output.created_at
FROM focowiki.projection_scope_outputs output
CROSS JOIN LATERAL jsonb_array_elements(output.pages) page
JOIN focowiki.object_registrations registration
  ON registration.object_id = page->>'objectId'
 AND registration.state = 'verified'
ON CONFLICT (scope_public_id, rendered_sequence, object_id) DO NOTHING;

CREATE TEMP TABLE document_generation_reset_jobs (
    document_job_public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    operation_public_id text NOT NULL,
    source_revision_public_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO document_generation_reset_jobs (
    document_job_public_id, knowledge_base_id, operation_public_id,
    source_revision_public_id
)
SELECT DISTINCT job.public_id, job.knowledge_base_id,
       job.operation_public_id, job.source_revision_public_id
FROM focowiki.document_processing_jobs job
WHERE job.processing_generation <> 'document-indexing-v13'
  AND (
    job.state IN ('waiting', 'processing', 'error')
    OR (
      job.state = 'available'
      AND EXISTS (
        SELECT 1
        FROM focowiki.projection_scope_contributions contribution
        JOIN focowiki.projection_scope_receipts receipt
          ON receipt.contribution_public_id = contribution.public_id
        JOIN focowiki.projection_scope_outputs output
          ON output.scope_public_id = receipt.scope_public_id
         AND output.rendered_sequence = receipt.rendered_sequence
        WHERE contribution.document_job_public_id = job.public_id
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(output.pages) page
            LEFT JOIN focowiki.object_registrations registration
              ON registration.object_id = page->>'objectId'
             AND registration.state = 'verified'
            LEFT JOIN focowiki.projection_scope_object_refs reference
              ON reference.scope_public_id = output.scope_public_id
             AND reference.rendered_sequence = output.rendered_sequence
             AND reference.object_id = page->>'objectId'
            WHERE registration.object_id IS NULL
               OR reference.object_id IS NULL
          )
      )
    )
  );

CREATE TEMP TABLE document_generation_reset_scopes (
    scope_public_id text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO document_generation_reset_scopes (scope_public_id)
SELECT DISTINCT contribution.scope_public_id
FROM focowiki.projection_scope_contributions contribution
JOIN document_generation_reset_jobs reset
  ON reset.document_job_public_id = contribution.document_job_public_id;

CREATE TEMP TABLE document_generation_reset_outputs (
    scope_public_id text NOT NULL,
    rendered_sequence bigint NOT NULL,
    knowledge_base_id text NOT NULL,
    PRIMARY KEY (scope_public_id, rendered_sequence)
) ON COMMIT DROP;

INSERT INTO document_generation_reset_outputs (
    scope_public_id, rendered_sequence, knowledge_base_id
)
SELECT DISTINCT output.scope_public_id, output.rendered_sequence,
       output.knowledge_base_id
FROM focowiki.projection_scope_outputs output
JOIN focowiki.projection_scope_receipts receipt
  ON receipt.scope_public_id = output.scope_public_id
 AND receipt.rendered_sequence = output.rendered_sequence
JOIN focowiki.projection_scope_contributions contribution
  ON contribution.public_id = receipt.contribution_public_id
JOIN document_generation_reset_jobs reset
  ON reset.document_job_public_id = contribution.document_job_public_id
WHERE NOT EXISTS (
  SELECT 1
  FROM focowiki.projection_scope_receipts retained_receipt
  JOIN focowiki.projection_scope_contributions retained_contribution
    ON retained_contribution.public_id = retained_receipt.contribution_public_id
  LEFT JOIN document_generation_reset_jobs retained_reset
    ON retained_reset.document_job_public_id
         = retained_contribution.document_job_public_id
  WHERE retained_receipt.scope_public_id = output.scope_public_id
    AND retained_receipt.rendered_sequence = output.rendered_sequence
    AND retained_reset.document_job_public_id IS NULL
);

CREATE TEMP TABLE document_generation_released_objects (
    knowledge_base_id text NOT NULL,
    object_id text NOT NULL,
    PRIMARY KEY (knowledge_base_id, object_id)
) ON COMMIT DROP;

INSERT INTO document_generation_released_objects (
    knowledge_base_id, object_id
)
SELECT DISTINCT output.knowledge_base_id, page->>'objectId'
FROM document_generation_reset_outputs reset
JOIN focowiki.projection_scope_outputs output
  ON output.scope_public_id = reset.scope_public_id
 AND output.rendered_sequence = reset.rendered_sequence
CROSS JOIN LATERAL jsonb_array_elements(output.pages) page
WHERE page->>'objectId' IS NOT NULL
ON CONFLICT (knowledge_base_id, object_id) DO NOTHING;

INSERT INTO document_generation_released_objects (
    knowledge_base_id, object_id
)
SELECT DISTINCT candidate.knowledge_base_id, candidate.object_id
FROM focowiki.generated_page_candidates candidate
JOIN focowiki.document_artifact_work work
  ON work.public_id = candidate.source_work_public_id
JOIN document_generation_reset_jobs reset
  ON reset.document_job_public_id = work.document_job_public_id
WHERE NOT EXISTS (
  SELECT 1
  FROM focowiki.generated_page_heads head
  WHERE head.knowledge_base_id = candidate.knowledge_base_id
    AND head.page_candidate_public_id = candidate.public_id
)
ON CONFLICT (knowledge_base_id, object_id) DO NOTHING;

DELETE FROM focowiki.projection_scope_contributions contribution
USING document_generation_reset_jobs reset
WHERE contribution.document_job_public_id = reset.document_job_public_id;

DELETE FROM focowiki.projection_scope_storage_metrics metric
USING document_generation_reset_outputs reset
WHERE metric.scope_public_id = reset.scope_public_id
  AND metric.rendered_sequence = reset.rendered_sequence;

DELETE FROM focowiki.projection_scope_outputs output
USING document_generation_reset_outputs reset
WHERE output.scope_public_id = reset.scope_public_id
  AND output.rendered_sequence = reset.rendered_sequence;

DELETE FROM focowiki.generated_page_candidates candidate
USING focowiki.document_artifact_work work,
      document_generation_reset_jobs reset
WHERE candidate.source_work_public_id = work.public_id
  AND work.document_job_public_id = reset.document_job_public_id
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.generated_page_heads head
    WHERE head.knowledge_base_id = candidate.knowledge_base_id
      AND head.page_candidate_public_id = candidate.public_id
  );

DELETE FROM focowiki.document_projection_waiting_completions pending
USING document_generation_reset_jobs reset
WHERE pending.document_job_public_id = reset.document_job_public_id;

DELETE FROM focowiki.document_artifact_receipts receipt
USING document_generation_reset_jobs reset
WHERE receipt.document_job_public_id = reset.document_job_public_id;

DELETE FROM focowiki.document_graphrag_chunks chunk
USING document_generation_reset_jobs reset
WHERE chunk.document_job_public_id = reset.document_job_public_id;

DELETE FROM focowiki.document_model_layer_executions execution
USING document_generation_reset_jobs reset
WHERE execution.document_job_public_id = reset.document_job_public_id;

DELETE FROM focowiki.document_model_analysis_results analysis
USING document_generation_reset_jobs reset
WHERE analysis.knowledge_base_id = reset.knowledge_base_id
  AND analysis.source_revision_public_id = reset.source_revision_public_id;

DELETE FROM focowiki.relationship_evaluations evaluation
USING document_generation_reset_jobs reset
WHERE evaluation.knowledge_base_id = reset.knowledge_base_id
  AND evaluation.source_revision_public_id = reset.source_revision_public_id;

UPDATE focowiki.document_artifact_work work
SET state = 'waiting', attempt_count = 0, next_eligible_at = now(),
    lease_owner = NULL, lease_expires_at = NULL,
    wait_time_milliseconds = 0, service_time_milliseconds = 0,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false, started_at = NULL, ended_at = NULL,
    updated_at = now()
FROM document_generation_reset_jobs reset
WHERE work.document_job_public_id = reset.document_job_public_id;

DELETE FROM focowiki.operation_results result
USING document_generation_reset_jobs reset
WHERE result.knowledge_base_id = reset.knowledge_base_id
  AND result.public_id = reset.operation_public_id;

UPDATE focowiki.operations operation
SET state = 'processing', completed_at = NULL, updated_at = now()
FROM document_generation_reset_jobs reset
WHERE operation.knowledge_base_id = reset.knowledge_base_id
  AND operation.public_id = reset.operation_public_id;

UPDATE focowiki.document_processing_jobs job
SET processing_generation = 'document-indexing-v13',
    state = 'waiting', attempt_count = 0, failure_count = 0,
    total_attempt_count = 0, next_attempt_at = NULL,
    completed_work_count = 0, active_work_kinds = '{}'::text[],
    blocking_work_kind = 'prepare', retrying_work_kind = NULL,
    cancellation_requested_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL, retryable = false,
    model_status = NULL, model_name = NULL,
    model_started_at = NULL, model_ended_at = NULL,
    model_warning_count = NULL, model_error_code = NULL,
    started_at = NULL, terminal_at = NULL,
    service_time_milliseconds = 0,
    revision = revision + 1, updated_at = now()
FROM document_generation_reset_jobs reset
WHERE job.public_id = reset.document_job_public_id;

UPDATE focowiki.projection_dirty_scopes scope
SET state = CASE
      WHEN pressure.waiting_count > 0 THEN 'waiting'
      WHEN scope.completed_sequence >= scope.required_sequence THEN 'completed'
      ELSE 'waiting'
    END,
    attempt_count = 0, next_eligible_at = now(), coalesce_until = now(),
    lease_owner = NULL, lease_expires_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false,
    waiting_contribution_count = pressure.waiting_count,
    oldest_waiting_contribution_at = pressure.oldest_waiting_at,
    updated_at = now()
FROM (
  SELECT dirty.public_id,
         count(contribution.public_id)
           FILTER (WHERE contribution.state = 'waiting')::integer
           AS waiting_count,
         min(contribution.created_at)
           FILTER (WHERE contribution.state = 'waiting') AS oldest_waiting_at
  FROM focowiki.projection_dirty_scopes dirty
  JOIN document_generation_reset_scopes reset
    ON reset.scope_public_id = dirty.public_id
  LEFT JOIN focowiki.projection_scope_contributions contribution
    ON contribution.scope_public_id = dirty.public_id
  GROUP BY dirty.public_id
) pressure
WHERE scope.public_id = pressure.public_id;

UPDATE focowiki.object_registrations registration
SET zero_owner_since = coalesce(registration.zero_owner_since, now())
WHERE registration.object_id IN (
    SELECT released.object_id
    FROM document_generation_released_objects released
  )
  AND registration.state = 'verified'
  AND NOT EXISTS (
    SELECT 1 FROM focowiki.object_owners owner
    WHERE owner.object_id = registration.object_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM focowiki.source_revisions revision
    WHERE revision.object_id = registration.object_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM focowiki.generated_page_candidates candidate
    WHERE candidate.object_id = registration.object_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM focowiki.upload_entries entry
    WHERE entry.object_id = registration.object_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM focowiki.embedding_artifacts artifact
    WHERE artifact.object_id = registration.object_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM focowiki.projection_scope_object_refs reference
    WHERE reference.object_id = registration.object_id
  );

INSERT INTO focowiki.cleanup_actions (
    public_id, knowledge_base_id, action_kind, cleanup_plane, resource_kind,
    resource_public_id, required, priority, sequence_number,
    idempotency_key, request_hash, checkpoint, state, attempt_count,
    maximum_attempts, not_before, created_at, updated_at
)
SELECT 'cleanup-processing-generation-' || md5(
         released.knowledge_base_id || chr(31) || registration.object_id
       ), released.knowledge_base_id, 'zero_owner_object', 'object_storage',
       'zero_owner_object', registration.object_id, true, 40,
       row_number() OVER (
         ORDER BY released.knowledge_base_id,
                  registration.object_id COLLATE "C"
       )::integer,
       'processing-generation-v13:' || registration.object_id,
       md5(registration.object_id), jsonb_build_object(
         'schemaVersion', 'document-processing-generation-reset-v1'
       ), 'queued', 0, 8, now(), now(), now()
FROM document_generation_released_objects released
JOIN focowiki.object_registrations registration
  ON registration.object_id = released.object_id
 AND registration.state = 'verified'
 AND registration.zero_owner_since IS NOT NULL
ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING;

UPDATE focowiki.document_processing_jobs
SET processing_generation = 'document-indexing-v13', updated_at = now()
WHERE processing_generation <> 'document-indexing-v13'
  AND state IN ('available', 'cancelled', 'superseded');

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v13-active-projection-output-repair'
WHERE singleton = true
  AND generation = 'storage-vnext-v12-projection-object-lifecycle';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
        generation = 'storage-vnext-v13-active-projection-output-repair'
    );
