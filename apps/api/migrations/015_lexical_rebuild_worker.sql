ALTER TABLE focowiki.publication_generations
  DROP CONSTRAINT IF EXISTS publication_generations_kind_check,
  DROP CONSTRAINT IF EXISTS publication_generations_generation_kind_check;

ALTER TABLE focowiki.publication_generations
  ADD CONSTRAINT publication_generations_generation_kind_check CHECK (
    generation_kind = ANY (ARRAY['normal', 'projection_repair', 'lexical_rebuild'])
  );

CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA focowiki;

DROP INDEX focowiki.search_projection_segments_text_trgm_idx;

CREATE INDEX search_projection_segments_text_trgm_idx
  ON focowiki.search_projection_segments
  USING gin (
    knowledge_base_id focowiki.text_ops,
    lower(normalized_text) focowiki.gin_trgm_ops
  );

WITH active_lexical_generation AS MATERIALIZED (
  SELECT knowledge_base.id AS knowledge_base_id,
         active.id AS active_generation_id,
         active.predecessor_generation_id
  FROM focowiki.knowledge_bases knowledge_base
  JOIN focowiki.publication_generations active
    ON active.knowledge_base_id = knowledge_base.id
   AND active.id = knowledge_base.active_generation_id
   AND active.state = 'active'
   AND active.generation_kind = 'lexical_rebuild'
  WHERE knowledge_base.deleted_at IS NULL
    AND active.predecessor_generation_id IS NOT NULL
)
UPDATE focowiki.publication_generations generation
SET predecessor_generation_id = active_lexical_generation.active_generation_id,
    updated_at = now()
FROM active_lexical_generation
WHERE generation.knowledge_base_id = active_lexical_generation.knowledge_base_id
  AND generation.generation_kind = 'normal'
  AND generation.state IN ('open', 'frozen', 'building', 'validating')
  AND generation.predecessor_generation_id =
      active_lexical_generation.predecessor_generation_id;

ALTER TABLE focowiki.publication_generations
  ADD COLUMN IF NOT EXISTS search_schema_version text,
  ADD COLUMN IF NOT EXISTS tokenizer_contract_version text,
  ADD COLUMN IF NOT EXISTS search_segmentation_version text,
  DROP CONSTRAINT IF EXISTS publication_generations_search_version_check;

