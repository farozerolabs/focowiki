ALTER TABLE focowiki.projection_dirty_scopes
    ADD COLUMN waiting_contribution_count integer DEFAULT 0 NOT NULL,
    ADD COLUMN oldest_waiting_contribution_at timestamp with time zone;

DELETE FROM focowiki.projection_scope_contributions contribution
USING focowiki.projection_dirty_scopes scope
WHERE scope.public_id = contribution.scope_public_id
  AND scope.scope_kind IN ('relation', 'graph')
  AND contribution.state = 'waiting';

UPDATE focowiki.projection_dirty_scopes
SET completed_sequence = required_sequence,
    state = 'completed',
    lease_owner = NULL,
    lease_expires_at = NULL,
    safe_error_code = NULL,
    safe_error_message = NULL,
    retryable = false,
    updated_at = now()
WHERE scope_kind IN ('relation', 'graph')
  AND state <> 'running';

UPDATE focowiki.projection_dirty_scopes
SET state = 'waiting',
    attempt_count = 0,
    next_eligible_at = now(),
    coalesce_until = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    safe_error_code = NULL,
    safe_error_message = NULL,
    retryable = false,
    updated_at = now()
WHERE state = 'error'
  AND retryable
  AND safe_error_code = 'projection_scope_contributor_limit_exceeded';

WITH repaired_jobs AS (
    SELECT DISTINCT job.public_id
    FROM focowiki.document_processing_jobs job
    JOIN focowiki.document_artifact_work work
      ON work.knowledge_base_id = job.knowledge_base_id
     AND work.document_job_public_id = job.public_id
    WHERE job.state = 'error'
      AND job.retryable
      AND work.state = 'error'
      AND work.retryable
      AND (
        work.safe_error_code IN (
          'projection_scope_output_limit_exceeded',
          'projection_scope_contributor_limit_exceeded'
        )
        OR (work.work_kind = 'activate' AND work.safe_error_code = '23505')
      )
), reset_jobs AS (
    UPDATE focowiki.document_processing_jobs job
    SET state = 'waiting',
        attempt_count = 0,
        failure_count = 0,
        next_attempt_at = now(),
        active_work_kinds = '{}'::text[],
        retrying_work_kind = NULL,
        completed_work_count = (
          SELECT count(*)::integer
          FROM focowiki.document_artifact_work completed
          WHERE completed.document_job_public_id = job.public_id
            AND completed.state = 'completed'
        ),
        cancellation_requested_at = NULL,
        safe_error_code = NULL,
        safe_error_message = NULL,
        retryable = false,
        terminal_at = NULL,
        service_time_milliseconds = 0,
        revision = revision + 1,
        updated_at = now()
    FROM repaired_jobs
    WHERE job.public_id = repaired_jobs.public_id
    RETURNING job.public_id
)
UPDATE focowiki.document_artifact_work work
SET state = 'waiting',
    attempt_count = 0,
    next_eligible_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    safe_error_code = NULL,
    safe_error_message = NULL,
    retryable = false,
    ended_at = NULL,
    wait_time_milliseconds = 0,
    service_time_milliseconds = 0,
    updated_at = now()
FROM reset_jobs
WHERE work.document_job_public_id = reset_jobs.public_id
  AND work.state = 'error';

WITH pressure AS (
    SELECT scope_public_id,
           count(*)::integer AS waiting_contribution_count,
           min(created_at) AS oldest_waiting_contribution_at
    FROM focowiki.projection_scope_contributions
    WHERE state = 'waiting'
    GROUP BY scope_public_id
)
UPDATE focowiki.projection_dirty_scopes scope
SET waiting_contribution_count = pressure.waiting_contribution_count,
    oldest_waiting_contribution_at = pressure.oldest_waiting_contribution_at
FROM pressure
WHERE scope.public_id = pressure.scope_public_id;

ALTER TABLE focowiki.projection_dirty_scopes
    ADD CONSTRAINT projection_dirty_scopes_waiting_pressure_check CHECK (
        waiting_contribution_count >= 0
        AND (
            (waiting_contribution_count = 0
                AND oldest_waiting_contribution_at IS NULL)
            OR (waiting_contribution_count > 0
                AND oldest_waiting_contribution_at IS NOT NULL)
        )
    );

CREATE INDEX projection_scope_contributions_waiting_job_idx
    ON focowiki.projection_scope_contributions (
        document_job_public_id,
        scope_public_id,
        required_sequence
    )
    WHERE state = 'waiting';

CREATE INDEX projection_dirty_scopes_error_idx
    ON focowiki.projection_dirty_scopes (updated_at DESC, public_id)
    WHERE state = 'error';

CREATE INDEX document_artifact_work_projection_waiting_idx
    ON focowiki.document_artifact_work (updated_at, public_id)
    INCLUDE (document_job_public_id)
    WHERE work_kind = 'knowledge_projection'
      AND state = 'waiting_on_projection';

CREATE INDEX projection_dirty_scopes_waiting_pressure_idx
    ON focowiki.projection_dirty_scopes (
        oldest_waiting_contribution_at,
        waiting_contribution_count DESC,
        next_eligible_at,
        public_id
    )
    WHERE state = 'waiting';

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v11-projection-throughput'
WHERE singleton = true
  AND generation = 'storage-vnext-v10-document-indexing-throughput';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
        generation = 'storage-vnext-v11-projection-throughput'
    );
