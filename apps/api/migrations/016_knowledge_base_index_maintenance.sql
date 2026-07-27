ALTER TABLE focowiki.knowledge_bases
  ADD COLUMN IF NOT EXISTS index_maintenance_last_activity_at timestamptz;

CREATE TABLE IF NOT EXISTS focowiki.knowledge_base_index_maintenance_requests (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL
    REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
  trigger_kind text NOT NULL
    CHECK (trigger_kind IN ('manual', 'automatic')),
  state text NOT NULL
    CHECK (
      state IN (
        'queued', 'planning', 'running', 'validating',
        'completed', 'failed', 'superseded', 'canceled'
      )
    ),
  idempotency_key text,
  actor text,
  base_generation_id text,
  source_watermark bigint,
  settings_revision bigint NOT NULL DEFAULT 0,
  settings_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  planned_scopes text[] NOT NULL DEFAULT '{}'::text[],
  completed_scopes text[] NOT NULL DEFAULT '{}'::text[],
  current_stage text,
  completed_count bigint NOT NULL DEFAULT 0
    CHECK (completed_count >= 0),
  expected_count bigint NOT NULL DEFAULT 0
    CHECK (expected_count >= 0),
  retry_count integer NOT NULL DEFAULT 0
    CHECK (retry_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5
    CHECK (max_attempts > 0),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_progress_at timestamptz,
  last_error_code text,
  last_error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(planned_scopes) <= 16),
  CHECK (cardinality(completed_scopes) <= 16),
  CHECK (octet_length(settings_snapshot_json::text) <= 8192),
  CHECK (idempotency_key IS NULL OR octet_length(idempotency_key) <= 200),
  CHECK (actor IS NULL OR octet_length(actor) <= 200),
  CHECK (last_error_code IS NULL OR octet_length(last_error_code) <= 120),
  CHECK (last_error_message IS NULL OR octet_length(last_error_message) <= 500)
);

ALTER TABLE focowiki.knowledge_base_projection_repairs
  ADD COLUMN IF NOT EXISTS maintenance_request_id text
    REFERENCES focowiki.knowledge_base_index_maintenance_requests(id)
    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS maintenance_request_attempt integer
    NOT NULL DEFAULT 0
    CHECK (maintenance_request_attempt >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_base_index_maintenance_one_active_idx
  ON focowiki.knowledge_base_index_maintenance_requests (knowledge_base_id)
  WHERE state IN ('queued', 'planning', 'running', 'validating');

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_base_index_maintenance_idempotency_idx
  ON focowiki.knowledge_base_index_maintenance_requests (
    knowledge_base_id,
    idempotency_key
  )
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_base_index_maintenance_claim_idx
  ON focowiki.knowledge_base_index_maintenance_requests (
    state,
    next_attempt_at,
    created_at,
    id
  )
  WHERE state IN ('queued', 'planning', 'running', 'validating');

CREATE INDEX IF NOT EXISTS knowledge_base_index_maintenance_history_idx
  ON focowiki.knowledge_base_index_maintenance_requests (
    knowledge_base_id,
    created_at DESC,
    id DESC
  );

UPDATE focowiki.knowledge_bases knowledge_base
SET index_maintenance_last_activity_at = coalesce(
      (
        SELECT coalesce(
                 request.completed_at,
                 request.updated_at,
                 request.created_at
               )
        FROM focowiki.knowledge_base_index_maintenance_requests request
        WHERE request.knowledge_base_id = knowledge_base.id
        ORDER BY request.created_at DESC, request.id DESC
        LIMIT 1
      ),
      knowledge_base.created_at
    )
WHERE knowledge_base.index_maintenance_last_activity_at IS NULL;

ALTER TABLE focowiki.knowledge_bases
  ALTER COLUMN index_maintenance_last_activity_at SET DEFAULT now(),
  ALTER COLUMN index_maintenance_last_activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_bases_index_maintenance_due_idx
  ON focowiki.knowledge_bases (
    index_maintenance_last_activity_at,
    id
  )
  WHERE deleted_at IS NULL
    AND active_generation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION focowiki.track_index_maintenance_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR (
       NEW.state IN ('completed', 'failed', 'superseded', 'canceled')
       AND OLD.state IS DISTINCT FROM NEW.state
     ) THEN
    UPDATE focowiki.knowledge_bases
    SET index_maintenance_last_activity_at = greatest(
          index_maintenance_last_activity_at,
          coalesce(NEW.completed_at, NEW.updated_at, NEW.created_at)
        )
    WHERE id = NEW.knowledge_base_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS index_maintenance_requests_track_activity
  ON focowiki.knowledge_base_index_maintenance_requests;

CREATE TRIGGER index_maintenance_requests_track_activity
AFTER INSERT OR UPDATE OF state, completed_at, updated_at
ON focowiki.knowledge_base_index_maintenance_requests
FOR EACH ROW
EXECUTE FUNCTION focowiki.track_index_maintenance_activity();

CREATE OR REPLACE FUNCTION focowiki.cancel_index_maintenance_on_knowledge_base_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE focowiki.knowledge_base_index_maintenance_requests
    SET state = 'canceled',
        current_stage = 'canceled',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NEW.deleted_at,
        last_progress_at = NEW.deleted_at,
        completed_at = NEW.deleted_at,
        updated_at = NEW.deleted_at
    WHERE knowledge_base_id = NEW.id
      AND state IN ('queued', 'planning', 'running', 'validating');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_bases_cancel_index_maintenance
  ON focowiki.knowledge_bases;

CREATE TRIGGER knowledge_bases_cancel_index_maintenance
AFTER UPDATE OF deleted_at ON focowiki.knowledge_bases
FOR EACH ROW
EXECUTE FUNCTION focowiki.cancel_index_maintenance_on_knowledge_base_delete();

INSERT INTO focowiki.runtime_settings (key, value_json, source)
VALUES (
  'maintenance',
  jsonb_build_object(
    'knowledgeBaseMaintenanceMode', 'manual',
    'knowledgeBaseMaintenanceScanIntervalSeconds', 21600,
    'knowledgeBaseMaintenanceConcurrency', 1
  ),
  'bootstrap'
)
ON CONFLICT (key) DO UPDATE
SET value_json = jsonb_build_object(
       'knowledgeBaseMaintenanceMode', 'manual',
       'knowledgeBaseMaintenanceScanIntervalSeconds', 21600,
       'knowledgeBaseMaintenanceConcurrency', 1
     ) || focowiki.runtime_settings.value_json,
    version = focowiki.runtime_settings.version + 1,
    updated_at = now();

UPDATE focowiki.runtime_generation
SET generation = 'knowledge-base-index-maintenance-v16'
WHERE singleton = true;
