CREATE SCHEMA IF NOT EXISTS focowiki;

CREATE TABLE IF NOT EXISTS focowiki.knowledge_bases (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  active_release_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (id ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$')
);

CREATE TABLE IF NOT EXISTS focowiki.source_files (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  original_name text NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_suggestions_json jsonb,
  processing_status text NOT NULL DEFAULT 'queued',
  processing_stage text NOT NULL DEFAULT 'upload_storage',
  processing_started_at timestamptz,
  processing_ended_at timestamptz,
  processing_error_code text,
  processing_error_message text,
  generated_output_status text NOT NULL DEFAULT 'pending',
  generated_bundle_file_id text,
  generated_bundle_file_path text,
  graph_relationship_count integer NOT NULL DEFAULT 0,
  graph_top_relationships_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_invocation_status text,
  model_invocation_model_name text,
  model_invocation_started_at timestamptz,
  model_invocation_ended_at timestamptz,
  model_invocation_warning_count integer,
  model_invocation_error_code text,
  publication_dirty_at timestamptz,
  publication_visible_at timestamptz,
  publication_error_code text,
  publication_error_message text,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  task_deleted_at timestamptz,
  deleted_at timestamptz,
  CHECK (processing_status IN ('queued', 'running', 'completed', 'failed')),
  CHECK (generated_output_status IN ('pending', 'visible', 'unavailable')),
  CHECK (processing_stage IN (
    'upload_storage',
    'metadata_resolution',
    'llm_suggestion',
    'graph_generation',
    'okf_validation',
    'bundle_generation',
    'index_publication',
    'release_activation'
  )),
  CHECK (processing_ended_at IS NULL OR processing_started_at IS NULL OR processing_ended_at >= processing_started_at)
);

ALTER TABLE focowiki.source_files
  ADD COLUMN IF NOT EXISTS model_suggestions_json jsonb,
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS processing_stage text NOT NULL DEFAULT 'upload_storage',
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_error_code text,
  ADD COLUMN IF NOT EXISTS processing_error_message text,
  ADD COLUMN IF NOT EXISTS generated_output_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS generated_bundle_file_id text,
  ADD COLUMN IF NOT EXISTS generated_bundle_file_path text,
  ADD COLUMN IF NOT EXISTS graph_relationship_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_top_relationships_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS model_invocation_status text,
  ADD COLUMN IF NOT EXISTS model_invocation_model_name text,
  ADD COLUMN IF NOT EXISTS model_invocation_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS model_invocation_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS model_invocation_warning_count integer,
  ADD COLUMN IF NOT EXISTS model_invocation_error_code text,
  ADD COLUMN IF NOT EXISTS publication_dirty_at timestamptz,
  ADD COLUMN IF NOT EXISTS publication_visible_at timestamptz,
  ADD COLUMN IF NOT EXISTS publication_error_code text,
  ADD COLUMN IF NOT EXISTS publication_error_message text,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS task_deleted_at timestamptz;

UPDATE focowiki.source_files
SET processing_status = 'queued'
WHERE processing_status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'focowiki.source_files'::regclass
      AND conname = 'source_files_processing_status_check'
  ) THEN
    ALTER TABLE focowiki.source_files
      ADD CONSTRAINT source_files_processing_status_check
      CHECK (processing_status IN ('queued', 'running', 'completed', 'failed'));
  END IF;
END $$;

ALTER TABLE focowiki.source_files
  DROP CONSTRAINT IF EXISTS source_files_processing_status_check,
  ADD CONSTRAINT source_files_processing_status_check
  CHECK (processing_status IN ('queued', 'running', 'completed', 'failed'));

ALTER TABLE focowiki.source_files
  DROP CONSTRAINT IF EXISTS source_files_generated_output_status_check,
  ADD CONSTRAINT source_files_generated_output_status_check
  CHECK (generated_output_status IN ('pending', 'visible', 'unavailable'));

ALTER TABLE focowiki.source_files
  DROP CONSTRAINT IF EXISTS source_files_model_invocation_status_check,
  ADD CONSTRAINT source_files_model_invocation_status_check
  CHECK (
    model_invocation_status IS NULL OR
    model_invocation_status IN ('running', 'completed', 'failed', 'skipped')
  );

ALTER TABLE focowiki.source_files
  DROP CONSTRAINT IF EXISTS source_files_graph_relationship_count_check,
  ADD CONSTRAINT source_files_graph_relationship_count_check
  CHECK (graph_relationship_count >= 0);

