ALTER TABLE focowiki.storage_reconciliation_candidates
  ADD COLUMN IF NOT EXISTS deletion_lease_token text;

CREATE INDEX IF NOT EXISTS storage_reconciliation_candidates_deleting_lease_idx
  ON focowiki.storage_reconciliation_candidates (prefix, updated_at, object_key)
  WHERE state = 'deleting';

UPDATE focowiki.storage_reconciliation_candidates
SET state = 'failed',
    deletion_lease_token = NULL,
    next_attempt_at = now(),
    last_error_code = 'STALE_DELETION_LEASE_EXPIRED',
    updated_at = now()
WHERE state = 'deleting'
  AND updated_at <= now() - interval '10 minutes';

UPDATE focowiki.runtime_generation
SET generation = 'storage-reconciliation-lease-recovery-v12'
WHERE singleton = true;
