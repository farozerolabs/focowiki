CREATE TABLE focowiki.projection_scope_object_refs (
    scope_public_id text NOT NULL,
    rendered_sequence bigint NOT NULL,
    knowledge_base_id text NOT NULL,
    object_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (scope_public_id, rendered_sequence, object_id),
    FOREIGN KEY (scope_public_id, rendered_sequence)
      REFERENCES focowiki.projection_scope_outputs (
        scope_public_id, rendered_sequence
      ) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
    FOREIGN KEY (object_id)
      REFERENCES focowiki.object_registrations (object_id) ON DELETE RESTRICT
);

CREATE INDEX projection_scope_object_refs_object_idx
    ON focowiki.projection_scope_object_refs (object_id);

CREATE TEMP TABLE projection_lifecycle_repair_jobs (
    document_job_public_id text PRIMARY KEY,
    safe_error_code text NOT NULL
) ON COMMIT DROP;

INSERT INTO projection_lifecycle_repair_jobs (
    document_job_public_id, safe_error_code
)
SELECT DISTINCT work.document_job_public_id, work.safe_error_code
FROM focowiki.document_artifact_work work
WHERE work.state = 'error'
  AND work.retryable
  AND (
    (work.work_kind = 'knowledge_projection'
      AND work.safe_error_code = 'invalid_input')
    OR (work.work_kind = 'activate'
      AND work.safe_error_code = 'page_object_unverified')
  );

CREATE TEMP TABLE projection_lifecycle_released_objects (
    knowledge_base_id text NOT NULL,
    object_id text NOT NULL,
    PRIMARY KEY (knowledge_base_id, object_id)
) ON COMMIT DROP;

INSERT INTO projection_lifecycle_released_objects (
    knowledge_base_id, object_id
)
SELECT DISTINCT output.knowledge_base_id, page->>'objectId'
FROM focowiki.projection_scope_outputs output
JOIN focowiki.projection_dirty_scopes scope
  ON scope.public_id = output.scope_public_id
CROSS JOIN LATERAL jsonb_array_elements(output.pages) page
WHERE page->>'objectId' IS NOT NULL
  AND scope.state <> 'running'
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.projection_scope_receipts receipt
    JOIN focowiki.projection_scope_contributions contribution
      ON contribution.public_id = receipt.contribution_public_id
    JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = contribution.knowledge_base_id
     AND job.public_id = contribution.document_job_public_id
    WHERE receipt.scope_public_id = output.scope_public_id
      AND receipt.rendered_sequence = output.rendered_sequence
      AND job.state NOT IN ('available', 'error', 'cancelled', 'superseded')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.projection_scope_receipts receipt
    JOIN focowiki.projection_scope_contributions contribution
      ON contribution.public_id = receipt.contribution_public_id
    JOIN projection_lifecycle_repair_jobs repair
      ON repair.document_job_public_id = contribution.document_job_public_id
    WHERE receipt.scope_public_id = output.scope_public_id
      AND receipt.rendered_sequence = output.rendered_sequence
  )
ON CONFLICT (knowledge_base_id, object_id) DO NOTHING;

DELETE FROM focowiki.projection_scope_outputs output
USING focowiki.projection_dirty_scopes scope
WHERE scope.public_id = output.scope_public_id
  AND scope.state <> 'running'
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.projection_scope_receipts receipt
    JOIN focowiki.projection_scope_contributions contribution
      ON contribution.public_id = receipt.contribution_public_id
    JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = contribution.knowledge_base_id
     AND job.public_id = contribution.document_job_public_id
    WHERE receipt.scope_public_id = output.scope_public_id
      AND receipt.rendered_sequence = output.rendered_sequence
      AND job.state NOT IN ('available', 'error', 'cancelled', 'superseded')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.projection_scope_receipts receipt
    JOIN focowiki.projection_scope_contributions contribution
      ON contribution.public_id = receipt.contribution_public_id
    JOIN projection_lifecycle_repair_jobs repair
      ON repair.document_job_public_id = contribution.document_job_public_id
    WHERE receipt.scope_public_id = output.scope_public_id
      AND receipt.rendered_sequence = output.rendered_sequence
  );

CREATE TEMP TABLE projection_lifecycle_invalid_repair_outputs (
    scope_public_id text NOT NULL,
    rendered_sequence bigint NOT NULL,
    knowledge_base_id text NOT NULL,
    PRIMARY KEY (scope_public_id, rendered_sequence)
) ON COMMIT DROP;

INSERT INTO projection_lifecycle_invalid_repair_outputs (
    scope_public_id, rendered_sequence, knowledge_base_id
)
SELECT DISTINCT output.scope_public_id, output.rendered_sequence,
       output.knowledge_base_id
