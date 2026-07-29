ALTER TABLE focowiki.runtime_settings
  DROP CONSTRAINT runtime_settings_key_check;
ALTER TABLE focowiki.runtime_settings
  ADD CONSTRAINT runtime_settings_key_check CHECK (
    key = ANY (
      ARRAY[
        'rate_limits', 'worker', 'publication', 'graph', 'maintenance', 'search'
      ]
    )
  );

ALTER TABLE focowiki.generation_search_projection_refs
  ADD COLUMN path_revision bigint;

UPDATE focowiki.generation_search_projection_refs reference
SET path_revision = source.resource_revision
FROM focowiki.source_files source
WHERE source.knowledge_base_id = reference.knowledge_base_id
  AND source.id = reference.source_file_id;

ALTER TABLE focowiki.generation_search_projection_refs
  ALTER COLUMN path_revision SET NOT NULL,
  ADD CONSTRAINT generation_search_projection_refs_path_revision_check
    CHECK (path_revision > 0);

CREATE TABLE focowiki.knowledge_base_search_states (
  knowledge_base_id text PRIMARY KEY
    REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
  route_state text NOT NULL DEFAULT 'postgres_compatibility'
    CHECK (route_state IN ('postgres_compatibility', 'meilisearch')),
  active_epoch bigint NOT NULL DEFAULT 0
    CHECK (active_epoch >= 0),
  pending_epoch bigint,
  pending_activation_state text NOT NULL DEFAULT 'indexing'
    CHECK (pending_activation_state IN ('indexing', 'swapping')),
  pending_full_rebuild boolean NOT NULL DEFAULT false,
  active_generation_id text
    REFERENCES focowiki.publication_generations(id),
  pending_generation_id text
    REFERENCES focowiki.publication_generations(id),
  content_schema_version text,
  graph_schema_version text,
  content_settings_checksum text,
  graph_settings_checksum text,
  pending_content_schema_version text,
  pending_graph_schema_version text,
  pending_content_settings_checksum text,
  pending_graph_settings_checksum text,
  maintenance_required boolean NOT NULL DEFAULT true,
  last_maintenance_request_id text
    REFERENCES focowiki.knowledge_base_index_maintenance_requests(id)
    ON DELETE SET NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pending_epoch IS NULL OR pending_epoch = active_epoch + 1),
  CHECK (pending_epoch IS NOT NULL OR pending_activation_state = 'indexing'),
  CHECK (pending_epoch IS NOT NULL OR pending_full_rebuild = false),
  CHECK (
    (pending_epoch IS NULL AND pending_generation_id IS NULL)
    OR (
      pending_epoch IS NOT NULL
      AND pending_generation_id IS NOT NULL
      AND pending_content_schema_version IS NOT NULL
      AND pending_graph_schema_version IS NOT NULL
      AND pending_content_settings_checksum ~ '^[a-f0-9]{64}$'
      AND pending_graph_settings_checksum ~ '^[a-f0-9]{64}$'
    )
  ),
  CHECK (
    pending_epoch IS NOT NULL
    OR (
      pending_content_schema_version IS NULL
      AND pending_graph_schema_version IS NULL
      AND pending_content_settings_checksum IS NULL
      AND pending_graph_settings_checksum IS NULL
    )
  ),
  CHECK (
    route_state = 'postgres_compatibility'
    OR (
      active_epoch > 0
      AND active_generation_id IS NOT NULL
      AND content_schema_version IS NOT NULL
      AND graph_schema_version IS NOT NULL
      AND content_settings_checksum ~ '^[a-f0-9]{64}$'
      AND graph_settings_checksum ~ '^[a-f0-9]{64}$'
      AND activated_at IS NOT NULL
    )
  )
);

CREATE INDEX knowledge_base_search_states_maintenance_idx
  ON focowiki.knowledge_base_search_states (
    maintenance_required,
    updated_at,
    knowledge_base_id
  )
  WHERE maintenance_required = true;

