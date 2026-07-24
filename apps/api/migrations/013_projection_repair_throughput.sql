ALTER TABLE focowiki.knowledge_base_projection_repairs
  ADD COLUMN planner_version integer DEFAULT 1 NOT NULL,
  ADD COLUMN base_resource_revision integer DEFAULT 0 NOT NULL,
  ADD COLUMN source_watermark integer DEFAULT 0 NOT NULL,
  ADD COLUMN activation_watermark integer DEFAULT 0 NOT NULL,
  ADD COLUMN settings_revision integer DEFAULT 0 NOT NULL,
  ADD COLUMN settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN current_phase text DEFAULT 'planning' NOT NULL,
  ADD COLUMN expected_subtask_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN completed_subtask_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN expected_record_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN completed_record_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN expected_directory_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN completed_directory_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN expected_object_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN object_write_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN object_reuse_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN retry_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN required_projection_kinds text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN completed_projection_kinds text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN recent_records_per_second double precision,
  ADD COLUMN rolling_batch_latency_ms double precision,
  ADD COLUMN started_at timestamp with time zone,
  ADD COLUMN last_progress_at timestamp with time zone,
  ADD COLUMN last_heartbeat_at timestamp with time zone,
  ADD COLUMN estimated_completion_at timestamp with time zone;

ALTER TABLE focowiki.knowledge_base_projection_repairs
  ADD CONSTRAINT knowledge_base_projection_repairs_planner_version_check
    CHECK (planner_version > 0),
  ADD CONSTRAINT knowledge_base_projection_repairs_watermark_check
    CHECK (
      base_resource_revision >= 0
      AND source_watermark >= 0
      AND activation_watermark >= 0
    ),
  ADD CONSTRAINT knowledge_base_projection_repairs_settings_check
    CHECK (jsonb_typeof(settings_snapshot_json) = 'object'),
  ADD CONSTRAINT knowledge_base_projection_repairs_projection_kinds_check
    CHECK (
      required_projection_kinds <@ ARRAY['tree', 'directory', 'graph']::text[]
      AND completed_projection_kinds <@ required_projection_kinds
    ),
  ADD CONSTRAINT knowledge_base_projection_repairs_runtime_metrics_check
    CHECK (
      (recent_records_per_second IS NULL OR recent_records_per_second >= 0)
      AND (rolling_batch_latency_ms IS NULL OR rolling_batch_latency_ms >= 0)
    ),
  ADD CONSTRAINT knowledge_base_projection_repairs_progress_check
    CHECK (
      expected_subtask_count >= 0
      AND completed_subtask_count >= 0
      AND expected_record_count >= 0
      AND completed_record_count >= 0
      AND expected_directory_count >= 0
      AND completed_directory_count >= 0
      AND expected_object_count >= 0
      AND object_write_count >= 0
      AND object_reuse_count >= 0
      AND retry_count >= 0
    );

UPDATE focowiki.knowledge_base_projection_repairs
SET current_phase = CASE
      WHEN state IN ('completed', 'superseded', 'failed') THEN state
      WHEN NOT checkpoint_json @> '{"treeComplete": true}'::jsonb THEN 'tree'
      WHEN NOT checkpoint_json @> '{"navigationComplete": true}'::jsonb THEN 'directory'
      WHEN NOT checkpoint_json @> '{"graphComplete": true}'::jsonb THEN 'graph'
      ELSE 'finalizing'
    END,
    started_at = coalesce(started_at, created_at),
    last_progress_at = coalesce(last_progress_at, updated_at),
    last_heartbeat_at = coalesce(last_heartbeat_at, updated_at);

WITH ranked AS (
  SELECT knowledge_base_id,
         repair_version,
         row_number() OVER (
           PARTITION BY knowledge_base_id
           ORDER BY repair_version DESC, updated_at DESC
         ) AS ordinal
  FROM focowiki.knowledge_base_projection_repairs
  WHERE state IN ('pending', 'running', 'retry')
)
UPDATE focowiki.knowledge_base_projection_repairs repair
SET state = 'superseded',
    current_phase = 'superseded',
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
FROM ranked
WHERE repair.knowledge_base_id = ranked.knowledge_base_id
  AND repair.repair_version = ranked.repair_version
  AND ranked.ordinal > 1;

CREATE UNIQUE INDEX knowledge_base_projection_repairs_one_active_version_idx
  ON focowiki.knowledge_base_projection_repairs (knowledge_base_id)
  WHERE state IN ('pending', 'running', 'retry');

ALTER TABLE focowiki.role_heartbeats
  DROP CONSTRAINT role_heartbeats_role_check;

ALTER TABLE focowiki.role_heartbeats
  ADD CONSTRAINT role_heartbeats_role_check CHECK (
    role = ANY (
      ARRAY['source', 'publication', 'projection_repair', 'maintenance']
    )
  );