ALTER TABLE focowiki.source_files
  DROP CONSTRAINT IF EXISTS source_files_graph_top_relationships_json_check,
  ADD CONSTRAINT source_files_graph_top_relationships_json_check
  CHECK (jsonb_typeof(graph_top_relationships_json) = 'array');

ALTER TABLE focowiki.source_files
  DROP CONSTRAINT IF EXISTS source_files_processing_stage_check,
  ADD CONSTRAINT source_files_processing_stage_check
  CHECK (processing_stage IN (
    'upload_storage',
    'metadata_resolution',
    'llm_suggestion',
    'graph_generation',
    'okf_validation',
    'bundle_generation',
    'index_publication',
    'release_activation'
  ));

UPDATE focowiki.source_files
SET
  processing_stage = 'release_activation',
  processing_ended_at = COALESCE(publication_visible_at, processing_ended_at)
WHERE processing_status = 'completed'
  AND generated_output_status = 'visible'
  AND processing_stage = 'index_publication';

CREATE TABLE IF NOT EXISTS focowiki.model_invocations (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  source_file_id text NOT NULL REFERENCES focowiki.source_files(id),
  model_name text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

UPDATE focowiki.source_files source
SET
  model_invocation_status = model.status,
  model_invocation_model_name = model.model_name,
  model_invocation_started_at = model.started_at,
  model_invocation_ended_at = model.ended_at,
  model_invocation_warning_count = model.warning_count,
  model_invocation_error_code = model.error_code
FROM (
  SELECT DISTINCT ON (source_file_id)
    source_file_id,
    status,
    model_name,
    started_at,
    ended_at,
    warning_count,
    error_code
  FROM focowiki.model_invocations
  ORDER BY source_file_id, created_at DESC, id DESC
) model
WHERE source.id = model.source_file_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'focowiki.source_files'::regclass
      AND conname = 'source_files_processing_time_check'
  ) THEN
    ALTER TABLE focowiki.source_files
      ADD CONSTRAINT source_files_processing_time_check
      CHECK (processing_ended_at IS NULL OR processing_started_at IS NULL OR processing_ended_at >= processing_started_at);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS focowiki.releases (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  bundle_root_key text NOT NULL,
  generated_at timestamptz NOT NULL,
  published_at timestamptz,
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  manifest_checksum_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS focowiki.publication_jobs (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  mode text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  dirty_source_count integer NOT NULL DEFAULT 0 CHECK (dirty_source_count >= 0),
  release_id text REFERENCES focowiki.releases(id),
  started_at timestamptz,
  ended_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode IN ('batch', 'manual', 'per_file')),
  CHECK (reason IN ('bootstrap', 'batch_threshold', 'batch_interval', 'manual', 'per_file', 'deletion')),
  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS focowiki.source_file_events (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  source_file_id text NOT NULL REFERENCES focowiki.source_files(id),
  stage_key text NOT NULL,
  message_key text NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  severity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stage_key IN (
    'upload_storage',
    'source_deletion',
    'metadata_resolution',
    'llm_suggestion',
    'graph_generation',
    'okf_validation',
    'bundle_generation',
    'index_publication',
    'release_activation'
  )),
  CHECK (severity IN ('info', 'warning', 'error')),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS focowiki.source_file_retry_attempts (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  source_file_id text NOT NULL REFERENCES focowiki.source_files(id),
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('running', 'completed', 'failed')),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS focowiki.bundle_files (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  release_id text NOT NULL REFERENCES focowiki.releases(id),
  source_file_id text REFERENCES focowiki.source_files(id),
  file_kind text NOT NULL,
  logical_path text NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 text NOT NULL,
  okf_type text,
  title text,
  description text,
  tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  frontmatter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, logical_path),
  CHECK (file_kind IN (
    'page',
    'index',
    'log',
    'schema',
    'manifest_index',
    'manifest_index_shard',
    'search_index',
    'search_index_shard',
    'link_index',
    'link_index_shard',
    'graph_index',
    'graph_manifest',
    'graph_node_index',
    'graph_edge_shard',
    'graph_file'
  )),
  CHECK (
    (file_kind = 'page' AND source_file_id IS NOT NULL)
    OR (file_kind <> 'page' AND source_file_id IS NULL)
  )
);

