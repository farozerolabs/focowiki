ALTER TABLE focowiki.projection_scope_generations
    ADD COLUMN next_eligible_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN resource_failure_started_at timestamp with time zone,
    ADD COLUMN resource_failure_count integer DEFAULT 0 NOT NULL;

ALTER TABLE focowiki.projection_scope_generations
    ADD CONSTRAINT projection_scope_generations_resource_retry_check CHECK (
      resource_failure_count >= 0
      AND (resource_failure_started_at IS NOT NULL
        OR resource_failure_count = 0)
    );

DROP INDEX focowiki.projection_scope_generations_claim_idx;

CREATE INDEX projection_scope_generations_claim_idx
    ON focowiki.projection_scope_generations (
      state, next_eligible_at, created_at, public_id
    ) WHERE state = 'waiting';

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v17-projection-resource-recovery'
WHERE singleton = true
  AND generation = 'storage-vnext-v16-projection-navigation-capacity';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v17-projection-resource-recovery'
    );
