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

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v23-single-job-publication-retry-recovery'
WHERE singleton = true
  AND generation = 'storage-vnext-v22-single-job-publication-upgrade-baseline';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v23-single-job-publication-retry-recovery'
    );
