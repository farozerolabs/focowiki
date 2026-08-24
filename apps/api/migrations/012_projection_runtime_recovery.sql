UPDATE focowiki.cleanup_actions
SET state = 'failed', attempt_count = maximum_attempts,
    lease_owner = NULL, lease_expires_at = NULL,
    safe_error_code = 'cleanup_attempts_exhausted',
    completed_at = coalesce(completed_at, now()), updated_at = now()
WHERE action_kind = 'document_obsolete_artifact'
  AND state IN ('queued', 'retry', 'running')
  AND attempt_count >= maximum_attempts;

UPDATE focowiki.cleanup_actions
SET attempt_count = maximum_attempts, updated_at = now()
WHERE attempt_count > maximum_attempts;

ALTER TABLE focowiki.cleanup_actions
    ADD CONSTRAINT cleanup_actions_attempt_boundary_check CHECK (
      attempt_count BETWEEN 0 AND maximum_attempts
      AND maximum_attempts BETWEEN 1 AND 100
    );

CREATE INDEX projection_publication_generations_stranded_recovery_idx
    ON focowiki.projection_publication_generations (
      updated_at DESC, public_id
    ) WHERE state = 'obsolete'
      AND recovery_evidence->>'outcome' = 'minimum_replacement_planned';

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v20-projection-runtime-recovery'
WHERE singleton = true
  AND generation = 'storage-vnext-v19-projection-delta-lease-safety';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v20-projection-runtime-recovery'
    );