FROM projection_lifecycle_repair_jobs repair
JOIN focowiki.projection_scope_contributions contribution
  ON contribution.document_job_public_id = repair.document_job_public_id
JOIN focowiki.projection_scope_receipts receipt
  ON receipt.contribution_public_id = contribution.public_id
JOIN focowiki.projection_scope_outputs output
  ON output.scope_public_id = receipt.scope_public_id
 AND output.rendered_sequence = receipt.rendered_sequence
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(output.pages) page
  LEFT JOIN focowiki.object_registrations registration
    ON registration.object_id = page->>'objectId'
   AND registration.state = 'verified'
  WHERE registration.object_id IS NULL
);

CREATE TEMP TABLE projection_lifecycle_repair_contributions (
    contribution_public_id text PRIMARY KEY,
    scope_public_id text NOT NULL,
    repair_sequence bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO projection_lifecycle_repair_contributions (
    contribution_public_id, scope_public_id, repair_sequence
)
SELECT contribution.public_id, contribution.scope_public_id,
       scope.required_sequence + row_number() OVER (
         PARTITION BY contribution.scope_public_id
         ORDER BY contribution.public_id COLLATE "C"
       )
FROM projection_lifecycle_repair_jobs repair
JOIN focowiki.projection_scope_contributions contribution
  ON contribution.document_job_public_id = repair.document_job_public_id
JOIN focowiki.projection_scope_receipts receipt
  ON receipt.contribution_public_id = contribution.public_id
JOIN projection_lifecycle_invalid_repair_outputs invalid
  ON invalid.scope_public_id = receipt.scope_public_id
 AND invalid.rendered_sequence = receipt.rendered_sequence
JOIN focowiki.projection_dirty_scopes scope
  ON scope.public_id = contribution.scope_public_id;

CREATE TEMP TABLE projection_lifecycle_repair_scopes (
    scope_public_id text PRIMARY KEY,
    repair_sequence bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO projection_lifecycle_repair_scopes (
    scope_public_id, repair_sequence
)
SELECT scope_public_id, max(repair_sequence)
FROM projection_lifecycle_repair_contributions
GROUP BY scope_public_id;

INSERT INTO projection_lifecycle_released_objects (
    knowledge_base_id, object_id
)
SELECT DISTINCT invalid.knowledge_base_id, page->>'objectId'
FROM projection_lifecycle_invalid_repair_outputs invalid
JOIN focowiki.projection_scope_outputs output
  ON output.scope_public_id = invalid.scope_public_id
 AND output.rendered_sequence = invalid.rendered_sequence
CROSS JOIN LATERAL jsonb_array_elements(output.pages) page
WHERE page->>'objectId' IS NOT NULL
ON CONFLICT (knowledge_base_id, object_id) DO NOTHING;

DELETE FROM focowiki.projection_scope_receipts receipt
USING projection_lifecycle_invalid_repair_outputs invalid
WHERE receipt.scope_public_id = invalid.scope_public_id
  AND receipt.rendered_sequence = invalid.rendered_sequence;

DELETE FROM focowiki.projection_scope_outputs output
USING projection_lifecycle_invalid_repair_outputs invalid
WHERE output.scope_public_id = invalid.scope_public_id
  AND output.rendered_sequence = invalid.rendered_sequence;

UPDATE focowiki.projection_scope_contributions contribution
SET state = 'waiting', required_sequence = repair.repair_sequence,
    acknowledged_at = NULL
FROM projection_lifecycle_repair_contributions repair
WHERE contribution.public_id = repair.contribution_public_id;

UPDATE focowiki.projection_dirty_scopes dirty
SET required_sequence = repair.repair_sequence,
    state = 'waiting', attempt_count = 0,
    next_eligible_at = now(), coalesce_until = now(),
    lease_owner = NULL, lease_expires_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false, updated_at = now()
FROM projection_lifecycle_repair_scopes repair
WHERE dirty.public_id = repair.scope_public_id;

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

UPDATE focowiki.object_registrations registration
SET zero_owner_since = coalesce(registration.zero_owner_since, now())
WHERE registration.object_id IN (
    SELECT released.object_id
    FROM projection_lifecycle_released_objects released
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
SELECT 'cleanup-projection-upgrade-' || md5(registration.object_id),
       min(released.knowledge_base_id), 'zero_owner_object',
       'object_storage', 'zero_owner_object', registration.object_id,
       true, 40,
       row_number() OVER (ORDER BY registration.object_id COLLATE "C")::integer,
       'projection-output-upgrade:' || registration.object_id,
       md5(registration.object_id),
       jsonb_build_object(
         'schemaVersion', 'projection-scope-output-upgrade-v1'
       ),
       'queued', 0, 8, now(), now(), now()
FROM projection_lifecycle_released_objects released
JOIN focowiki.object_registrations registration
  ON registration.object_id = released.object_id
 AND registration.state = 'verified'
 AND registration.zero_owner_since IS NOT NULL
WHERE NOT EXISTS (
  SELECT 1 FROM focowiki.projection_scope_object_refs reference
  WHERE reference.object_id = registration.object_id
)
GROUP BY registration.object_id
ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING;

UPDATE focowiki.object_registrations registration
SET zero_owner_since = NULL
WHERE registration.state = 'verified'
  AND EXISTS (
    SELECT 1
    FROM focowiki.projection_scope_object_refs reference
    WHERE reference.object_id = registration.object_id
  );

UPDATE focowiki.cleanup_actions action
SET state = 'completed', completed_at = now(), updated_at = now(),
    safe_error_code = 'PROJECTION_OUTPUT_OBJECT_REFERENCED'
WHERE action.action_kind = 'zero_owner_object'
  AND action.cleanup_plane = 'object_storage'
  AND action.state IN ('queued', 'retry')
  AND EXISTS (
    SELECT 1
    FROM focowiki.projection_scope_object_refs reference
    WHERE reference.object_id = action.resource_public_id
  );

UPDATE focowiki.projection_dirty_scopes
SET state = 'waiting', attempt_count = 0,
    next_eligible_at = now(), coalesce_until = now(),
    lease_owner = NULL, lease_expires_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false, updated_at = now()
WHERE state = 'error'
  AND safe_error_code = 'invalid_input';

UPDATE focowiki.projection_dirty_scopes scope
SET waiting_contribution_count = pressure.waiting_count,
    oldest_waiting_contribution_at = pressure.oldest_waiting_at
FROM (
  SELECT dirty.public_id,
         count(contribution.public_id)
           FILTER (WHERE contribution.state = 'waiting')::integer
           AS waiting_count,
         min(contribution.created_at)
           FILTER (WHERE contribution.state = 'waiting') AS oldest_waiting_at
  FROM focowiki.projection_dirty_scopes dirty
  LEFT JOIN focowiki.projection_scope_contributions contribution
    ON contribution.scope_public_id = dirty.public_id
  GROUP BY dirty.public_id
) pressure
WHERE scope.public_id = pressure.public_id;

UPDATE focowiki.document_artifact_work work
SET state = 'waiting', attempt_count = 0, next_eligible_at = now(),
    lease_owner = NULL, lease_expires_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false, ended_at = NULL,
    wait_time_milliseconds = 0, service_time_milliseconds = 0,
    updated_at = now()
FROM projection_lifecycle_repair_jobs repair
WHERE work.document_job_public_id = repair.document_job_public_id
  AND (
    (repair.safe_error_code = 'invalid_input'
      AND work.work_kind = 'knowledge_projection')
    OR (repair.safe_error_code = 'page_object_unverified'
      AND work.work_kind IN ('knowledge_projection', 'activate'))
  );

UPDATE focowiki.document_processing_jobs job
SET state = 'waiting', attempt_count = 0, failure_count = 0,
    next_attempt_at = now(), active_work_kinds = '{}'::text[],
    blocking_work_kind = NULL, retrying_work_kind = NULL,
    completed_work_count = summary.completed_count,
    cancellation_requested_at = NULL,
    safe_error_code = NULL, safe_error_message = NULL,
    retryable = false, terminal_at = NULL,
    service_time_milliseconds = summary.service_time_milliseconds,
    revision = revision + 1, updated_at = now()
FROM projection_lifecycle_repair_jobs repair,
LATERAL (
  SELECT count(*) FILTER (WHERE work.state = 'completed')::integer
           AS completed_count,
         coalesce(sum(work.service_time_milliseconds), 0)::bigint
           AS service_time_milliseconds
  FROM focowiki.document_artifact_work work
  WHERE work.document_job_public_id = repair.document_job_public_id
) summary
WHERE job.public_id = repair.document_job_public_id;

UPDATE focowiki.operations operation
SET state = 'processing', completed_at = NULL, updated_at = now()
FROM focowiki.document_processing_jobs job
JOIN projection_lifecycle_repair_jobs repair
  ON repair.document_job_public_id = job.public_id
WHERE operation.public_id = job.operation_public_id
  AND operation.state = 'failed';

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v12-projection-object-lifecycle'
WHERE singleton = true
  AND generation = 'storage-vnext-v11-projection-throughput';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
        generation = 'storage-vnext-v12-projection-object-lifecycle'
    );