UPDATE focowiki.source_files source
SET
  generated_bundle_file_id = output.bundle_file_id,
  generated_bundle_file_path = output.logical_path
FROM (
  SELECT DISTINCT ON (file.source_file_id)
    file.source_file_id,
    file.id AS bundle_file_id,
    file.logical_path
  FROM focowiki.bundle_files file
  JOIN focowiki.knowledge_bases knowledge_base
    ON knowledge_base.id = file.knowledge_base_id
   AND knowledge_base.active_release_id = file.release_id
  WHERE file.file_kind = 'page'
    AND file.source_file_id IS NOT NULL
  ORDER BY file.source_file_id, file.logical_path ASC, file.id ASC
) output
WHERE source.id = output.source_file_id;

CREATE TABLE IF NOT EXISTS focowiki.source_file_graph_nodes (
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  source_file_id text NOT NULL REFERENCES focowiki.source_files(id),
  path text NOT NULL,
  title text NOT NULL,
  type text,
  description text,
  summary text,
  subjects_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  entities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  explicit_references_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  relationship_hints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  headings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  keywords_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  language text,
  profile_version text,
  profile_source text,
  profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_base_id, source_file_id)
);

CREATE TABLE IF NOT EXISTS focowiki.source_file_graph_edges (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  from_source_file_id text NOT NULL REFERENCES focowiki.source_files(id),
  to_source_file_id text NOT NULL REFERENCES focowiki.source_files(id),
  relation_type text NOT NULL,
  weight numeric NOT NULL CHECK (weight >= 0 AND weight <= 1),
  reason text NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'accepted',
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_base_id, from_source_file_id, to_source_file_id, relation_type),
  CHECK (status IN ('accepted', 'rejected')),
  CHECK (from_source_file_id <> to_source_file_id)
);

CREATE TABLE IF NOT EXISTS focowiki.source_file_graph_jobs (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  source_file_id text NOT NULL REFERENCES focowiki.source_files(id),
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('running', 'completed', 'failed')),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS focowiki.worker_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  source_file_id text REFERENCES focowiki.source_files(id),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_after timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('source_file_processing', 'publication')),
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter', 'cancelled')),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  CHECK (failed_at IS NULL OR started_at IS NULL OR failed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS focowiki.worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  active_job_count integer NOT NULL DEFAULT 0 CHECK (active_job_count >= 0),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS focowiki.worker_queue_summaries (
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  kind text NOT NULL,
  status text NOT NULL,
  job_count bigint NOT NULL DEFAULT 0 CHECK (job_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_base_id, kind, status),
  CHECK (kind IN ('source_file_processing', 'publication')),
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'))
);

ALTER TABLE focowiki.source_file_graph_nodes
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS subjects_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS entities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS explicit_references_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS relationship_hints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS language text,
  ADD COLUMN IF NOT EXISTS profile_version text,
  ADD COLUMN IF NOT EXISTS profile_source text,
  ADD COLUMN IF NOT EXISTS profile_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE focowiki.source_file_graph_edges
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'accepted';

ALTER TABLE focowiki.source_file_graph_edges
  DROP CONSTRAINT IF EXISTS source_file_graph_edges_status_check,
  ADD CONSTRAINT source_file_graph_edges_status_check
  CHECK (status IN ('accepted', 'rejected'));

UPDATE focowiki.source_files source
SET graph_relationship_count = counts.relationship_count
FROM (
  SELECT knowledge_base_id, source_file_id, count(*)::integer AS relationship_count
  FROM (
    SELECT knowledge_base_id, from_source_file_id AS source_file_id
    FROM focowiki.source_file_graph_edges
    WHERE status = 'accepted'
    UNION ALL
    SELECT knowledge_base_id, to_source_file_id AS source_file_id
    FROM focowiki.source_file_graph_edges
    WHERE status = 'accepted'
  ) relationships
  GROUP BY knowledge_base_id, source_file_id
) counts
WHERE source.knowledge_base_id = counts.knowledge_base_id
  AND source.id = counts.source_file_id;

ALTER TABLE focowiki.worker_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

ALTER TABLE focowiki.worker_jobs
  DROP CONSTRAINT IF EXISTS worker_jobs_status_check,
  ADD CONSTRAINT worker_jobs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'));

