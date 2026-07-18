ALTER TABLE ONLY focowiki.publication_generations
  ADD COLUMN generation_kind text DEFAULT 'normal' NOT NULL,
  ADD CONSTRAINT publication_generations_kind_check CHECK (
    generation_kind = ANY (ARRAY['normal', 'projection_repair'])
  );

DROP INDEX focowiki.publication_generations_one_frozen_idx;
CREATE UNIQUE INDEX publication_generations_one_frozen_idx
  ON focowiki.publication_generations (knowledge_base_id)
  WHERE state = ANY (ARRAY['frozen', 'building', 'validating'])
    AND generation_kind = 'normal';
CREATE UNIQUE INDEX publication_generations_one_projection_repair_idx
  ON focowiki.publication_generations (knowledge_base_id)
  WHERE state = ANY (ARRAY['building', 'validating'])
    AND generation_kind = 'projection_repair';

CREATE TABLE focowiki.generation_tree_directory_stats (
    knowledge_base_id text NOT NULL,
    generation_id text NOT NULL,
    path text NOT NULL,
    parent_path text NOT NULL,
    direct_entry_count integer DEFAULT 0 NOT NULL,
    direct_directory_count integer DEFAULT 0 NOT NULL,
    direct_file_count integer DEFAULT 0 NOT NULL,
    descendant_file_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_tree_directory_stats_counts_check CHECK (
      direct_entry_count >= 0
      AND direct_directory_count >= 0
      AND direct_file_count >= 0
      AND descendant_file_count >= 0
      AND direct_entry_count = direct_directory_count + direct_file_count
    ),
    CONSTRAINT generation_tree_directory_stats_pkey PRIMARY KEY (generation_id, path),
    CONSTRAINT generation_tree_directory_stats_generation_id_fkey
      FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT generation_tree_directory_stats_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX generation_tree_directory_stats_parent_idx
  ON focowiki.generation_tree_directory_stats (knowledge_base_id, generation_id, parent_path, path);
CREATE INDEX generation_tree_directory_stats_path_idx
  ON focowiki.generation_tree_directory_stats (knowledge_base_id, generation_id, path text_pattern_ops);

CREATE TABLE focowiki.generation_graph_summaries (
    knowledge_base_id text NOT NULL,
    generation_id text NOT NULL,
    node_count bigint DEFAULT 0 NOT NULL,
    edge_count bigint DEFAULT 0 NOT NULL,
    graph_index_available boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_graph_summaries_counts_check CHECK (node_count >= 0 AND edge_count >= 0),
    CONSTRAINT generation_graph_summaries_pkey PRIMARY KEY (generation_id),
    CONSTRAINT generation_graph_summaries_generation_id_fkey
      FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT generation_graph_summaries_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX generation_graph_summaries_lookup_idx
  ON focowiki.generation_graph_summaries (knowledge_base_id, generation_id);

CREATE TABLE focowiki.knowledge_base_projection_repairs (
    knowledge_base_id text NOT NULL,
    repair_version integer NOT NULL,
    base_generation_id text NOT NULL,
    target_generation_id text,
    state text DEFAULT 'pending' NOT NULL,
    checkpoint_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    lease_token text,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error_code text,
    last_error_message text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_base_projection_repairs_pkey PRIMARY KEY (knowledge_base_id, repair_version),
    CONSTRAINT knowledge_base_projection_repairs_state_check CHECK (
      state = ANY (ARRAY['pending', 'running', 'retry', 'superseded', 'completed', 'failed'])
    ),
    CONSTRAINT knowledge_base_projection_repairs_attempt_check CHECK (attempt_count >= 0),
    CONSTRAINT knowledge_base_projection_repairs_checkpoint_check CHECK (jsonb_typeof(checkpoint_json) = 'object'),
    CONSTRAINT knowledge_base_projection_repairs_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT knowledge_base_projection_repairs_base_generation_id_fkey
      FOREIGN KEY (base_generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT knowledge_base_projection_repairs_target_generation_id_fkey
      FOREIGN KEY (target_generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE SET NULL
);

CREATE INDEX knowledge_base_projection_repairs_claim_idx
  ON focowiki.knowledge_base_projection_repairs (state, next_attempt_at, knowledge_base_id)
  WHERE state = ANY (ARRAY['pending', 'retry']);
CREATE INDEX knowledge_base_projection_repairs_lease_idx
  ON focowiki.knowledge_base_projection_repairs (lease_expires_at)
  WHERE state = 'running';

ALTER TABLE ONLY focowiki.immutable_objects
  DROP CONSTRAINT immutable_objects_lifecycle_check;
ALTER TABLE ONLY focowiki.immutable_objects
  ALTER COLUMN verified_at DROP NOT NULL,
  ALTER COLUMN verified_at DROP DEFAULT,
  ADD COLUMN write_token text,
  ADD COLUMN write_started_at timestamp with time zone,
  ADD COLUMN write_attempt_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN last_write_error_code text,
  ADD COLUMN last_storage_seen_cycle_id text,
  ADD COLUMN last_storage_seen_at timestamp with time zone,
  ADD COLUMN integrity_error_code text,
  ADD COLUMN integrity_checked_at timestamp with time zone;
ALTER TABLE ONLY focowiki.immutable_objects
  ADD CONSTRAINT immutable_objects_write_attempt_check CHECK (write_attempt_count >= 0),
  ADD CONSTRAINT immutable_objects_lifecycle_check CHECK (
    (lifecycle_state = 'writing' AND deletion_job_id IS NULL AND write_token IS NOT NULL
      AND write_started_at IS NOT NULL AND verified_at IS NULL)
    OR (lifecycle_state = 'active' AND deletion_job_id IS NULL AND verified_at IS NOT NULL)
    OR (lifecycle_state = 'deleting' AND deletion_job_id IS NOT NULL)
  );

CREATE INDEX immutable_objects_writing_recovery_idx
  ON focowiki.immutable_objects (write_started_at, checksum_sha256, format_version)
  WHERE lifecycle_state = 'writing';

CREATE TABLE focowiki.storage_reconciliation_cycles (
    prefix text NOT NULL,
    cycle_id text,
    state text DEFAULT 'idle' NOT NULL,
    continuation_token text,
    verification_cursor text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    scan_started_at timestamp with time zone,
    scan_completed_at timestamp with time zone,
    next_scan_at timestamp with time zone DEFAULT now() NOT NULL,
    listed_count bigint DEFAULT 0 NOT NULL,
    quarantined_count bigint DEFAULT 0 NOT NULL,
    deleted_count bigint DEFAULT 0 NOT NULL,
    missing_count bigint DEFAULT 0 NOT NULL,
    retry_count bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_reconciliation_cycles_pkey PRIMARY KEY (prefix),
    CONSTRAINT storage_reconciliation_cycles_state_check CHECK (
      state = ANY (ARRAY['idle', 'scanning', 'verifying', 'failed'])
    ),
    CONSTRAINT storage_reconciliation_cycles_counts_check CHECK (
      listed_count >= 0 AND quarantined_count >= 0 AND deleted_count >= 0
      AND missing_count >= 0 AND retry_count >= 0
    )
);

CREATE INDEX storage_reconciliation_cycles_claim_idx
  ON focowiki.storage_reconciliation_cycles (next_scan_at, prefix)
  WHERE state = ANY (ARRAY['idle', 'failed']);
CREATE INDEX storage_reconciliation_cycles_lease_idx
  ON focowiki.storage_reconciliation_cycles (lease_expires_at)
  WHERE state = ANY (ARRAY['scanning', 'verifying']);

CREATE TABLE focowiki.storage_reconciliation_candidates (
    prefix text NOT NULL,
    object_key text NOT NULL,
    checksum_sha256 text NOT NULL,
    format_version integer NOT NULL,
    state text DEFAULT 'quarantined' NOT NULL,
    first_seen_cycle_id text NOT NULL,
    last_seen_cycle_id text NOT NULL,
    confirmation_count integer DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    observed_size_bytes bigint,
    observed_etag text,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error_code text,
    resolved_at timestamp with time zone,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_reconciliation_candidates_pkey PRIMARY KEY (prefix, object_key),
    CONSTRAINT storage_reconciliation_candidates_state_check CHECK (
      state = ANY (ARRAY['quarantined', 'deleting', 'deleted', 'resolved', 'failed'])
    ),
    CONSTRAINT storage_reconciliation_candidates_counts_check CHECK (
      confirmation_count >= 1 AND attempt_count >= 0
      AND format_version > 0
      AND checksum_sha256 ~ '^[a-f0-9]{64}$'
      AND (observed_size_bytes IS NULL OR observed_size_bytes >= 0)
    )
);

CREATE INDEX storage_reconciliation_candidates_claim_idx
  ON focowiki.storage_reconciliation_candidates (prefix, state, next_attempt_at, first_seen_at, object_key)
  WHERE state = ANY (ARRAY['quarantined', 'failed']);
CREATE INDEX storage_reconciliation_candidates_delete_order_idx
  ON focowiki.storage_reconciliation_candidates (prefix, first_seen_at, object_key)
  WHERE state = ANY (ARRAY['quarantined', 'failed']);
CREATE INDEX storage_reconciliation_candidates_cycle_idx
  ON focowiki.storage_reconciliation_candidates (prefix, last_seen_cycle_id, object_key);

CREATE INDEX immutable_objects_storage_verification_idx
  ON focowiki.immutable_objects (last_storage_seen_cycle_id, object_key)
  WHERE lifecycle_state IN ('writing', 'active');

ALTER TABLE ONLY focowiki.runtime_settings
  DROP CONSTRAINT runtime_settings_key_check;
ALTER TABLE ONLY focowiki.runtime_settings
  ADD CONSTRAINT runtime_settings_key_check CHECK (
    key = ANY (ARRAY['rate_limits', 'worker', 'publication', 'graph', 'maintenance'])
  );

UPDATE focowiki.runtime_generation
SET generation = 'tree-graph-storage-reconciliation-v2'
WHERE singleton = true AND generation = 'incremental-sharded-publication-v1';
