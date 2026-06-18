CREATE SCHEMA IF NOT EXISTS focowiki;

DROP TABLE IF EXISTS focowiki.upload_task_events CASCADE;
DROP TABLE IF EXISTS focowiki.upload_tasks CASCADE;

ALTER TABLE IF EXISTS focowiki.source_files
  DROP COLUMN IF EXISTS task_id,
  DROP COLUMN IF EXISTS model_suggestions_json;

ALTER TABLE IF EXISTS focowiki.model_invocations
  DROP COLUMN IF EXISTS task_id;

ALTER TABLE IF EXISTS focowiki.releases
  DROP COLUMN IF EXISTS task_id;

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
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (processing_status IN ('queued', 'running', 'completed', 'failed')),
  CHECK (processing_stage IN (
    'upload_storage',
    'metadata_resolution',
    'llm_suggestion',
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
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

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
  DROP CONSTRAINT IF EXISTS source_files_processing_stage_check,
  ADD CONSTRAINT source_files_processing_stage_check
  CHECK (processing_stage IN (
    'upload_storage',
    'metadata_resolution',
    'llm_suggestion',
    'okf_validation',
    'bundle_generation',
    'index_publication',
    'release_activation'
  ));

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
  CHECK (file_kind IN ('page', 'index', 'log', 'schema', 'manifest_index', 'search_index', 'link_index')),
  CHECK (
    (file_kind = 'page' AND source_file_id IS NOT NULL)
    OR (file_kind <> 'page' AND source_file_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS focowiki.bundle_tree_entries (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES focowiki.knowledge_bases(id),
  release_id text NOT NULL REFERENCES focowiki.releases(id),
  parent_path text NOT NULL DEFAULT '',
  name text NOT NULL,
  logical_path text NOT NULL,
  entry_type text NOT NULL,
  bundle_file_id text REFERENCES focowiki.bundle_files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, parent_path, name),
  CHECK (entry_type IN ('directory', 'file')),
  CHECK (
    (entry_type = 'directory' AND bundle_file_id IS NULL)
    OR (entry_type = 'file' AND bundle_file_id IS NOT NULL)
  )
);

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
    ALTER TABLE focowiki.webhook_subscriptions
      DROP COLUMN secret_hash;
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

CREATE UNIQUE INDEX IF NOT EXISTS bundle_files_object_key_unique
  ON focowiki.bundle_files(object_key);

CREATE INDEX IF NOT EXISTS knowledge_bases_list_cursor_idx
  ON focowiki.knowledge_bases(deleted_at, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_files_kb_created_cursor_idx
  ON focowiki.source_files(knowledge_base_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_files_kb_active_created_cursor_idx
  ON focowiki.source_files(knowledge_base_id, deleted_at, created_at DESC, id);

CREATE INDEX IF NOT EXISTS source_files_kb_processing_idx
  ON focowiki.source_files(knowledge_base_id, processing_status, processing_stage, created_at DESC, id);

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

CREATE INDEX IF NOT EXISTS bundle_tree_entries_release_logical_cursor_idx
  ON focowiki.bundle_tree_entries(release_id, logical_path, id);

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