ALTER TABLE focowiki.publication_generations
  ADD CONSTRAINT publication_generations_search_version_check CHECK (
    (
      search_schema_version IS NULL
      AND tokenizer_contract_version IS NULL
      AND search_segmentation_version IS NULL
    )
    OR (
      char_length(search_schema_version) BETWEEN 1 AND 160
      AND char_length(tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(search_segmentation_version) BETWEEN 1 AND 160
    )
  );

ALTER TABLE focowiki.generation_search_projection_refs
  ADD COLUMN IF NOT EXISTS segmentation_version text;

UPDATE focowiki.generation_search_projection_refs reference
SET segmentation_version = document.segmentation_version
FROM focowiki.search_projection_documents document
WHERE reference.segmentation_version IS NULL
  AND document.knowledge_base_id = reference.knowledge_base_id
  AND document.id = reference.search_document_id;

ALTER TABLE focowiki.generation_search_projection_refs
  ALTER COLUMN segmentation_version SET NOT NULL,
  DROP CONSTRAINT IF EXISTS generation_search_projection_refs_text_bounds_check;

ALTER TABLE focowiki.generation_search_projection_refs
  ADD CONSTRAINT generation_search_projection_refs_text_bounds_check CHECK (
    octet_length(logical_path) <= 4096
    AND octet_length(title) <= 4096
    AND (summary IS NULL OR octet_length(summary) <= 16384)
    AND (source_url IS NULL OR octet_length(source_url) <= 8192)
    AND char_length(search_schema_version) BETWEEN 1 AND 160
    AND char_length(tokenizer_contract_version) BETWEEN 1 AND 200
    AND char_length(segmentation_version) BETWEEN 1 AND 160
  );

ALTER TABLE focowiki.knowledge_base_lexical_rebuilds
  ADD COLUMN IF NOT EXISTS target_content_profile_version text
    DEFAULT 'content-profile-v2' NOT NULL,
  ADD COLUMN IF NOT EXISTS target_graph_lexical_projection_version text
    DEFAULT 'graph-lexical-v2' NOT NULL,
  DROP CONSTRAINT IF EXISTS knowledge_base_lexical_rebuilds_version_check;

ALTER TABLE focowiki.knowledge_base_lexical_rebuilds
  ADD CONSTRAINT knowledge_base_lexical_rebuilds_version_check CHECK (
    char_length(target_search_schema_version) BETWEEN 1 AND 160
    AND char_length(target_tokenizer_contract_version) BETWEEN 1 AND 200
    AND char_length(target_segmentation_version) BETWEEN 1 AND 160
    AND char_length(target_content_profile_version) BETWEEN 1 AND 160
    AND char_length(target_graph_lexical_projection_version) BETWEEN 1 AND 160
  );

ALTER TABLE focowiki.knowledge_base_lexical_rebuilds
  ADD COLUMN settings_revision integer DEFAULT 0 NOT NULL,
  ADD COLUMN settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN pending_source_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN running_source_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN retry_source_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN failed_source_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN source_read_retry_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN database_retry_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN recent_files_per_second double precision,
  ADD COLUMN rolling_source_read_latency_ms double precision,
  ADD COLUMN rolling_database_batch_latency_ms double precision,
  ADD COLUMN last_progress_at timestamp with time zone,
  ADD COLUMN last_worker_heartbeat_at timestamp with time zone,
  ADD COLUMN estimated_completion_at timestamp with time zone;

ALTER TABLE focowiki.knowledge_base_lexical_rebuilds
  DROP CONSTRAINT knowledge_base_lexical_rebuilds_count_check;

ALTER TABLE focowiki.knowledge_base_lexical_rebuilds
  ADD CONSTRAINT knowledge_base_lexical_rebuilds_count_check CHECK (
    processed_source_count >= 0
    AND total_source_count >= 0
    AND processed_source_count <= total_source_count
    AND pending_source_count >= 0
    AND running_source_count >= 0
    AND retry_source_count >= 0
    AND failed_source_count >= 0
    AND source_read_retry_count >= 0
    AND database_retry_count >= 0
    AND rebase_count >= 0
    AND attempt_count >= 0
    AND max_attempts >= 1
  ),
  ADD CONSTRAINT knowledge_base_lexical_rebuilds_settings_check CHECK (
    settings_revision >= 0
    AND jsonb_typeof(settings_snapshot_json) = 'object'
  ),
  ADD CONSTRAINT knowledge_base_lexical_rebuilds_metrics_check CHECK (
    (recent_files_per_second IS NULL OR recent_files_per_second >= 0)
    AND (
      rolling_source_read_latency_ms IS NULL
      OR rolling_source_read_latency_ms >= 0
    )
    AND (
      rolling_database_batch_latency_ms IS NULL
      OR rolling_database_batch_latency_ms >= 0
    )
  );

CREATE TABLE focowiki.lexical_rebuild_work_items (
    knowledge_base_id text NOT NULL,
    target_generation_id text NOT NULL,
    source_file_id text NOT NULL,
    source_revision_id text NOT NULL,
    logical_path text NOT NULL,
    target_search_schema_version text NOT NULL,
    target_tokenizer_contract_version text NOT NULL,
    target_segmentation_version text NOT NULL,
    target_content_profile_version text NOT NULL,
    target_graph_lexical_projection_version text NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    settings_revision integer DEFAULT 0 NOT NULL,
    settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    last_error_stage text,
    last_error_code text,
    last_error_message text,
    source_read_retry_count integer DEFAULT 0 NOT NULL,
    database_retry_count integer DEFAULT 0 NOT NULL,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lexical_rebuild_work_items_pkey
      PRIMARY KEY (target_generation_id, source_file_id),
    CONSTRAINT lexical_rebuild_work_items_state_check CHECK (
      state = ANY (ARRAY[
        'pending', 'running', 'retry', 'completed', 'cancelled', 'failed'
      ])
    ),
    CONSTRAINT lexical_rebuild_work_items_count_check CHECK (
      attempt_count >= 0
      AND max_attempts >= 1
      AND source_read_retry_count >= 0
      AND database_retry_count >= 0
      AND settings_revision >= 0
    ),
    CONSTRAINT lexical_rebuild_work_items_settings_check CHECK (
      jsonb_typeof(settings_snapshot_json) = 'object'
    ),
    CONSTRAINT lexical_rebuild_work_items_lease_check CHECK (
      (
        lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
      )
      OR (
        lease_owner IS NOT NULL
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
    ),
    CONSTRAINT lexical_rebuild_work_items_version_check CHECK (
      char_length(target_search_schema_version) BETWEEN 1 AND 160
      AND char_length(target_tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(target_segmentation_version) BETWEEN 1 AND 160
      AND char_length(target_content_profile_version) BETWEEN 1 AND 160
      AND char_length(target_graph_lexical_projection_version) BETWEEN 1 AND 160
    ),
    CONSTRAINT lexical_rebuild_work_items_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT lexical_rebuild_work_items_generation_identity_fkey
      FOREIGN KEY (knowledge_base_id, target_generation_id)
      REFERENCES focowiki.publication_generations(knowledge_base_id, id)
      ON DELETE CASCADE,
    CONSTRAINT lexical_rebuild_work_items_source_file_identity_fkey
      FOREIGN KEY (knowledge_base_id, source_file_id)
      REFERENCES focowiki.source_files(knowledge_base_id, id)
      ON DELETE CASCADE,
    CONSTRAINT lexical_rebuild_work_items_source_revision_identity_fkey
      FOREIGN KEY (knowledge_base_id, source_revision_id, source_file_id)
      REFERENCES focowiki.source_revisions(
        knowledge_base_id, id, source_file_id
      )
      ON DELETE CASCADE
);

CREATE INDEX lexical_rebuild_work_items_claim_idx
  ON focowiki.lexical_rebuild_work_items (
    state,
    next_attempt_at,
    lease_expires_at,
    knowledge_base_id,
    source_file_id
  )
  WHERE state IN ('pending', 'running', 'retry');

CREATE INDEX lexical_rebuild_work_items_knowledge_base_claim_idx
  ON focowiki.lexical_rebuild_work_items (
    knowledge_base_id,
    source_file_id,
    state,
    next_attempt_at,
    lease_expires_at
  )
  WHERE state IN ('pending', 'running', 'retry');

CREATE INDEX lexical_rebuild_work_items_lease_idx
  ON focowiki.lexical_rebuild_work_items (
    lease_expires_at,
    knowledge_base_id,
    target_generation_id,
    source_file_id
  )
  WHERE state = 'running';

CREATE INDEX lexical_rebuild_work_items_progress_idx
  ON focowiki.lexical_rebuild_work_items (
    knowledge_base_id,
    target_generation_id,
    state
  );

CREATE INDEX lexical_rebuild_work_items_source_idx
  ON focowiki.lexical_rebuild_work_items (
    knowledge_base_id,
    source_file_id,
    source_revision_id
  );

CREATE FUNCTION focowiki.reconcile_lexical_work_after_source_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_state text;
  target_generation text;
  source_is_hidden boolean;
  source_identity_changed boolean;
BEGIN
  source_is_hidden :=
    NEW.deleted_at IS NOT NULL OR NEW.deletion_intent_id IS NOT NULL;
  source_identity_changed :=
    NEW.active_revision_id IS DISTINCT FROM OLD.active_revision_id
    OR NEW.relative_path IS DISTINCT FROM OLD.relative_path;

  IF NOT source_is_hidden AND NOT source_identity_changed THEN
    RETURN NEW;
  END IF;

  SELECT item.state, item.target_generation_id
  INTO prior_state, target_generation
  FROM focowiki.lexical_rebuild_work_items item
  JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
    ON rebuild.knowledge_base_id = item.knowledge_base_id
   AND rebuild.target_generation_id = item.target_generation_id
  WHERE item.knowledge_base_id = NEW.knowledge_base_id
    AND item.source_file_id = NEW.id
    AND rebuild.state NOT IN ('completed', 'cancelled')
  LIMIT 1
  FOR UPDATE OF item;

  IF target_generation IS NULL THEN
    RETURN NEW;
  END IF;

  IF source_is_hidden THEN
    UPDATE focowiki.lexical_rebuild_work_items
    SET state = 'cancelled',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = now()
    WHERE knowledge_base_id = NEW.knowledge_base_id
      AND target_generation_id = target_generation
      AND source_file_id = NEW.id;
  ELSE
    UPDATE focowiki.lexical_rebuild_work_items
    SET source_revision_id = NEW.active_revision_id,
        logical_path = 'pages/' || NEW.relative_path,
        state = 'pending',
        attempt_count = 0,
        next_attempt_at = now(),
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        last_error_stage = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        claimed_at = NULL,
        completed_at = NULL,
        updated_at = now()
    WHERE knowledge_base_id = NEW.knowledge_base_id
      AND target_generation_id = target_generation
      AND source_file_id = NEW.id;
  END IF;

  DELETE FROM focowiki.generation_search_projection_refs
  WHERE knowledge_base_id = NEW.knowledge_base_id
    AND generation_id = target_generation
    AND source_file_id = NEW.id;

  UPDATE focowiki.knowledge_base_lexical_rebuilds
  SET processed_source_count = greatest(
        0,
        processed_source_count - CASE WHEN prior_state = 'completed' THEN 1 ELSE 0 END
      ),
      pending_source_count = greatest(
        0,
        pending_source_count - CASE WHEN prior_state = 'pending' THEN 1 ELSE 0 END
      ) + CASE WHEN source_is_hidden THEN 0 ELSE 1 END,
      running_source_count = greatest(
        0,
        running_source_count - CASE WHEN prior_state = 'running' THEN 1 ELSE 0 END
      ),
      retry_source_count = greatest(
        0,
        retry_source_count - CASE WHEN prior_state = 'retry' THEN 1 ELSE 0 END
      ),
      failed_source_count = greatest(
        0,
        failed_source_count - CASE WHEN prior_state = 'failed' THEN 1 ELSE 0 END
      ),
      total_source_count = greatest(
        0,
        total_source_count
          + CASE
              WHEN source_is_hidden AND prior_state <> 'cancelled' THEN -1
              WHEN NOT source_is_hidden AND prior_state = 'cancelled' THEN 1
              ELSE 0
            END
      ),
      phase = 'reconcile',
      state = 'pending',
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      next_attempt_at = now(),
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = now()
  WHERE knowledge_base_id = NEW.knowledge_base_id
    AND target_generation_id = target_generation;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reconcile_lexical_work_after_source_change
AFTER UPDATE OF active_revision_id, relative_path, deleted_at, deletion_intent_id
ON focowiki.source_files
FOR EACH ROW
EXECUTE FUNCTION focowiki.reconcile_lexical_work_after_source_change();

CREATE FUNCTION focowiki.enqueue_lexical_work_after_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count integer;
BEGIN
  INSERT INTO focowiki.lexical_rebuild_work_items (
    knowledge_base_id,
    target_generation_id,
    source_file_id,
    source_revision_id,
    logical_path,
    target_search_schema_version,
    target_tokenizer_contract_version,
    target_segmentation_version,
    target_content_profile_version,
    target_graph_lexical_projection_version,
    state,
    max_attempts,
    next_attempt_at,
    settings_revision,
    settings_snapshot_json,
    created_at,
    updated_at
  )
  SELECT
    source.knowledge_base_id,
    rebuild.target_generation_id,
    source.id,
    NEW.id,
    'pages/' || source.relative_path,
    rebuild.target_search_schema_version,
    rebuild.target_tokenizer_contract_version,
    rebuild.target_segmentation_version,
    rebuild.target_content_profile_version,
    rebuild.target_graph_lexical_projection_version,
    'pending',
    rebuild.max_attempts,
    now(),
    rebuild.settings_revision,
    rebuild.settings_snapshot_json,
    now(),
    now()
  FROM focowiki.source_files source
  JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
    ON rebuild.knowledge_base_id = source.knowledge_base_id
   AND rebuild.target_generation_id IS NOT NULL
   AND rebuild.state NOT IN ('completed', 'cancelled')
  JOIN focowiki.knowledge_bases knowledge_base
    ON knowledge_base.id = source.knowledge_base_id
   AND knowledge_base.deleted_at IS NULL
  WHERE source.knowledge_base_id = NEW.knowledge_base_id
    AND source.id = NEW.source_file_id
    AND source.active_revision_id = NEW.id
    AND source.deleted_at IS NULL
    AND source.deletion_intent_id IS NULL
  ON CONFLICT (target_generation_id, source_file_id) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count > 0 THEN
    UPDATE focowiki.knowledge_base_lexical_rebuilds
    SET pending_source_count = pending_source_count + inserted_count,
        total_source_count = total_source_count + inserted_count,
        phase = 'reconcile',
        state = 'pending',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        next_attempt_at = now(),
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
    WHERE knowledge_base_id = NEW.knowledge_base_id
      AND target_generation_id IS NOT NULL
      AND state NOT IN ('completed', 'cancelled');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_lexical_work_after_revision_insert
AFTER INSERT
ON focowiki.source_revisions
FOR EACH ROW
EXECUTE FUNCTION focowiki.enqueue_lexical_work_after_revision_insert();

CREATE FUNCTION focowiki.cancel_lexical_work_after_knowledge_base_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE focowiki.knowledge_base_lexical_rebuilds
  SET state = 'cancelled',
      phase = 'cleanup',
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      completed_at = now(),
      updated_at = now()
  WHERE knowledge_base_id = NEW.id
    AND state <> 'completed';

  RETURN NEW;
END;
$$;

CREATE TRIGGER cancel_lexical_work_after_knowledge_base_delete
AFTER UPDATE OF deleted_at
ON focowiki.knowledge_bases
FOR EACH ROW
EXECUTE FUNCTION focowiki.cancel_lexical_work_after_knowledge_base_delete();

ALTER TABLE focowiki.role_heartbeats
  DROP CONSTRAINT role_heartbeats_role_check;

ALTER TABLE focowiki.role_heartbeats
  ADD CONSTRAINT role_heartbeats_role_check CHECK (
    role = ANY (
      ARRAY[
        'source', 'publication', 'projection_repair',
        'lexical_rebuild', 'maintenance'
      ]
    )
  );

ALTER TABLE focowiki.role_jobs
  DROP CONSTRAINT role_jobs_role_check;

ALTER TABLE focowiki.role_jobs
  ADD CONSTRAINT role_jobs_role_check CHECK (
    role = ANY (
      ARRAY[
        'source', 'publication', 'projection_repair',
        'lexical_rebuild', 'maintenance'
      ]
    )
  );

INSERT INTO focowiki.lexical_rebuild_work_items (
  knowledge_base_id,
  target_generation_id,
  source_file_id,
  source_revision_id,
  logical_path,
  target_search_schema_version,
  target_tokenizer_contract_version,
  target_segmentation_version,
  target_content_profile_version,
  target_graph_lexical_projection_version,
  state,
  next_attempt_at,
  max_attempts
)
SELECT
  rebuild.knowledge_base_id,
  rebuild.target_generation_id,
  source.id,
  source.active_revision_id,
  'pages/' || source.relative_path,
  rebuild.target_search_schema_version,
  rebuild.target_tokenizer_contract_version,
  rebuild.target_segmentation_version,
  rebuild.target_content_profile_version,
  rebuild.target_graph_lexical_projection_version,
  CASE
    WHEN reference.source_file_id IS NOT NULL
      AND document.id IS NOT NULL
      AND document.lifecycle_state = 'ready'
      AND document.source_revision_id = source.active_revision_id
      AND node.source_file_id IS NOT NULL
      AND node.path = 'pages/' || source.relative_path
      AND terms.source_file_id IS NOT NULL
      THEN 'completed'
    ELSE 'pending'
  END,
  now(),
  rebuild.max_attempts
FROM focowiki.knowledge_base_lexical_rebuilds rebuild
JOIN focowiki.source_files source
  ON source.knowledge_base_id = rebuild.knowledge_base_id
 AND source.deleted_at IS NULL
 AND source.deletion_intent_id IS NULL
LEFT JOIN focowiki.generation_search_projection_refs reference
  ON reference.knowledge_base_id = rebuild.knowledge_base_id
 AND reference.generation_id = rebuild.target_generation_id
 AND reference.source_file_id = source.id
 AND reference.source_revision_id = source.active_revision_id
 AND reference.logical_path = 'pages/' || source.relative_path
 AND reference.search_schema_version = rebuild.target_search_schema_version
 AND reference.tokenizer_contract_version =
       rebuild.target_tokenizer_contract_version
 AND reference.segmentation_version = rebuild.target_segmentation_version
LEFT JOIN focowiki.search_projection_documents document
  ON document.knowledge_base_id = reference.knowledge_base_id
 AND document.id = reference.search_document_id
 AND document.source_file_id = source.id
 AND document.source_revision_id = source.active_revision_id
 AND document.search_schema_version = rebuild.target_search_schema_version
 AND document.tokenizer_contract_version =
       rebuild.target_tokenizer_contract_version
 AND document.segmentation_version = rebuild.target_segmentation_version
LEFT JOIN focowiki.source_file_graph_nodes node
  ON node.knowledge_base_id = source.knowledge_base_id
 AND node.source_file_id = source.id
 AND node.tokenizer_contract_version =
       rebuild.target_tokenizer_contract_version
 AND node.lexical_projection_version =
       rebuild.target_content_profile_version
LEFT JOIN focowiki.source_file_graph_term_documents terms
  ON terms.knowledge_base_id = source.knowledge_base_id
 AND terms.source_file_id = source.id
 AND terms.source_revision_id = source.active_revision_id
 AND terms.tokenizer_contract_version =
       rebuild.target_tokenizer_contract_version
 AND terms.lexical_projection_version =
       rebuild.target_graph_lexical_projection_version
WHERE rebuild.target_generation_id IS NOT NULL
  AND rebuild.state NOT IN ('completed', 'cancelled')
ON CONFLICT (target_generation_id, source_file_id) DO NOTHING;

WITH progress AS (
  SELECT
    rebuild.knowledge_base_id,
    count(item.source_file_id)::bigint AS total_count,
    count(*) FILTER (WHERE item.state = 'completed')::bigint AS completed_count,
    count(*) FILTER (WHERE item.state = 'pending')::bigint AS pending_count,
    count(*) FILTER (WHERE item.state = 'running')::bigint AS running_count,
    count(*) FILTER (WHERE item.state = 'retry')::bigint AS retry_count,
    count(*) FILTER (WHERE item.state = 'failed')::bigint AS failed_count
  FROM focowiki.knowledge_base_lexical_rebuilds rebuild
  LEFT JOIN focowiki.lexical_rebuild_work_items item
    ON item.knowledge_base_id = rebuild.knowledge_base_id
   AND item.target_generation_id = rebuild.target_generation_id
  GROUP BY rebuild.knowledge_base_id
)
UPDATE focowiki.knowledge_base_lexical_rebuilds rebuild
SET processed_source_count = progress.completed_count,
    total_source_count = progress.total_count,
    pending_source_count = progress.pending_count,
    running_source_count = progress.running_count,
    retry_source_count = progress.retry_count,
    failed_source_count = progress.failed_count,
    last_progress_at = coalesce(rebuild.last_progress_at, rebuild.updated_at),
    last_worker_heartbeat_at = coalesce(
      rebuild.last_worker_heartbeat_at,
      rebuild.heartbeat_at
    )
FROM progress
WHERE progress.knowledge_base_id = rebuild.knowledge_base_id;

INSERT INTO focowiki.runtime_settings (key, value_json, source)
VALUES (
  'maintenance',
  jsonb_build_object(
    'reconciliationEnabled', true,
    'scanIntervalSeconds', 21600,
    'scanBatchSize', 500,
    'deletionBatchSize', 100,
    'quarantineGracePeriodSeconds', 86400,
    'confirmationPasses', 2,
    'maxAttempts', 5,
    'retryDelayMs', 30000,
    'migrationBackfillConcurrency', 2,
    'compactionConcurrency', 1,
    'projectionRepairConcurrency', 4,
    'projectionRepairDatabaseBatchSize', 2000,
    'projectionRepairObjectWriteConcurrency', 8,
    'lexicalRebuildConcurrency', 4,
    'lexicalRebuildSourceReadConcurrency', 2,
    'lexicalRebuildDatabaseWriteConcurrency', 2,
    'lexicalRebuildClaimBatchSize', 500,
    'lexicalRebuildDatabaseBatchSize', 50,
    'lexicalRebuildMaxInFlightSourceBytes', 67108864
  ),
  'bootstrap'
)
ON CONFLICT (key) DO UPDATE
SET value_json = jsonb_build_object(
       'lexicalRebuildConcurrency', 4,
       'lexicalRebuildSourceReadConcurrency', 2,
       'lexicalRebuildDatabaseWriteConcurrency', 2,
       'lexicalRebuildClaimBatchSize', 500,
       'lexicalRebuildDatabaseBatchSize', 50,
       'lexicalRebuildMaxInFlightSourceBytes', 67108864
     ) || focowiki.runtime_settings.value_json,
    version = focowiki.runtime_settings.version + 1,
    updated_at = now();

UPDATE focowiki.knowledge_base_projection_versions version
SET active_generation_id = knowledge_base.active_generation_id,
    updated_at = now()
FROM focowiki.knowledge_bases knowledge_base
WHERE knowledge_base.id = version.knowledge_base_id
  AND knowledge_base.deleted_at IS NULL
  AND knowledge_base.active_generation_id IS NOT NULL
  AND version.active_generation_id <> knowledge_base.active_generation_id;

UPDATE focowiki.runtime_generation
SET generation = 'lexical-rebuild-worker-v15'
WHERE singleton = true;