ALTER TABLE focowiki.worker_queue_summaries
  DROP CONSTRAINT IF EXISTS worker_queue_summaries_status_check,
  ADD CONSTRAINT worker_queue_summaries_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'));

CREATE OR REPLACE FUNCTION focowiki.adjust_worker_queue_summary(
  input_knowledge_base_id text,
  input_kind text,
  input_status text,
  input_delta integer
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF input_delta > 0 THEN
    INSERT INTO focowiki.worker_queue_summaries (
      knowledge_base_id,
      kind,
      status,
      job_count,
      updated_at
    )
    VALUES (
      input_knowledge_base_id,
      input_kind,
      input_status,
      input_delta,
      now()
    )
    ON CONFLICT (knowledge_base_id, kind, status)
    DO UPDATE SET
      job_count = focowiki.worker_queue_summaries.job_count + input_delta,
      updated_at = now();
  ELSIF input_delta < 0 THEN
    UPDATE focowiki.worker_queue_summaries
    SET
      job_count = GREATEST(job_count + input_delta, 0),
      updated_at = now()
    WHERE knowledge_base_id = input_knowledge_base_id
      AND kind = input_kind
      AND status = input_status;

    DELETE FROM focowiki.worker_queue_summaries
    WHERE knowledge_base_id = input_knowledge_base_id
      AND kind = input_kind
      AND status = input_status
      AND job_count = 0;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.sync_worker_queue_summary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM focowiki.adjust_worker_queue_summary(
      NEW.knowledge_base_id,
      NEW.kind,
      NEW.status,
      1
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM focowiki.adjust_worker_queue_summary(
      OLD.knowledge_base_id,
      OLD.kind,
      OLD.status,
      -1
    );
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (
      OLD.knowledge_base_id,
      OLD.kind,
      OLD.status
    ) IS DISTINCT FROM (
      NEW.knowledge_base_id,
      NEW.kind,
      NEW.status
    ) THEN
      PERFORM focowiki.adjust_worker_queue_summary(
        OLD.knowledge_base_id,
        OLD.kind,
        OLD.status,
        -1
      );
      PERFORM focowiki.adjust_worker_queue_summary(
        NEW.knowledge_base_id,
        NEW.kind,
        NEW.status,
        1
      );
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS worker_jobs_summary_sync_trigger ON focowiki.worker_jobs;

CREATE TRIGGER worker_jobs_summary_sync_trigger
AFTER INSERT OR UPDATE OF knowledge_base_id, kind, status OR DELETE
ON focowiki.worker_jobs
FOR EACH ROW
EXECUTE FUNCTION focowiki.sync_worker_queue_summary();

DELETE FROM focowiki.worker_queue_summaries;

INSERT INTO focowiki.worker_queue_summaries (
  knowledge_base_id,
  kind,
  status,
  job_count
)
SELECT knowledge_base_id, kind, status, count(*) AS job_count
FROM focowiki.worker_jobs
GROUP BY knowledge_base_id, kind, status;

CREATE TABLE IF NOT EXISTS focowiki.bundle_tree_entries (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  release_id text NOT NULL REFERENCES focowiki.releases(id),
  parent_path text NOT NULL DEFAULT '',
  name text NOT NULL,
  logical_path text NOT NULL,
  sort_key text NOT NULL DEFAULT '',
  entry_type text NOT NULL,
  bundle_file_id text REFERENCES focowiki.bundle_files(id),
  child_count integer NOT NULL DEFAULT 0 CHECK (child_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, parent_path, name),
  CHECK (entry_type IN ('directory', 'file')),
  CHECK (
    (entry_type = 'directory' AND bundle_file_id IS NULL)
    OR (entry_type = 'file' AND bundle_file_id IS NOT NULL)
  )
);

ALTER TABLE focowiki.bundle_tree_entries
  ADD COLUMN IF NOT EXISTS sort_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS child_count integer NOT NULL DEFAULT 0;

ALTER TABLE focowiki.bundle_tree_entries
  DROP CONSTRAINT IF EXISTS bundle_tree_entries_child_count_check,
  ADD CONSTRAINT bundle_tree_entries_child_count_check
  CHECK (child_count >= 0);

UPDATE focowiki.bundle_tree_entries
SET sort_key = CASE
  WHEN entry_type = 'directory' THEN '0:' || lower(name)
  ELSE '1:' || lower(name)
END
WHERE sort_key = '';

UPDATE focowiki.bundle_tree_entries parent
SET child_count = child_counts.child_count
FROM (
  SELECT release_id, parent_path, count(*)::integer AS child_count
  FROM focowiki.bundle_tree_entries
  GROUP BY release_id, parent_path
) child_counts
WHERE parent.release_id = child_counts.release_id
  AND parent.logical_path = child_counts.parent_path
  AND parent.entry_type = 'directory';

CREATE TABLE IF NOT EXISTS focowiki.admin_audit_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  result text NOT NULL,
  error_code text,
  username text,
  client_ip text,
  user_agent text,
  origin text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (result IN ('success', 'failure', 'blocked'))
);

CREATE TABLE IF NOT EXISTS focowiki.public_api_keys (
  id text PRIMARY KEY,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  key_suffix text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (status IN ('active', 'revoked')),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS focowiki.webhook_subscriptions (
  id text PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL,
  signing_secret text NOT NULL,
  events_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_delivery_at timestamptz,
  CHECK (id ~ '^webhook-[a-zA-Z0-9-]+$')
);

CREATE TABLE IF NOT EXISTS focowiki.webhook_deliveries (
  id text PRIMARY KEY,
  webhook_id text NOT NULL REFERENCES focowiki.webhook_subscriptions(id),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  http_status integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id ~ '^delivery-[a-zA-Z0-9-]+$'),
  CHECK (status IN ('pending', 'success', 'failed'))
);

CREATE TABLE IF NOT EXISTS focowiki.internal_migration_markers (
  marker_key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE focowiki.webhook_subscriptions
    ADD COLUMN IF NOT EXISTS signing_secret text;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'focowiki'
      AND table_name = 'webhook_subscriptions'
      AND column_name = 'secret_hash'
  ) THEN
    UPDATE focowiki.webhook_subscriptions
    SET signing_secret = COALESCE(signing_secret, secret_hash);
  END IF;

  ALTER TABLE focowiki.webhook_subscriptions
    ALTER COLUMN signing_secret SET NOT NULL;

  ALTER TABLE focowiki.webhook_deliveries
    ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;
END $$;

DO $$
BEGIN
  ALTER TABLE focowiki.knowledge_bases
    ADD CONSTRAINT knowledge_bases_active_release_id_fkey
    FOREIGN KEY (active_release_id)
    REFERENCES focowiki.releases(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_name_active_unique
  ON focowiki.knowledge_bases(lower(name))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS source_files_object_key_unique
  ON focowiki.source_files(object_key);

DROP INDEX IF EXISTS focowiki.bundle_files_object_key_unique;

CREATE INDEX IF NOT EXISTS bundle_files_object_key_idx
  ON focowiki.bundle_files(object_key);

CREATE INDEX IF NOT EXISTS knowledge_bases_list_cursor_idx
  ON focowiki.knowledge_bases(deleted_at, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_files_kb_created_cursor_idx
  ON focowiki.source_files(knowledge_base_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_files_kb_active_created_cursor_idx
  ON focowiki.source_files(knowledge_base_id, deleted_at, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_files_kb_task_visible_created_cursor_idx
  ON focowiki.source_files(knowledge_base_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_processing_idx
  ON focowiki.source_files(knowledge_base_id, processing_status, processing_stage, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_files_kb_task_visible_processing_idx
  ON focowiki.source_files(knowledge_base_id, processing_status, processing_stage, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_publication_dirty_idx
  ON focowiki.source_files(knowledge_base_id, publication_dirty_at, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND processing_status = 'completed'
    AND publication_dirty_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_generated_output_status_idx
  ON focowiki.source_files(knowledge_base_id, generated_output_status, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_model_invocation_status_idx
  ON focowiki.source_files(knowledge_base_id, model_invocation_status, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_started_cursor_idx
  ON focowiki.source_files(knowledge_base_id, processing_started_at DESC, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND processing_started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_ended_cursor_idx
  ON focowiki.source_files(knowledge_base_id, processing_ended_at DESC, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND processing_ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_openable_action_idx
  ON focowiki.source_files(knowledge_base_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND generated_output_status = 'visible'
    AND generated_bundle_file_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_retryable_action_idx
  ON focowiki.source_files(knowledge_base_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND processing_status = 'failed';

CREATE INDEX IF NOT EXISTS source_files_kb_error_state_created_idx
  ON focowiki.source_files(knowledge_base_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND (
      processing_error_code IS NOT NULL
      OR publication_error_code IS NOT NULL
    );

CREATE INDEX IF NOT EXISTS source_files_kb_no_error_created_idx
  ON focowiki.source_files(knowledge_base_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND processing_error_code IS NULL
    AND publication_error_code IS NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_processing_error_code_idx
  ON focowiki.source_files(knowledge_base_id, processing_error_code, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND processing_error_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_files_kb_publication_error_code_idx
  ON focowiki.source_files(knowledge_base_id, publication_error_code, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND task_deleted_at IS NULL
    AND publication_error_code IS NOT NULL;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pg_trgm extension is unavailable; filename filter validation will report missing indexed search support';
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_trgm'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS source_files_original_name_trgm_idx ON focowiki.source_files USING gin (original_name gin_trgm_ops) WHERE deleted_at IS NULL AND task_deleted_at IS NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS source_files_original_name_task_visible_trgm_idx ON focowiki.source_files USING gin (original_name gin_trgm_ops) WHERE deleted_at IS NULL AND task_deleted_at IS NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS knowledge_bases_metadata_search_trgm_idx ON focowiki.knowledge_bases USING gin ((lower(id || '' '' || name || '' '' || coalesce(description, ''''))) gin_trgm_ops) WHERE deleted_at IS NULL';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS publication_jobs_kb_status_created_idx
  ON focowiki.publication_jobs(knowledge_base_id, status, created_at, id);

CREATE INDEX IF NOT EXISTS publication_jobs_kb_created_idx
  ON focowiki.publication_jobs(knowledge_base_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS model_invocations_source_created_idx
  ON focowiki.model_invocations(source_file_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_file_events_file_created_cursor_idx
  ON focowiki.source_file_events(knowledge_base_id, source_file_id, created_at, id);

CREATE INDEX IF NOT EXISTS source_file_retry_attempts_file_created_cursor_idx
  ON focowiki.source_file_retry_attempts(knowledge_base_id, source_file_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS releases_kb_published_cursor_idx
  ON focowiki.releases(knowledge_base_id, published_at DESC, id);

CREATE INDEX IF NOT EXISTS bundle_files_release_logical_cursor_idx
  ON focowiki.bundle_files(release_id, logical_path, id);

CREATE INDEX IF NOT EXISTS bundle_files_kb_release_logical_cursor_idx
  ON focowiki.bundle_files(knowledge_base_id, release_id, logical_path, id);

CREATE INDEX IF NOT EXISTS bundle_files_kb_release_source_idx
  ON focowiki.bundle_files(knowledge_base_id, release_id, source_file_id, id);

CREATE INDEX IF NOT EXISTS bundle_tree_entries_kb_release_parent_cursor_idx
  ON focowiki.bundle_tree_entries(knowledge_base_id, release_id, parent_path, name, id);

CREATE INDEX IF NOT EXISTS bundle_tree_entries_kb_release_parent_type_sort_idx
  ON focowiki.bundle_tree_entries(knowledge_base_id, release_id, parent_path, entry_type, sort_key, id);

CREATE INDEX IF NOT EXISTS bundle_tree_entries_kb_release_sort_cursor_idx
  ON focowiki.bundle_tree_entries(knowledge_base_id, release_id, sort_key, id);

CREATE INDEX IF NOT EXISTS bundle_tree_entries_kb_release_logical_path_idx
  ON focowiki.bundle_tree_entries(knowledge_base_id, release_id, logical_path);

CREATE INDEX IF NOT EXISTS bundle_tree_entries_release_logical_cursor_idx
  ON focowiki.bundle_tree_entries(release_id, logical_path, id);

CREATE INDEX IF NOT EXISTS bundle_tree_entries_release_file_idx
  ON focowiki.bundle_tree_entries(release_id, bundle_file_id, id)
  WHERE bundle_file_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_trgm'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS bundle_tree_entries_name_trgm_idx ON focowiki.bundle_tree_entries USING gin (name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS bundle_tree_entries_logical_path_trgm_idx ON focowiki.bundle_tree_entries USING gin (logical_path gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS bundle_tree_entries_search_text_trgm_idx ON focowiki.bundle_tree_entries USING gin ((name || '' '' || logical_path) gin_trgm_ops)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS source_file_graph_nodes_kb_path_cursor_idx
  ON focowiki.source_file_graph_nodes(knowledge_base_id, path, source_file_id);

CREATE INDEX IF NOT EXISTS source_file_graph_nodes_profile_version_idx
  ON focowiki.source_file_graph_nodes(knowledge_base_id, profile_version, source_file_id);

CREATE INDEX IF NOT EXISTS source_file_graph_nodes_subjects_gin_idx
  ON focowiki.source_file_graph_nodes USING gin(subjects_json);

CREATE INDEX IF NOT EXISTS source_file_graph_nodes_tags_gin_idx
  ON focowiki.source_file_graph_nodes USING gin(tags_json);

CREATE INDEX IF NOT EXISTS source_file_graph_nodes_entities_gin_idx
  ON focowiki.source_file_graph_nodes USING gin(entities_json);

CREATE INDEX IF NOT EXISTS source_file_graph_nodes_keywords_gin_idx
  ON focowiki.source_file_graph_nodes USING gin(keywords_json);

CREATE INDEX IF NOT EXISTS source_file_graph_edges_from_weight_idx
  ON focowiki.source_file_graph_edges(knowledge_base_id, from_source_file_id, weight DESC, to_source_file_id)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS source_file_graph_edges_to_weight_idx
  ON focowiki.source_file_graph_edges(knowledge_base_id, to_source_file_id, weight DESC, from_source_file_id)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS source_file_graph_edges_relation_weight_idx
  ON focowiki.source_file_graph_edges(knowledge_base_id, relation_type, weight DESC, id)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS source_file_graph_jobs_source_created_idx
  ON focowiki.source_file_graph_jobs(knowledge_base_id, source_file_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS worker_jobs_claim_idx
  ON focowiki.worker_jobs(status, run_after, created_at, id);

CREATE INDEX IF NOT EXISTS worker_jobs_kind_status_idx
  ON focowiki.worker_jobs(kind, status, run_after, id);

CREATE INDEX IF NOT EXISTS worker_jobs_queued_oldest_idx
  ON focowiki.worker_jobs(kind, knowledge_base_id, run_after, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS worker_jobs_running_heartbeat_idx
  ON focowiki.worker_jobs(status, heartbeat_at, locked_at, id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS worker_jobs_source_active_idx
  ON focowiki.worker_jobs(kind, source_file_id, status)
  WHERE source_file_id IS NOT NULL
    AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS worker_jobs_source_cancel_idx
  ON focowiki.worker_jobs(knowledge_base_id, kind, status, source_file_id, run_after, created_at, id)
  WHERE kind = 'source_file_processing'
    AND source_file_id IS NOT NULL
    AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS worker_jobs_publication_active_idx
  ON focowiki.worker_jobs(kind, knowledge_base_id, status, run_after)
  WHERE kind = 'publication'
    AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS worker_jobs_kb_created_idx
  ON focowiki.worker_jobs(knowledge_base_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS worker_jobs_retention_idx
  ON focowiki.worker_jobs(status, completed_at, failed_at, id)
  WHERE status IN ('completed', 'failed', 'dead_letter', 'cancelled');

CREATE INDEX IF NOT EXISTS worker_heartbeats_seen_idx
  ON focowiki.worker_heartbeats(last_seen_at DESC, worker_id);

CREATE INDEX IF NOT EXISTS worker_queue_summaries_kind_status_idx
  ON focowiki.worker_queue_summaries(kind, status, knowledge_base_id);

CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
  ON focowiki.admin_audit_events(created_at DESC, id);

CREATE INDEX IF NOT EXISTS admin_audit_events_type_result_idx
  ON focowiki.admin_audit_events(event_type, result, created_at DESC);

CREATE INDEX IF NOT EXISTS public_api_keys_created_cursor_idx
  ON focowiki.public_api_keys(created_at DESC, id);

CREATE INDEX IF NOT EXISTS public_api_keys_status_created_cursor_idx
  ON focowiki.public_api_keys(status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS public_api_keys_active_hash_idx
  ON focowiki.public_api_keys(key_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS webhook_subscriptions_enabled_created_cursor_idx
  ON focowiki.webhook_subscriptions(enabled, created_at DESC, id);

CREATE INDEX IF NOT EXISTS webhook_deliveries_created_cursor_idx
  ON focowiki.webhook_deliveries(created_at DESC, id);

CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_created_idx
  ON focowiki.webhook_deliveries(webhook_id, created_at DESC, id);