ALTER TABLE focowiki.role_jobs
  DROP CONSTRAINT role_jobs_role_check;

ALTER TABLE focowiki.role_jobs
  ADD CONSTRAINT role_jobs_role_check CHECK (
    role = ANY (
      ARRAY['source', 'publication', 'projection_repair', 'maintenance']
    )
  );

CREATE TABLE focowiki.projection_repair_subtasks (
    id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    repair_version integer NOT NULL,
    target_generation_id text NOT NULL,
    base_generation_id text NOT NULL,
    task_kind text NOT NULL,
    partition_key text NOT NULL,
    phase_order integer NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    source_watermark integer DEFAULT 0 NOT NULL,
    settings_revision integer DEFAULT 0 NOT NULL,
    settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    expected_record_count bigint DEFAULT 0 NOT NULL,
    processed_record_count bigint DEFAULT 0 NOT NULL,
    object_write_count integer DEFAULT 0 NOT NULL,
    object_reuse_count integer DEFAULT 0 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    checkpoint_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_repair_subtasks_kind_check CHECK (
      task_kind = ANY (
        ARRAY[
          'tree_partition', 'directory', 'graph_partition',
          'graph_finalize', 'tree_rebase', 'directory_rebase',
          'graph_rebase', 'graph_rebase_finalize', 'finalize'
        ]
      )
    ),
    CONSTRAINT projection_repair_subtasks_state_check CHECK (
      state = ANY (
        ARRAY['pending', 'running', 'retry', 'completed', 'failed', 'cancelled']
      )
    ),
    CONSTRAINT projection_repair_subtasks_phase_check CHECK (phase_order > 0),
    CONSTRAINT projection_repair_subtasks_watermark_check CHECK (source_watermark >= 0),
    CONSTRAINT projection_repair_subtasks_settings_check CHECK (
      jsonb_typeof(settings_snapshot_json) = 'object'
    ),
    CONSTRAINT projection_repair_subtasks_checkpoint_check CHECK (
      jsonb_typeof(checkpoint_json) = 'object'
    ),
    CONSTRAINT projection_repair_subtasks_progress_check CHECK (
      expected_record_count >= 0
      AND processed_record_count >= 0
      AND object_write_count >= 0
      AND object_reuse_count >= 0
      AND attempt_count >= 0
      AND max_attempts > 0
    ),
    CONSTRAINT projection_repair_subtasks_identity_key UNIQUE (
      target_generation_id, task_kind, partition_key
    ),
    CONSTRAINT projection_repair_subtasks_repair_fkey
      FOREIGN KEY (knowledge_base_id, repair_version)
      REFERENCES focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version
      ) ON DELETE CASCADE,
    CONSTRAINT projection_repair_subtasks_target_generation_fkey
      FOREIGN KEY (target_generation_id)
      REFERENCES focowiki.publication_generations (id) ON DELETE CASCADE,
    CONSTRAINT projection_repair_subtasks_base_generation_fkey
      FOREIGN KEY (base_generation_id)
      REFERENCES focowiki.publication_generations (id) ON DELETE CASCADE
);

CREATE INDEX projection_repair_subtasks_claim_idx
  ON focowiki.projection_repair_subtasks (
    state, run_after, phase_order, knowledge_base_id, partition_key, id
  )
  WHERE state IN ('pending', 'retry', 'running');

CREATE INDEX projection_repair_subtasks_repair_progress_idx
  ON focowiki.projection_repair_subtasks (
    knowledge_base_id, repair_version, state, task_kind
  );

CREATE INDEX projection_repair_subtasks_lease_idx
  ON focowiki.projection_repair_subtasks (lease_expires_at, id)
  WHERE state = 'running';

CREATE TABLE focowiki.knowledge_base_projection_versions (
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    format_version integer NOT NULL,
    input_version integer NOT NULL,
    active_generation_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_base_projection_versions_pkey PRIMARY KEY (
      knowledge_base_id, projection_kind
    ),
    CONSTRAINT knowledge_base_projection_versions_kind_check CHECK (
      projection_kind = ANY (ARRAY['tree', 'directory', 'graph'])
    ),
    CONSTRAINT knowledge_base_projection_versions_version_check CHECK (
      format_version > 0 AND input_version > 0
    ),
    CONSTRAINT knowledge_base_projection_versions_knowledge_base_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases (id) ON DELETE CASCADE,
    CONSTRAINT knowledge_base_projection_versions_generation_fkey
      FOREIGN KEY (active_generation_id)
      REFERENCES focowiki.publication_generations (id) ON DELETE CASCADE
);

CREATE INDEX knowledge_base_projection_versions_generation_idx
  ON focowiki.knowledge_base_projection_versions (
    knowledge_base_id, active_generation_id, projection_kind
  );

UPDATE focowiki.runtime_generation
SET generation = 'projection-repair-throughput-v13'
WHERE singleton = true;
