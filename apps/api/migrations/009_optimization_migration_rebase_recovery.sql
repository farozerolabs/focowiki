UPDATE focowiki.knowledge_base_optimization_migrations migration
SET state = CASE
      WHEN migration.phase = 'verifying' THEN 'verifying'
      ELSE 'backfilling'
    END,
    prior_active_generation_id = knowledge_base.active_generation_id,
    optimized_active_generation_id = NULL,
    parity_evidence_json = '{}'::jsonb,
    attempt_count = 0,
    last_error_code = NULL,
    last_error_message = NULL,
    verified_at = NULL,
    completed_at = NULL,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
FROM focowiki.knowledge_bases knowledge_base
WHERE knowledge_base.id = migration.knowledge_base_id
  AND knowledge_base.deleted_at IS NULL
  AND migration.state = 'failed'
  AND migration.last_error_code = 'MIGRATION_SLICE_FAILED'
  AND migration.attempt_count >= migration.max_attempts;

UPDATE focowiki.runtime_generation
SET generation = 'optimization-migration-rebase-recovery-v9'
WHERE singleton = true;