CREATE TABLE focowiki.search_projection_work (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL
    REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
  epoch bigint NOT NULL CHECK (epoch > 0),
  generation_id text NOT NULL
    REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
  maintenance_request_id text
    REFERENCES focowiki.knowledge_base_index_maintenance_requests(id)
    ON DELETE CASCADE,
  index_kind text NOT NULL CHECK (index_kind IN ('content', 'graph')),
  work_kind text NOT NULL CHECK (
    work_kind IN (
      'prepare_index', 'documents', 'delete_documents',
      'validate', 'activate', 'cleanup'
    )
  ),
  batch_ordinal integer NOT NULL DEFAULT 0 CHECK (batch_ordinal >= 0),
  payload_checksum text NOT NULL CHECK (payload_checksum ~ '^[a-f0-9]{64}$'),
  document_count integer NOT NULL DEFAULT 0 CHECK (document_count >= 0),
  compressed_bytes bigint NOT NULL DEFAULT 0 CHECK (compressed_bytes >= 0),
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN (
      'queued', 'submitted', 'succeeded', 'retry',
      'failed', 'canceled', 'superseded'
    )
  ),
  task_uid bigint CHECK (task_uid IS NULL OR task_uid >= 0),
  task_correlation text NOT NULL,
  checkpoint_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(checkpoint_json) = 'object'),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  safe_error_code text,
  safe_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    knowledge_base_id, generation_id,
    epoch,
    index_kind,
    work_kind,
    batch_ordinal,
    payload_checksum
  ),
  CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (
      lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  ),
  CHECK (
    state <> 'submitted'
    OR (task_uid IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  CHECK (
    state NOT IN ('failed', 'retry')
    OR (safe_error_code IS NOT NULL AND safe_error_message IS NOT NULL)
  ),
  CHECK (octet_length(task_correlation) BETWEEN 1 AND 200),
  CHECK (octet_length(checkpoint_json::text) <= 65536),
  CHECK (safe_error_code IS NULL OR octet_length(safe_error_code) <= 120),
  CHECK (safe_error_message IS NULL OR octet_length(safe_error_message) <= 500)
);

CREATE INDEX search_projection_work_claim_idx
  ON focowiki.search_projection_work (
    state,
    run_after,
    created_at,
    id
  )
  WHERE state IN ('queued', 'submitted', 'retry');

CREATE INDEX search_projection_work_epoch_idx
  ON focowiki.search_projection_work (
    knowledge_base_id,
    epoch,
    index_kind,
    work_kind,
    batch_ordinal
  );

CREATE INDEX search_projection_work_task_idx
  ON focowiki.search_projection_work (task_uid)
  WHERE task_uid IS NOT NULL;

INSERT INTO focowiki.knowledge_base_search_states (
  knowledge_base_id,
  route_state,
  active_epoch,
  active_generation_id,
  maintenance_required
)
SELECT
  knowledge_base.id,
  'postgres_compatibility',
  0,
  knowledge_base.active_generation_id,
  true
FROM focowiki.knowledge_bases knowledge_base
WHERE knowledge_base.deleted_at IS NULL
ON CONFLICT (knowledge_base_id) DO NOTHING;

CREATE OR REPLACE FUNCTION focowiki.bootstrap_knowledge_base_search_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO focowiki.knowledge_base_search_states (
    knowledge_base_id,
    route_state,
    active_epoch,
    active_generation_id,
    maintenance_required
  )
  VALUES (
    NEW.id,
    'postgres_compatibility',
    0,
    NEW.active_generation_id,
    true
  )
  ON CONFLICT (knowledge_base_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_bases_bootstrap_search_state
  ON focowiki.knowledge_bases;
CREATE TRIGGER knowledge_bases_bootstrap_search_state
AFTER INSERT ON focowiki.knowledge_bases
FOR EACH ROW
EXECUTE FUNCTION focowiki.bootstrap_knowledge_base_search_state();

INSERT INTO focowiki.runtime_settings (key, value_json, source)
VALUES (
  'search',
  jsonb_build_object(
    'requestTimeoutMs', 3000,
    'engineSearchCutoffMs', 1000,
    'branchCandidateLimit', 200,
    'fusedCandidateLimit', 100,
    'overfetchFactor', 3,
    'graphSeedLimit', 100,
    'graphNeighborLimit', 20,
    'cacheTtlSeconds', 15,
    'indexBatchDocumentCount', 500,
    'indexBatchCompressedBytes', 8388608,
    'maxInFlightTasks', 8,
    'taskPollIntervalMs', 500,
    'taskTimeoutMs', 600000,
    'maxAttempts', 5,
    'retryDelayMs', 2000,
    'cleanupBatchSize', 1000,
    'stagingRetentionHours', 24,
    'cropLength', 1200
  ),
  'bootstrap'
)
ON CONFLICT (key) DO NOTHING;

UPDATE focowiki.runtime_generation
SET generation = 'meilisearch-search-projection-v18'
WHERE singleton = true;
