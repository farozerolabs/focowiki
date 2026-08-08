CREATE SCHEMA focowiki;

CREATE TABLE focowiki.knowledge_bases (
  public_id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT knowledge_bases_public_id_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT knowledge_bases_name_check CHECK (
    name <> '' AND octet_length(name) <= 1024
  ),
  CONSTRAINT knowledge_bases_description_check CHECK (
    description IS NULL OR octet_length(description) <= 4096
  ),
  CONSTRAINT knowledge_bases_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.object_registrations (
  object_id text PRIMARY KEY,
  storage_key text NOT NULL,
  checksum_sha256 text NOT NULL,
  byte_count bigint NOT NULL,
  content_type text NOT NULL,
  object_format text NOT NULL,
  state text NOT NULL,
  write_attempt_public_id text NOT NULL,
  verified_at timestamp with time zone,
  zero_owner_since timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT object_registrations_storage_key_key UNIQUE (storage_key),
  CONSTRAINT object_registrations_write_attempt_key UNIQUE (write_attempt_public_id),
  CONSTRAINT object_registrations_identity_check CHECK (
    object_id <> '' AND octet_length(object_id) <= 255
    AND storage_key <> '' AND octet_length(storage_key) <= 2048
    AND write_attempt_public_id <> '' AND octet_length(write_attempt_public_id) <= 255
  ),
  CONSTRAINT object_registrations_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT object_registrations_byte_count_nonnegative_check CHECK (byte_count >= 0),
  CONSTRAINT object_registrations_content_check CHECK (
    content_type <> '' AND octet_length(content_type) <= 255
    AND object_format <> '' AND octet_length(object_format) <= 128
  ),
  CONSTRAINT object_registrations_state_check CHECK (
    state IN ('reserved', 'verified', 'deleting', 'deleted')
  ),
  CONSTRAINT object_registrations_verification_check CHECK (
    (state = 'reserved' AND verified_at IS NULL)
    OR (state <> 'reserved' AND verified_at IS NOT NULL)
  )
);

CREATE TABLE focowiki.source_directories (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  parent_public_id text,
  logical_path text NOT NULL,
  normalized_path text NOT NULL,
  title text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT source_directories_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT source_directories_path_key UNIQUE (knowledge_base_id, normalized_path),
  CONSTRAINT source_directories_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT source_directories_parent_fkey FOREIGN KEY (knowledge_base_id, parent_public_id)
    REFERENCES focowiki.source_directories (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT source_directories_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND knowledge_base_id <> '' AND octet_length(knowledge_base_id) <= 255
  ),
  CONSTRAINT source_directories_parent_check CHECK (parent_public_id IS DISTINCT FROM public_id),
  CONSTRAINT source_directories_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
    AND normalized_path <> '' AND octet_length(normalized_path) <= 4096
  ),
  CONSTRAINT source_directories_title_check CHECK (
    title <> '' AND octet_length(title) <= 1024
  ),
  CONSTRAINT source_directories_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.source_files (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  directory_public_id text,
  logical_path text NOT NULL,
  normalized_path text NOT NULL,
  title text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  revision bigint NOT NULL,
  safe_error_code text,
  safe_error_message text,
  model_invocation_source_revision_public_id text,
  model_invocation_status text,
  model_invocation_model_name text,
  model_invocation_started_at timestamp with time zone,
  model_invocation_ended_at timestamp with time zone,
  model_invocation_warning_count integer,
  model_invocation_error_code text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT source_files_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT source_files_path_key UNIQUE (knowledge_base_id, normalized_path),
  CONSTRAINT source_files_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT source_files_directory_fkey FOREIGN KEY (knowledge_base_id, directory_public_id)
    REFERENCES focowiki.source_directories (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT source_files_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND knowledge_base_id <> '' AND octet_length(knowledge_base_id) <= 255
  ),
  CONSTRAINT source_files_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
    AND normalized_path <> '' AND octet_length(normalized_path) <= 4096
  ),
  CONSTRAINT source_files_title_check CHECK (
    title <> '' AND octet_length(title) <= 1024
  ),
  CONSTRAINT source_files_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192
  ),
  CONSTRAINT source_files_status_check CHECK (
    status IN ('pending', 'processing', 'ready', 'failed')
  ),
  CONSTRAINT source_files_revision_check CHECK (revision >= 0),
  CONSTRAINT source_files_error_check CHECK (
    (status = 'failed' AND safe_error_code IS NOT NULL)
    OR (status <> 'failed' AND safe_error_code IS NULL AND safe_error_message IS NULL)
  ),
  CONSTRAINT source_files_error_payload_check CHECK (
    (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
    AND (safe_error_message IS NULL OR octet_length(safe_error_message) <= 2048)
  ),
  CONSTRAINT source_files_model_invocation_check CHECK (
    (
      model_invocation_status IS NULL
      AND model_invocation_source_revision_public_id IS NULL
      AND model_invocation_model_name IS NULL
      AND model_invocation_started_at IS NULL
      AND model_invocation_ended_at IS NULL
      AND model_invocation_warning_count IS NULL
      AND model_invocation_error_code IS NULL
    ) OR (
      model_invocation_status IN ('running', 'completed', 'failed', 'skipped')
      AND model_invocation_source_revision_public_id <> ''
      AND octet_length(model_invocation_source_revision_public_id) <= 255
      AND model_invocation_warning_count BETWEEN 0 AND 1000
      AND (
        model_invocation_status = 'skipped'
        AND model_invocation_model_name IS NULL
        AND model_invocation_started_at IS NULL
        AND model_invocation_ended_at IS NOT NULL
        AND model_invocation_error_code IS NULL
        OR model_invocation_status = 'running'
        AND model_invocation_model_name IS NOT NULL
        AND model_invocation_started_at IS NOT NULL
        AND model_invocation_ended_at IS NULL
        AND model_invocation_error_code IS NULL
        OR model_invocation_status = 'completed'
        AND model_invocation_model_name IS NOT NULL
        AND model_invocation_started_at IS NOT NULL
        AND model_invocation_ended_at >= model_invocation_started_at
        AND model_invocation_error_code IS NULL
        OR model_invocation_status = 'failed'
        AND model_invocation_model_name IS NOT NULL
        AND model_invocation_started_at IS NOT NULL
        AND model_invocation_ended_at >= model_invocation_started_at
        AND model_invocation_error_code IS NOT NULL
      )
      AND (
        model_invocation_model_name IS NULL
        OR model_invocation_model_name <> ''
          AND octet_length(model_invocation_model_name) <= 255
      )
      AND (
        model_invocation_error_code IS NULL
        OR model_invocation_error_code <> ''
          AND octet_length(model_invocation_error_code) <= 128
      )
    )
  )
);

CREATE TABLE focowiki.source_event_summaries (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  sequence_number smallint NOT NULL,
  stage_key text NOT NULL,
  message_key text NOT NULL,
  started_at timestamp with time zone,
  ended_at timestamp with time zone,
  severity text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT source_event_summaries_source_file_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id
  ) REFERENCES focowiki.source_files (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT source_event_summaries_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND source_revision_public_id <> ''
    AND octet_length(source_revision_public_id) <= 255
  ),
  CONSTRAINT source_event_summaries_sequence_check CHECK (
    sequence_number BETWEEN 1 AND 100
  ),
  CONSTRAINT source_event_summaries_stage_check CHECK (
    stage_key IN (
      'upload_storage', 'metadata_resolution', 'llm_suggestion',
      'graph_generation', 'projection_generation',
      'generation_validation', 'generation_activation'
    )
  ),
  CONSTRAINT source_event_summaries_message_check CHECK (
    message_key <> '' AND octet_length(message_key) <= 255
  ),
  CONSTRAINT source_event_summaries_severity_check CHECK (
    severity IN ('info', 'warning', 'error')
  ),
  CONSTRAINT source_event_summaries_time_check CHECK (
    ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at
  ),
  CONSTRAINT source_event_summaries_expiry_check CHECK (
    expires_at > created_at
  )
);

CREATE TABLE focowiki.source_revisions (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  source_file_public_id text NOT NULL,
  object_id text NOT NULL,
  checksum_sha256 text NOT NULL,
  byte_count bigint NOT NULL,
  content_type text NOT NULL,
  revision_role text NOT NULL,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT source_revisions_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT source_revisions_file_scope_key UNIQUE (
    knowledge_base_id, source_file_public_id, public_id
  ),
  CONSTRAINT source_revisions_content_key UNIQUE (
    knowledge_base_id, source_file_public_id, checksum_sha256
  ),
  CONSTRAINT source_revisions_file_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id)
    REFERENCES focowiki.source_files (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT source_revisions_object_fkey FOREIGN KEY (object_id)
    REFERENCES focowiki.object_registrations (object_id) ON DELETE RESTRICT,
  CONSTRAINT source_revisions_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND object_id <> '' AND octet_length(object_id) <= 255
  ),
  CONSTRAINT source_revisions_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT source_revisions_byte_count_nonnegative_check CHECK (byte_count >= 0),
  CONSTRAINT source_revisions_content_type_check CHECK (
    content_type <> '' AND octet_length(content_type) <= 255
  ),
  CONSTRAINT source_revisions_role_check CHECK (
    revision_role IN ('current', 'candidate', 'rollback')
  ),
  CONSTRAINT source_revisions_expiry_check CHECK (
    (revision_role = 'current' AND expires_at IS NULL)
    OR (revision_role <> 'current' AND expires_at IS NOT NULL)
  )
);

CREATE TABLE focowiki.source_file_current_revisions (
  knowledge_base_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (knowledge_base_id, source_file_public_id),
  CONSTRAINT source_file_current_revisions_file_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id
  ) REFERENCES focowiki.source_files (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT source_file_current_revisions_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE RESTRICT,
  CONSTRAINT source_file_current_revisions_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.runtime_setting_revisions (
  public_id text PRIMARY KEY,
  checksum_sha256 text NOT NULL,
  settings_values jsonb NOT NULL,
  created_by_public_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT runtime_setting_revisions_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND (created_by_public_id IS NULL OR octet_length(created_by_public_id) <= 255)
  ),
  CONSTRAINT runtime_setting_revisions_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT runtime_setting_revisions_values_check CHECK (
    jsonb_typeof(settings_values) = 'object'
    AND octet_length(settings_values::text) <= 65536
  )
);

CREATE TABLE focowiki.runtime_setting_current (
  singleton boolean PRIMARY KEY,
  revision_public_id text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT runtime_setting_current_revision_fkey FOREIGN KEY (revision_public_id)
    REFERENCES focowiki.runtime_setting_revisions (public_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_setting_current_singleton_check CHECK (singleton)
);

CREATE FUNCTION focowiki.reject_runtime_setting_revision_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'runtime setting revisions are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER runtime_setting_revisions_immutable_update
BEFORE UPDATE ON focowiki.runtime_setting_revisions
FOR EACH ROW
EXECUTE FUNCTION focowiki.reject_runtime_setting_revision_update();

CREATE TABLE focowiki.model_configs (
  public_id text PRIMARY KEY,
  knowledge_base_id text,
  provider text NOT NULL,
  model text NOT NULL,
  secret_reference text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT model_configs_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT model_configs_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT model_configs_provider_check CHECK (
    provider <> '' AND octet_length(provider) <= 128
    AND model <> '' AND octet_length(model) <= 255
    AND secret_reference <> '' AND octet_length(secret_reference) <= 1024
  ),
  CONSTRAINT model_configs_config_check CHECK (
    jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 32768
  ),
  CONSTRAINT model_configs_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.public_api_keys (
  public_id text PRIMARY KEY,
  key_hash text NOT NULL,
  key_prefix text NOT NULL,
  key_suffix text NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  CONSTRAINT public_api_keys_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND key_hash <> '' AND octet_length(key_hash) <= 255
    AND key_prefix <> '' AND octet_length(key_prefix) <= 32
    AND key_suffix <> '' AND octet_length(key_suffix) <= 32
    AND label <> '' AND octet_length(label) <= 255
  ),
  CONSTRAINT public_api_keys_revocation_check CHECK (
    (enabled AND revoked_at IS NULL) OR (NOT enabled AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE focowiki.webhook_subscriptions (
  public_id text PRIMARY KEY,
  knowledge_base_id text,
  label text NOT NULL,
  endpoint_url text NOT NULL,
  secret_reference text NOT NULL,
  event_types jsonb NOT NULL,
  enabled boolean NOT NULL,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT webhook_subscriptions_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT webhook_subscriptions_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT webhook_subscriptions_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND label <> '' AND octet_length(label) <= 255
    AND endpoint_url <> '' AND octet_length(endpoint_url) <= 4096
    AND secret_reference <> '' AND octet_length(secret_reference) <= 1024
  ),
  CONSTRAINT webhook_subscriptions_event_types_check CHECK (
    jsonb_typeof(event_types) = 'array' AND octet_length(event_types::text) <= 8192
  ),
  CONSTRAINT webhook_subscriptions_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.operations (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_kind text NOT NULL,
  state text NOT NULL,
  expected_resource_revision bigint,
  target_kind text,
  target_public_id text,
  candidate_relative_path text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  CONSTRAINT operations_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT operations_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT operations_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND operation_kind <> '' AND octet_length(operation_kind) <= 128
  ),
  CONSTRAINT operations_state_check CHECK (
    state IN (
      'accepted', 'validating', 'processing', 'publishing',
      'completed', 'failed', 'cancelled', 'superseded', 'timed_out', 'deleted'
    )
  ),
  CONSTRAINT operations_revision_check CHECK (
    expected_resource_revision IS NULL OR expected_resource_revision >= 0
  ),
  CONSTRAINT operations_target_check CHECK (
    (target_kind IS NULL AND target_public_id IS NULL)
    OR (
      target_kind IN ('source_file', 'source_directory', 'knowledge_base')
      AND target_public_id IS NOT NULL
      AND octet_length(target_public_id) <= 255
    )
  ),
  CONSTRAINT operations_path_check CHECK (
    candidate_relative_path IS NULL OR octet_length(candidate_relative_path) <= 4096
  ),
  CONSTRAINT operations_terminal_time_check CHECK (
    (state IN ('completed', 'failed', 'cancelled', 'superseded', 'timed_out', 'deleted'))
      = (completed_at IS NOT NULL)
  )
);

CREATE TABLE focowiki.operation_work_items (
  operation_public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  work_kind text NOT NULL,
  search_provider_kind text,
  state text NOT NULL,
  operation_revision bigint NOT NULL,
  settings_revision_public_id text NOT NULL,
  attempt_count integer NOT NULL,
  lease_owner text,
  lease_expires_at timestamp with time zone,
  next_attempt_at timestamp with time zone,
  safe_error_code text,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT operation_work_items_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT operation_work_items_settings_fkey FOREIGN KEY (settings_revision_public_id)
    REFERENCES focowiki.runtime_setting_revisions (public_id) ON DELETE RESTRICT,
  CONSTRAINT operation_work_items_kind_check CHECK (
    work_kind IN (
      'upload', 'source', 'graph', 'publication', 'search', 'mutation',
      'deletion', 'maintenance', 'reconciliation', 'webhook'
    )
  ),
  CONSTRAINT operation_work_items_search_provider_check CHECK (
    (
      work_kind IN ('search', 'maintenance')
      AND search_provider_kind IN ('meilisearch', 'opensearch')
    ) OR (
      work_kind NOT IN ('search', 'maintenance')
      AND search_provider_kind IS NULL
    )
  ),
  CONSTRAINT operation_work_items_state_check CHECK (
    state IN ('queued', 'running', 'retry')
  ),
  CONSTRAINT operation_work_items_revision_check CHECK (operation_revision >= 0),
  CONSTRAINT operation_work_items_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT operation_work_items_lease_check CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT operation_work_items_checkpoint_check CHECK (
    jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 32768
  ),
  CONSTRAINT operation_work_items_error_check CHECK (
    safe_error_code IS NULL OR octet_length(safe_error_code) <= 128
  )
);

CREATE TABLE focowiki.operation_idempotency (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  operation_public_id text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT operation_idempotency_key UNIQUE (knowledge_base_id, idempotency_key),
  CONSTRAINT operation_idempotency_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT operation_idempotency_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND idempotency_key <> '' AND octet_length(idempotency_key) <= 255
    AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operation_idempotency_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE focowiki.mutation_path_reservations (
  knowledge_base_id text NOT NULL,
  normalized_path text NOT NULL,
  operation_public_id text NOT NULL,
  target_kind text NOT NULL,
  target_public_id text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_base_id, normalized_path),
  CONSTRAINT mutation_path_reservations_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT mutation_path_reservations_identity_check CHECK (
    normalized_path <> '' AND octet_length(normalized_path) <= 4096
    AND target_kind IN ('source_file', 'source_directory')
    AND target_public_id <> '' AND octet_length(target_public_id) <= 255
  ),
  CONSTRAINT mutation_path_reservations_expiry_check CHECK (
    expires_at > created_at
  )
);

CREATE TABLE focowiki.operation_dependencies (
  knowledge_base_id text NOT NULL,
  operation_public_id text NOT NULL,
  dependency_operation_public_id text NOT NULL,
  PRIMARY KEY (operation_public_id, dependency_operation_public_id),
  CONSTRAINT operation_dependencies_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT operation_dependencies_dependency_fkey FOREIGN KEY (
    knowledge_base_id, dependency_operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT operation_dependencies_distinct_check CHECK (
    operation_public_id <> dependency_operation_public_id
  )
);

CREATE TABLE focowiki.graph_nodes (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  logical_path text NOT NULL,
  label text NOT NULL,
  node_kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  CONSTRAINT graph_nodes_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT graph_nodes_source_file_key UNIQUE (
    knowledge_base_id, source_file_public_id
  ),
  CONSTRAINT graph_nodes_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT graph_nodes_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT graph_nodes_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
  ),
  CONSTRAINT graph_nodes_label_check CHECK (
    label <> '' AND octet_length(label) <= 1024
    AND node_kind <> '' AND octet_length(node_kind) <= 128
  ),
  CONSTRAINT graph_nodes_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192
  ),
  CONSTRAINT graph_nodes_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.graph_edges (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  from_node_public_id text NOT NULL,
  to_node_public_id text NOT NULL,
  relation text NOT NULL,
  weight double precision NOT NULL,
  reason text,
  edge_source text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  CONSTRAINT graph_edges_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT graph_edges_relationship_key UNIQUE (
    knowledge_base_id, from_node_public_id, to_node_public_id, relation
  ),
  CONSTRAINT graph_edges_from_node_fkey FOREIGN KEY (knowledge_base_id, from_node_public_id)
    REFERENCES focowiki.graph_nodes (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT graph_edges_to_node_fkey FOREIGN KEY (knowledge_base_id, to_node_public_id)
    REFERENCES focowiki.graph_nodes (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT graph_edges_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND relation <> '' AND octet_length(relation) <= 128
    AND edge_source <> '' AND octet_length(edge_source) <= 128
  ),
  CONSTRAINT graph_edges_endpoints_check CHECK (from_node_public_id <> to_node_public_id),
  CONSTRAINT graph_edges_weight_check CHECK (
    weight >= 0 AND weight <= 1
  ),
  CONSTRAINT graph_edges_reason_check CHECK (
    reason IS NULL OR octet_length(reason) <= 2048
  ),
  CONSTRAINT graph_edges_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192
  ),
  CONSTRAINT graph_edges_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.graph_evidence_refs (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  node_public_id text,
  edge_public_id text,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  logical_path text NOT NULL,
  start_offset bigint NOT NULL,
  end_offset bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  CONSTRAINT graph_evidence_refs_node_fkey FOREIGN KEY (knowledge_base_id, node_public_id)
    REFERENCES focowiki.graph_nodes (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT graph_evidence_refs_edge_fkey FOREIGN KEY (knowledge_base_id, edge_public_id)
    REFERENCES focowiki.graph_edges (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT graph_evidence_refs_source_file_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id
  ) REFERENCES focowiki.source_files (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT graph_evidence_refs_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT graph_evidence_refs_target_check CHECK (
    (node_public_id IS NOT NULL)::integer + (edge_public_id IS NOT NULL)::integer = 1
  ),
  CONSTRAINT graph_evidence_refs_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
  ),
  CONSTRAINT graph_evidence_refs_offset_range_check CHECK (
    start_offset >= 0 AND end_offset >= start_offset
  ),
  CONSTRAINT graph_evidence_refs_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE focowiki.release_roots (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  base_root_public_id text,
  root_role text NOT NULL,
  root_slot text GENERATED ALWAYS AS (
    CASE
      WHEN root_role IN ('active', 'candidate', 'rollback')
        THEN 'role:' || root_role
      ELSE 'base:' || public_id
    END
  ) STORED,
  manifest_checksum_sha256 text,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone,
  CONSTRAINT release_roots_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT release_roots_role_key UNIQUE (knowledge_base_id, root_slot)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT release_roots_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT release_roots_base_fkey FOREIGN KEY (
    knowledge_base_id, base_root_public_id
  ) REFERENCES focowiki.release_roots (
    knowledge_base_id, public_id
  ) ON DELETE RESTRICT,
  CONSTRAINT release_roots_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND (base_root_public_id IS NULL OR (
      base_root_public_id <> ''
      AND octet_length(base_root_public_id) <= 255
      AND base_root_public_id <> public_id
    ))
  ),
  CONSTRAINT release_roots_role_check CHECK (
    root_role IN ('active', 'candidate', 'rollback', 'base')
  ),
  CONSTRAINT release_roots_manifest_check CHECK (
    (manifest_checksum_sha256 IS NULL OR manifest_checksum_sha256 ~ '^[0-9a-f]{64}$')
    AND (root_role = 'candidate' OR manifest_checksum_sha256 IS NOT NULL)
  ),
  CONSTRAINT release_roots_revision_check CHECK (revision >= 0),
  CONSTRAINT release_roots_expiry_check CHECK (
    (root_role IN ('active', 'candidate', 'base') AND expires_at IS NULL)
    OR (root_role = 'rollback' AND expires_at IS NOT NULL)
  )
);

CREATE TABLE focowiki.release_shards (
  public_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  logical_kind text NOT NULL,
  first_logical_path text NOT NULL,
  last_logical_path text NOT NULL,
  record_count bigint NOT NULL,
  byte_count bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  object_id text NOT NULL,
  CONSTRAINT release_shards_scope_key PRIMARY KEY (knowledge_base_id, public_id),
  CONSTRAINT release_shards_content_key UNIQUE (
    knowledge_base_id, logical_kind, checksum_sha256,
    first_logical_path, last_logical_path
  ),
  CONSTRAINT release_shards_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT release_shards_object_fkey FOREIGN KEY (object_id)
    REFERENCES focowiki.object_registrations (object_id) ON DELETE RESTRICT,
  CONSTRAINT release_shards_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND logical_kind <> '' AND octet_length(logical_kind) <= 128
  ),
  CONSTRAINT release_shards_path_check CHECK (
    first_logical_path <> '' AND octet_length(first_logical_path) <= 4096
    AND last_logical_path <> '' AND octet_length(last_logical_path) <= 4096
    AND first_logical_path <= last_logical_path
  ),
  CONSTRAINT release_shards_record_count_nonnegative_check CHECK (record_count >= 0),
  CONSTRAINT release_shards_byte_count_nonnegative_check CHECK (byte_count >= 0),
  CONSTRAINT release_shards_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE focowiki.release_root_shards (
  knowledge_base_id text NOT NULL,
  release_root_public_id text NOT NULL,
  release_shard_public_id text NOT NULL,
  ordinal bigint NOT NULL,
  PRIMARY KEY (release_root_public_id, release_shard_public_id),
  CONSTRAINT release_root_shards_root_fkey FOREIGN KEY (
    knowledge_base_id, release_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT release_root_shards_shard_fkey FOREIGN KEY (
    knowledge_base_id, release_shard_public_id
  ) REFERENCES focowiki.release_shards (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT release_root_shards_ordinal_check CHECK (ordinal >= 0)
);

CREATE FUNCTION focowiki.resolve_release_shards(requested_root_public_id text)
RETURNS TABLE (
  public_id text,
  logical_kind text,
  first_logical_path text,
  last_logical_path text,
  record_count bigint,
  byte_count bigint,
  checksum_sha256 text,
  object_id text,
  ordinal bigint,
  root_owned boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT root.public_id, root.base_root_public_id, 0 AS depth,
           ARRAY[root.public_id]::text[] AS visited
    FROM focowiki.release_roots root
    WHERE root.public_id = requested_root_public_id
    UNION ALL
    SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
           lineage.visited || base.public_id
    FROM lineage
    JOIN focowiki.release_roots base
      ON base.public_id = lineage.base_root_public_id
    WHERE lineage.depth < 63
      AND NOT base.public_id = ANY(lineage.visited)
  ), effective AS (
    SELECT DISTINCT ON (
             shard.logical_kind COLLATE "C",
             CASE
               WHEN shard.logical_kind = 'directory_navigation'
                 THEN length(shard.first_logical_path)::text || ':'
                   || shard.first_logical_path || ':' || attached.ordinal::text
               ELSE attached.ordinal::text
             END COLLATE "C"
           )
           shard.public_id, shard.logical_kind, shard.first_logical_path,
           shard.last_logical_path, shard.record_count, shard.byte_count,
           shard.checksum_sha256, shard.object_id, attached.ordinal,
           lineage.depth
    FROM lineage
    JOIN focowiki.release_root_shards attached
      ON attached.release_root_public_id = lineage.public_id
    JOIN focowiki.release_shards shard
      ON shard.knowledge_base_id = attached.knowledge_base_id
     AND shard.public_id = attached.release_shard_public_id
    ORDER BY shard.logical_kind COLLATE "C",
             CASE
               WHEN shard.logical_kind = 'directory_navigation'
                 THEN length(shard.first_logical_path)::text || ':'
                   || shard.first_logical_path || ':' || attached.ordinal::text
               ELSE attached.ordinal::text
             END COLLATE "C",
             lineage.depth
  )
  SELECT effective.public_id, effective.logical_kind,
         effective.first_logical_path, effective.last_logical_path,
         effective.record_count, effective.byte_count,
         effective.checksum_sha256, effective.object_id,
         effective.ordinal, effective.depth = 0
  FROM effective
$$;

CREATE TABLE focowiki.release_catalog_entries (
  knowledge_base_id text NOT NULL,
  release_root_public_id text NOT NULL,
  logical_path text NOT NULL,
  entry_kind text NOT NULL,
  source_file_public_id text,
  checksum_sha256 text NOT NULL,
  object_id text NOT NULL,
  byte_count bigint NOT NULL,
  ordinal bigint NOT NULL,
  PRIMARY KEY (release_root_public_id, logical_path),
  CONSTRAINT release_catalog_entries_root_fkey FOREIGN KEY (
    knowledge_base_id, release_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT release_catalog_entries_source_file_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id
  ) REFERENCES focowiki.source_files (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT release_catalog_entries_object_fkey FOREIGN KEY (object_id)
    REFERENCES focowiki.object_registrations (object_id) ON DELETE RESTRICT,
  CONSTRAINT release_catalog_entries_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
  ),
  CONSTRAINT release_catalog_entries_kind_check CHECK (
    entry_kind IN ('source', 'index', 'directory', 'schema', 'log', 'graph')
  ),
  CONSTRAINT release_catalog_entries_source_check CHECK (
    (entry_kind = 'source' AND source_file_public_id IS NOT NULL)
    OR (entry_kind <> 'source' AND source_file_public_id IS NULL)
  ),
  CONSTRAINT release_catalog_entries_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT release_catalog_entries_byte_count_nonnegative_check CHECK (byte_count >= 0),
  CONSTRAINT release_catalog_entries_ordinal_check CHECK (ordinal >= 0)
);

CREATE TABLE focowiki.release_catalog_tombstones (
  knowledge_base_id text NOT NULL,
  release_root_public_id text NOT NULL,
  logical_path text NOT NULL,
  PRIMARY KEY (release_root_public_id, logical_path),
  CONSTRAINT release_catalog_tombstones_root_fkey FOREIGN KEY (
    knowledge_base_id, release_root_public_id
  ) REFERENCES focowiki.release_roots (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_catalog_tombstones_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
  )
);

CREATE FUNCTION focowiki.resolve_release_catalog(requested_root_public_id text)
RETURNS TABLE (
  logical_path text,
  entry_kind text,
  source_file_public_id text,
  checksum_sha256 text,
  object_id text,
  byte_count bigint,
  ordinal bigint,
  root_owned boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT root.public_id, root.base_root_public_id, 0 AS depth,
           ARRAY[root.public_id]::text[] AS visited
    FROM focowiki.release_roots root
    WHERE root.public_id = requested_root_public_id
    UNION ALL
    SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
           lineage.visited || base.public_id
    FROM lineage
    JOIN focowiki.release_roots base
      ON base.public_id = lineage.base_root_public_id
    WHERE lineage.depth < 63
      AND NOT base.public_id = ANY(lineage.visited)
  ), layered AS (
    SELECT entry.logical_path, entry.entry_kind,
           entry.source_file_public_id, entry.checksum_sha256,
           entry.object_id, entry.byte_count, entry.ordinal,
           lineage.depth, false AS deleted
    FROM lineage
    JOIN focowiki.release_catalog_entries entry
      ON entry.release_root_public_id = lineage.public_id
    UNION ALL
    SELECT tombstone.logical_path, NULL::text, NULL::text, NULL::text,
           NULL::text, NULL::bigint, NULL::bigint,
           lineage.depth, true AS deleted
    FROM lineage
    JOIN focowiki.release_catalog_tombstones tombstone
      ON tombstone.release_root_public_id = lineage.public_id
  ), effective AS (
    SELECT DISTINCT ON (layered.logical_path COLLATE "C")
           layered.*
    FROM layered
    ORDER BY layered.logical_path COLLATE "C", layered.depth
  )
  SELECT effective.logical_path, effective.entry_kind,
         effective.source_file_public_id, effective.checksum_sha256,
         effective.object_id, effective.byte_count, effective.ordinal,
         effective.depth = 0
  FROM effective
  WHERE NOT effective.deleted
$$;

CREATE TABLE focowiki.directory_summaries (
  knowledge_base_id text NOT NULL,
  release_root_public_id text NOT NULL,
  directory_public_id text,
  logical_path text NOT NULL,
  first_leaf_path text,
  direct_file_count bigint NOT NULL,
  descendant_file_count bigint NOT NULL,
  ordinal bigint NOT NULL,
  PRIMARY KEY (release_root_public_id, logical_path),
  CONSTRAINT directory_summaries_root_fkey FOREIGN KEY (
    knowledge_base_id, release_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT directory_summaries_directory_fkey FOREIGN KEY (
    knowledge_base_id, directory_public_id
  ) REFERENCES focowiki.source_directories (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT directory_summaries_directory_identity_key UNIQUE (
    release_root_public_id, directory_public_id
  ),
  CONSTRAINT directory_summaries_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
    AND (first_leaf_path IS NULL OR octet_length(first_leaf_path) <= 4096)
  ),
  CONSTRAINT directory_summaries_count_nonnegative_check CHECK (
    direct_file_count >= 0 AND descendant_file_count >= direct_file_count
  ),
  CONSTRAINT directory_summaries_ordinal_check CHECK (ordinal >= 0)
);

CREATE FUNCTION focowiki.resolve_release_directory_summaries(
  requested_root_public_id text
)
RETURNS TABLE (
  directory_public_id text,
  logical_path text,
  first_leaf_path text,
  direct_file_count bigint,
  descendant_file_count bigint,
  ordinal bigint,
  root_owned boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT root.public_id, root.base_root_public_id, 0 AS depth,
           ARRAY[root.public_id]::text[] AS visited
    FROM focowiki.release_roots root
    WHERE root.public_id = requested_root_public_id
    UNION ALL
    SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
           lineage.visited || base.public_id
    FROM lineage
    JOIN focowiki.release_roots base
      ON base.public_id = lineage.base_root_public_id
    WHERE lineage.depth < 63
      AND NOT base.public_id = ANY(lineage.visited)
  ), identity_effective AS (
    SELECT DISTINCT ON (summary.directory_public_id)
           summary.directory_public_id, summary.logical_path,
           summary.first_leaf_path, summary.direct_file_count,
           summary.descendant_file_count, summary.ordinal, lineage.depth
    FROM lineage
    JOIN focowiki.directory_summaries summary
      ON summary.release_root_public_id = lineage.public_id
    ORDER BY summary.directory_public_id, lineage.depth
  ), effective AS (
    SELECT DISTINCT ON (summary.logical_path COLLATE "C")
           summary.directory_public_id, summary.logical_path,
           summary.first_leaf_path, summary.direct_file_count,
           summary.descendant_file_count, summary.ordinal, summary.depth
    FROM identity_effective summary
    ORDER BY summary.logical_path COLLATE "C", summary.depth
  )
  SELECT effective.directory_public_id, effective.logical_path,
         effective.first_leaf_path, effective.direct_file_count,
         effective.descendant_file_count, effective.ordinal,
         effective.depth = 0
  FROM effective
$$;

CREATE TABLE focowiki.knowledge_base_summaries (
  release_root_public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  source_file_count bigint NOT NULL,
  directory_count bigint NOT NULL,
  generated_entry_count bigint NOT NULL,
  graph_node_count bigint NOT NULL,
  graph_edge_count bigint NOT NULL,
  generated_byte_count bigint NOT NULL,
  CONSTRAINT knowledge_base_summaries_root_fkey FOREIGN KEY (
    knowledge_base_id, release_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT knowledge_base_summaries_count_nonnegative_check CHECK (
    source_file_count >= 0 AND directory_count >= 0
    AND generated_entry_count >= 0 AND graph_node_count >= 0
    AND graph_edge_count >= 0 AND generated_byte_count >= 0
  )
);

CREATE FUNCTION focowiki.resolve_release_knowledge_base_summary(
  requested_root_public_id text
)
RETURNS TABLE (
  source_file_count bigint,
  directory_count bigint,
  generated_entry_count bigint,
  graph_node_count bigint,
  graph_edge_count bigint,
  generated_byte_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT root.public_id, root.base_root_public_id, 0 AS depth,
           ARRAY[root.public_id]::text[] AS visited
    FROM focowiki.release_roots root
    WHERE root.public_id = requested_root_public_id
    UNION ALL
    SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
           lineage.visited || base.public_id
    FROM lineage
    JOIN focowiki.release_roots base
      ON base.public_id = lineage.base_root_public_id
    WHERE lineage.depth < 63
      AND NOT base.public_id = ANY(lineage.visited)
  )
  SELECT summary.source_file_count, summary.directory_count,
         summary.generated_entry_count, summary.graph_node_count,
         summary.graph_edge_count, summary.generated_byte_count
  FROM lineage
  JOIN focowiki.knowledge_base_summaries summary
    ON summary.release_root_public_id = lineage.public_id
  ORDER BY lineage.depth
  LIMIT 1
$$;

CREATE TABLE focowiki.search_projections (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  projection_role text NOT NULL,
  provider_kind text NOT NULL,
  provider_index_uid text NOT NULL,
  schema_checksum_sha256 text NOT NULL,
  settings_checksum_sha256 text NOT NULL,
  document_checksum_sha256 text,
  revision bigint NOT NULL,
  document_count bigint NOT NULL,
  next_batch_ordinal bigint NOT NULL DEFAULT 0,
  last_batch_ordinal bigint,
  last_batch_checksum_sha256 text,
  state text NOT NULL,
  correlation_public_id text,
  provider_operation_ref text,
  safe_error_code text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT search_projections_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT search_projections_role_key UNIQUE (knowledge_base_id, projection_role),
  CONSTRAINT search_projections_provider_key UNIQUE (provider_kind, provider_index_uid),
  CONSTRAINT search_projections_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT search_projections_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND knowledge_base_id <> '' AND octet_length(knowledge_base_id) <= 255
    AND provider_index_uid <> '' AND octet_length(provider_index_uid) <= 255
    AND (correlation_public_id IS NULL
      OR (correlation_public_id <> '' AND octet_length(correlation_public_id) <= 255))
    AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
  ),
  CONSTRAINT search_projections_role_check CHECK (
    projection_role IN ('active', 'candidate')
  ),
  CONSTRAINT search_projections_provider_kind_check CHECK (
    provider_kind IN ('meilisearch', 'opensearch')
  ),
  CONSTRAINT search_projections_checksum_check CHECK (
    schema_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND settings_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND (document_checksum_sha256 IS NULL
      OR document_checksum_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT search_projections_revision_check CHECK (revision >= 0),
  CONSTRAINT search_projections_document_count_nonnegative_check CHECK (document_count >= 0),
  CONSTRAINT search_projections_batch_check CHECK (
    next_batch_ordinal >= 0
    AND (
      (last_batch_ordinal IS NULL AND last_batch_checksum_sha256 IS NULL)
      OR (
        last_batch_ordinal = next_batch_ordinal - 1
        AND last_batch_checksum_sha256 ~ '^[0-9a-f]{64}$'
      )
    )
  ),
  CONSTRAINT search_projections_provider_operation_check CHECK (
    provider_operation_ref IS NULL OR (
      provider_operation_ref <> ''
      AND octet_length(provider_operation_ref) <= 2048
      AND correlation_public_id IS NOT NULL
    )
  ),
  CONSTRAINT search_projections_state_check CHECK (
    state IN ('preparing', 'indexing', 'validating', 'ready', 'failed')
  ),
  CONSTRAINT search_projections_validation_check CHECK (
    state NOT IN ('validating', 'ready') OR document_checksum_sha256 IS NOT NULL
  ),
  CONSTRAINT search_projections_error_check CHECK (
    (state = 'failed' AND safe_error_code IS NOT NULL)
    OR (state <> 'failed' AND safe_error_code IS NULL)
  )
);

CREATE TABLE focowiki.meilisearch_projection_maintenance (
  projection_public_id text PRIMARY KEY,
  last_compacted_at timestamp with time zone,
  last_database_size_bytes bigint,
  last_used_database_size_bytes bigint,
  CONSTRAINT meilisearch_projection_maintenance_projection_fkey
    FOREIGN KEY (projection_public_id)
    REFERENCES focowiki.search_projections (public_id) ON DELETE CASCADE,
  CONSTRAINT meilisearch_projection_maintenance_compaction_check CHECK (
    (
      last_compacted_at IS NULL
      AND last_database_size_bytes IS NULL
      AND last_used_database_size_bytes IS NULL
    ) OR (
      last_compacted_at IS NOT NULL
      AND last_database_size_bytes IS NOT NULL
      AND last_used_database_size_bytes IS NOT NULL
      AND last_database_size_bytes >= 0
      AND last_used_database_size_bytes >= 0
      AND last_used_database_size_bytes <= last_database_size_bytes
    )
  )
);

CREATE TABLE focowiki.active_snapshots (
  knowledge_base_id text PRIMARY KEY,
  release_root_public_id text NOT NULL,
  search_projection_public_id text NOT NULL,
  manifest_checksum_sha256 text NOT NULL,
  revision bigint NOT NULL,
  activated_by_operation_public_id text NOT NULL,
  publicly_visible_at timestamp with time zone NOT NULL,
  CONSTRAINT active_snapshots_release_root_fkey FOREIGN KEY (
    knowledge_base_id, release_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT active_snapshots_search_projection_fkey FOREIGN KEY (
    knowledge_base_id, search_projection_public_id
  ) REFERENCES focowiki.search_projections (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT active_snapshots_operation_fkey FOREIGN KEY (
    knowledge_base_id, activated_by_operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT active_snapshots_manifest_check CHECK (
    manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT active_snapshots_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.release_candidates (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_public_id text NOT NULL,
  candidate_root_public_id text NOT NULL,
  expected_active_root_public_id text,
  expected_active_revision bigint NOT NULL,
  state text NOT NULL,
  changed_fact_count bigint NOT NULL,
  affected_dependency_count bigint NOT NULL,
  manifest_checksum_sha256 text,
  reason_code text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT release_candidates_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT release_candidates_knowledge_base_key UNIQUE (knowledge_base_id),
  CONSTRAINT release_candidates_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT release_candidates_candidate_root_fkey FOREIGN KEY (
    knowledge_base_id, candidate_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT release_candidates_expected_root_fkey FOREIGN KEY (
    knowledge_base_id, expected_active_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT release_candidates_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT release_candidates_state_check CHECK (
    state IN (
      'building', 'validating', 'ready', 'failed',
      'cancelled', 'superseded', 'timed_out'
    )
  ),
  CONSTRAINT release_candidates_revision_check CHECK (expected_active_revision >= 0),
  CONSTRAINT release_candidates_count_nonnegative_check CHECK (
    changed_fact_count >= 0 AND affected_dependency_count >= 0
  ),
  CONSTRAINT release_candidates_count_bounded_check CHECK (
    changed_fact_count <= 100000 AND affected_dependency_count <= 250000
  ),
  CONSTRAINT release_candidates_manifest_check CHECK (
    manifest_checksum_sha256 IS NULL
    OR manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT release_candidates_reason_check CHECK (
    reason_code IS NULL OR octet_length(reason_code) <= 128
  )
);

CREATE TABLE focowiki.release_candidate_graph_nodes (
  candidate_public_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  public_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  logical_path text NOT NULL,
  label text NOT NULL,
  node_kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  PRIMARY KEY (candidate_public_id, public_id),
  CONSTRAINT release_candidate_graph_nodes_source_key UNIQUE (
    candidate_public_id, source_file_public_id
  ),
  CONSTRAINT release_candidate_graph_nodes_candidate_fkey FOREIGN KEY (
    knowledge_base_id, candidate_public_id
  ) REFERENCES focowiki.release_candidates (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_nodes_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_nodes_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT release_candidate_graph_nodes_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
  ),
  CONSTRAINT release_candidate_graph_nodes_label_check CHECK (
    label <> '' AND octet_length(label) <= 1024
    AND node_kind <> '' AND octet_length(node_kind) <= 128
  ),
  CONSTRAINT release_candidate_graph_nodes_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192
  ),
  CONSTRAINT release_candidate_graph_nodes_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.release_candidate_graph_edges (
  candidate_public_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  public_id text NOT NULL,
  from_node_public_id text NOT NULL,
  to_node_public_id text NOT NULL,
  relation text NOT NULL,
  weight double precision NOT NULL,
  reason text,
  edge_source text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  PRIMARY KEY (candidate_public_id, public_id),
  CONSTRAINT release_candidate_graph_edges_relationship_key UNIQUE (
    candidate_public_id, from_node_public_id, to_node_public_id, relation
  ),
  CONSTRAINT release_candidate_graph_edges_candidate_fkey FOREIGN KEY (
    knowledge_base_id, candidate_public_id
  ) REFERENCES focowiki.release_candidates (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_edges_from_node_fkey FOREIGN KEY (
    candidate_public_id, from_node_public_id
  ) REFERENCES focowiki.release_candidate_graph_nodes (
    candidate_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_edges_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND relation <> '' AND octet_length(relation) <= 128
    AND edge_source <> '' AND octet_length(edge_source) <= 128
  ),
  CONSTRAINT release_candidate_graph_edges_endpoints_check CHECK (
    from_node_public_id <> to_node_public_id
  ),
  CONSTRAINT release_candidate_graph_edges_weight_check CHECK (
    weight >= 0 AND weight <= 1
  ),
  CONSTRAINT release_candidate_graph_edges_reason_check CHECK (
    reason IS NULL OR octet_length(reason) <= 2048
  ),
  CONSTRAINT release_candidate_graph_edges_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192
  ),
  CONSTRAINT release_candidate_graph_edges_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.release_candidate_graph_evidence (
  candidate_public_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  public_id text NOT NULL,
  node_public_id text,
  edge_public_id text,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  logical_path text NOT NULL,
  start_offset bigint NOT NULL,
  end_offset bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  PRIMARY KEY (candidate_public_id, public_id),
  CONSTRAINT release_candidate_graph_evidence_candidate_fkey FOREIGN KEY (
    knowledge_base_id, candidate_public_id
  ) REFERENCES focowiki.release_candidates (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_evidence_node_fkey FOREIGN KEY (
    candidate_public_id, node_public_id
  ) REFERENCES focowiki.release_candidate_graph_nodes (
    candidate_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_evidence_edge_fkey FOREIGN KEY (
    candidate_public_id, edge_public_id
  ) REFERENCES focowiki.release_candidate_graph_edges (
    candidate_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_evidence_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT release_candidate_graph_evidence_target_check CHECK (
    (node_public_id IS NOT NULL)::integer + (edge_public_id IS NOT NULL)::integer = 1
  ),
  CONSTRAINT release_candidate_graph_evidence_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
  ),
  CONSTRAINT release_candidate_graph_evidence_offset_range_check CHECK (
    start_offset >= 0 AND end_offset >= start_offset
  ),
  CONSTRAINT release_candidate_graph_evidence_checksum_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE focowiki.release_candidate_changed_facts (
  knowledge_base_id text NOT NULL,
  candidate_public_id text NOT NULL,
  fact_kind text NOT NULL,
  fact_public_id text NOT NULL,
  change_kind text NOT NULL,
  PRIMARY KEY (candidate_public_id, fact_kind, fact_public_id),
  CONSTRAINT release_candidate_changed_facts_candidate_fkey FOREIGN KEY (
    knowledge_base_id, candidate_public_id
  ) REFERENCES focowiki.release_candidates (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT release_candidate_changed_facts_kind_check CHECK (
    fact_kind IN ('knowledge_base', 'directory', 'source_file', 'source_revision', 'graph_node', 'graph_edge')
  ),
  CONSTRAINT release_candidate_changed_facts_change_check CHECK (
    change_kind IN ('created', 'updated', 'deleted')
  ),
  CONSTRAINT release_candidate_changed_facts_identity_check CHECK (
    fact_public_id <> '' AND octet_length(fact_public_id) <= 255
  )
);

CREATE TABLE focowiki.release_candidate_dependencies (
  knowledge_base_id text NOT NULL,
  candidate_public_id text NOT NULL,
  dependency_kind text NOT NULL,
  dependency_public_id text NOT NULL,
  reason_code text NOT NULL,
  PRIMARY KEY (candidate_public_id, dependency_kind, dependency_public_id),
  CONSTRAINT release_candidate_dependencies_candidate_fkey FOREIGN KEY (
    knowledge_base_id, candidate_public_id
  ) REFERENCES focowiki.release_candidates (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT release_candidate_dependencies_kind_check CHECK (
    dependency_kind IN (
      'path', 'ancestor', 'link', 'search', 'graph',
      'index', 'schema', 'log', 'scope'
    )
  ),
  CONSTRAINT release_candidate_dependencies_identity_check CHECK (
    dependency_public_id <> '' AND octet_length(dependency_public_id) <= 4096
    AND reason_code <> '' AND octet_length(reason_code) <= 128
  )
);

CREATE TABLE focowiki.release_candidate_validations (
  candidate_public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  manifest_checksum_sha256 text NOT NULL,
  search_projection_public_id text NOT NULL,
  object_owner_count bigint NOT NULL,
  search_document_count bigint NOT NULL,
  graph_node_count bigint NOT NULL,
  graph_edge_count bigint NOT NULL,
  link_count bigint NOT NULL,
  generated_entry_count bigint NOT NULL,
  object_validation_passed boolean NOT NULL,
  search_validation_passed boolean NOT NULL,
  graph_validation_passed boolean NOT NULL,
  link_validation_passed boolean NOT NULL,
  count_validation_passed boolean NOT NULL,
  path_validation_passed boolean NOT NULL,
  validated_at timestamp with time zone NOT NULL,
  CONSTRAINT release_candidate_validations_candidate_fkey FOREIGN KEY (
    knowledge_base_id, candidate_public_id
  ) REFERENCES focowiki.release_candidates (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT release_candidate_validations_search_fkey FOREIGN KEY (
    knowledge_base_id, search_projection_public_id
  ) REFERENCES focowiki.search_projections (knowledge_base_id, public_id) ON DELETE RESTRICT,
  CONSTRAINT release_candidate_validations_manifest_check CHECK (
    manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT release_candidate_validations_count_check CHECK (
    object_owner_count >= 0 AND search_document_count >= 0
    AND graph_node_count >= 0 AND graph_edge_count >= 0
    AND link_count >= 0 AND generated_entry_count >= 0
  ),
  CONSTRAINT release_candidate_validations_passed_check CHECK (
    object_validation_passed AND search_validation_passed
    AND graph_validation_passed AND link_validation_passed
    AND count_validation_passed AND path_validation_passed
  )
);

CREATE TABLE focowiki.release_event_summaries (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_public_id text NOT NULL,
  candidate_public_id text NOT NULL,
  release_root_public_id text,
  outcome text NOT NULL,
  result_code text NOT NULL,
  safe_message text,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT release_event_summaries_scope_key UNIQUE (
    knowledge_base_id, public_id
  ),
  CONSTRAINT release_event_summaries_candidate_outcome_key UNIQUE (
    knowledge_base_id, candidate_public_id, outcome
  ),
  CONSTRAINT release_event_summaries_knowledge_base_fkey FOREIGN KEY (
    knowledge_base_id
  ) REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT release_event_summaries_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND operation_public_id <> '' AND octet_length(operation_public_id) <= 255
    AND candidate_public_id <> '' AND octet_length(candidate_public_id) <= 255
    AND (
      release_root_public_id IS NULL
      OR octet_length(release_root_public_id) <= 255
    )
  ),
  CONSTRAINT release_event_summaries_outcome_check CHECK (
    outcome IN (
      'activated', 'failed', 'cancelled', 'superseded',
      'timed_out', 'rollback_expired'
    )
  ),
  CONSTRAINT release_event_summaries_result_check CHECK (
    result_code <> '' AND octet_length(result_code) <= 128
    AND (safe_message IS NULL OR octet_length(safe_message) <= 2048)
  ),
  CONSTRAINT release_event_summaries_revision_check CHECK (revision >= 0),
  CONSTRAINT release_event_summaries_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE focowiki.object_owners (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  object_id text NOT NULL,
  owner_kind text NOT NULL,
  source_revision_public_id text,
  release_root_public_id text,
  release_shard_public_id text,
  operation_public_id text,
  owner_public_id text GENERATED ALWAYS AS (
    coalesce(
      source_revision_public_id,
      release_root_public_id,
      release_shard_public_id,
      operation_public_id
    )
  ) STORED,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT object_owners_identity_key UNIQUE (object_id, owner_kind, owner_public_id),
  CONSTRAINT object_owners_object_fkey FOREIGN KEY (object_id)
    REFERENCES focowiki.object_registrations (object_id) ON DELETE CASCADE,
  CONSTRAINT object_owners_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT object_owners_release_root_fkey FOREIGN KEY (
    knowledge_base_id, release_root_public_id
  ) REFERENCES focowiki.release_roots (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT object_owners_release_shard_fkey FOREIGN KEY (
    knowledge_base_id, release_shard_public_id
  ) REFERENCES focowiki.release_shards (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT object_owners_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT object_owners_public_id_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT object_owners_kind_check CHECK (
    owner_kind IN (
      'source_revision', 'active_root', 'candidate_root',
      'rollback_root', 'shared_segment', 'live_reservation'
    )
  ),
  CONSTRAINT object_owners_target_check CHECK (
    (source_revision_public_id IS NOT NULL)::integer
    + (release_root_public_id IS NOT NULL)::integer
    + (release_shard_public_id IS NOT NULL)::integer
    + (operation_public_id IS NOT NULL)::integer = 1
    AND (
      (owner_kind = 'source_revision' AND source_revision_public_id IS NOT NULL)
      OR (owner_kind IN ('active_root', 'candidate_root', 'rollback_root') AND release_root_public_id IS NOT NULL)
      OR (owner_kind = 'shared_segment' AND release_shard_public_id IS NOT NULL)
      OR (owner_kind = 'live_reservation' AND operation_public_id IS NOT NULL)
    )
  )
);

CREATE TABLE focowiki.cleanup_actions (
  public_id text PRIMARY KEY,
  operation_public_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  action_kind text NOT NULL,
  cleanup_plane text NOT NULL,
  search_provider_kind text,
  resource_kind text NOT NULL,
  resource_public_id text NOT NULL,
  required boolean NOT NULL,
  sequence_number integer NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL,
  attempt_count integer NOT NULL,
  lease_owner text,
  lease_expires_at timestamp with time zone,
  safe_error_code text,
  not_before timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cleanup_actions_idempotency_key UNIQUE NULLS NOT DISTINCT (
    operation_public_id, action_kind, cleanup_plane, search_provider_kind,
    resource_kind,
    resource_public_id, idempotency_key
  ),
  CONSTRAINT cleanup_actions_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT cleanup_actions_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND action_kind <> '' AND octet_length(action_kind) <= 128
    AND cleanup_plane IN ('postgres', 'object_storage', 'search', 'redis', 'process')
    AND resource_kind <> '' AND octet_length(resource_kind) <= 128
    AND resource_public_id <> '' AND octet_length(resource_public_id) <= 255
    AND idempotency_key <> '' AND octet_length(idempotency_key) <= 255
    AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT cleanup_actions_search_provider_check CHECK (
    (
      cleanup_plane = 'search'
      AND search_provider_kind IN ('meilisearch', 'opensearch')
    ) OR (
      cleanup_plane <> 'search'
      AND search_provider_kind IS NULL
    )
  ),
  CONSTRAINT cleanup_actions_checkpoint_check CHECK (
    jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 32768
  ),
  CONSTRAINT cleanup_actions_state_check CHECK (
    state IN ('queued', 'running', 'retry')
  ),
  CONSTRAINT cleanup_actions_attempt_check CHECK (
    attempt_count >= 0 AND sequence_number >= 0
  ),
  CONSTRAINT cleanup_actions_lease_check CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT cleanup_actions_error_check CHECK (
    safe_error_code IS NULL OR octet_length(safe_error_code) <= 128
  )
);

CREATE TABLE focowiki.upload_sessions (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_public_id text NOT NULL,
  manifest_fingerprint text,
  state text NOT NULL,
  expected_entry_count bigint NOT NULL,
  expected_byte_count bigint NOT NULL,
  received_entry_count bigint NOT NULL,
  received_byte_count bigint NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT upload_sessions_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT upload_sessions_operation_key UNIQUE (operation_public_id),
  CONSTRAINT upload_sessions_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT upload_sessions_state_check CHECK (
    state IN ('draft', 'uploading', 'finalizing')
  ),
  CONSTRAINT upload_sessions_manifest_check CHECK (
    (state = 'draft' AND manifest_fingerprint IS NULL)
    OR (state <> 'draft' AND manifest_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT upload_sessions_count_nonnegative_check CHECK (
    expected_entry_count >= 0 AND received_entry_count >= 0
    AND received_entry_count <= expected_entry_count
  ),
  CONSTRAINT upload_sessions_byte_count_nonnegative_check CHECK (
    expected_byte_count >= 0 AND received_byte_count >= 0
    AND received_byte_count <= expected_byte_count
  ),
  CONSTRAINT upload_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE focowiki.upload_entries (
  upload_session_public_id text NOT NULL,
  entry_public_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  source_file_public_id text NOT NULL,
  logical_path text NOT NULL,
  normalized_path text NOT NULL,
  checksum_sha256 text,
  byte_count bigint NOT NULL,
  content_type text NOT NULL,
  object_id text,
  state text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_session_public_id, entry_public_id),
  CONSTRAINT upload_entries_path_key UNIQUE (upload_session_public_id, normalized_path),
  CONSTRAINT upload_entries_source_file_key UNIQUE (
    upload_session_public_id, source_file_public_id
  ),
  CONSTRAINT upload_entries_session_fkey FOREIGN KEY (
    knowledge_base_id, upload_session_public_id
  ) REFERENCES focowiki.upload_sessions (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT upload_entries_object_fkey FOREIGN KEY (object_id)
    REFERENCES focowiki.object_registrations (object_id) ON DELETE RESTRICT,
  CONSTRAINT upload_entries_identity_check CHECK (
    entry_public_id <> '' AND octet_length(entry_public_id) <= 255
    AND source_file_public_id <> '' AND octet_length(source_file_public_id) <= 255
    AND knowledge_base_id <> '' AND octet_length(knowledge_base_id) <= 255
  ),
  CONSTRAINT upload_entries_path_check CHECK (
    logical_path <> '' AND octet_length(logical_path) <= 4096
    AND normalized_path <> '' AND octet_length(normalized_path) <= 4096
  ),
  CONSTRAINT upload_entries_checksum_check CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT upload_entries_byte_count_nonnegative_check CHECK (byte_count >= 0),
  CONSTRAINT upload_entries_content_type_check CHECK (
    content_type = 'text/markdown; charset=utf-8'
  ),
  CONSTRAINT upload_entries_state_check CHECK (
    state IN ('pending', 'uploaded', 'verified')
  ),
  CONSTRAINT upload_entries_object_state_check CHECK (
    (state = 'pending' AND object_id IS NULL)
    OR (state <> 'pending' AND object_id IS NOT NULL AND checksum_sha256 IS NOT NULL)
  )
);

CREATE TABLE focowiki.upload_path_reservations (
  knowledge_base_id text NOT NULL,
  normalized_path text NOT NULL,
  upload_session_public_id text NOT NULL,
  upload_entry_public_id text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_base_id, normalized_path),
  CONSTRAINT upload_path_reservations_session_fkey FOREIGN KEY (
    knowledge_base_id, upload_session_public_id
  ) REFERENCES focowiki.upload_sessions (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT upload_path_reservations_entry_fkey FOREIGN KEY (
    upload_session_public_id, upload_entry_public_id
  ) REFERENCES focowiki.upload_entries (
    upload_session_public_id, entry_public_id
  ) ON DELETE CASCADE,
  CONSTRAINT upload_path_reservations_path_check CHECK (
    normalized_path <> '' AND octet_length(normalized_path) <= 4096
  ),
  CONSTRAINT upload_path_reservations_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE focowiki.webhook_deliveries (
  public_id text PRIMARY KEY,
  knowledge_base_id text,
  subscription_public_id text NOT NULL,
  operation_public_id text,
  event_public_id text NOT NULL,
  event_type text NOT NULL,
  event_payload jsonb NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL,
  next_attempt_at timestamp with time zone,
  lease_owner text,
  lease_expires_at timestamp with time zone,
  provider_correlation_id text,
  http_status integer,
  safe_error_code text,
  completed_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  redelivery_of_public_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_subscription_public_fkey FOREIGN KEY (
    subscription_public_id
  ) REFERENCES focowiki.webhook_subscriptions (public_id) ON DELETE CASCADE,
  CONSTRAINT webhook_deliveries_subscription_fkey FOREIGN KEY (
    knowledge_base_id, subscription_public_id
  ) REFERENCES focowiki.webhook_subscriptions (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT webhook_deliveries_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT webhook_deliveries_redelivery_fkey FOREIGN KEY (
    redelivery_of_public_id
  ) REFERENCES focowiki.webhook_deliveries (public_id) ON DELETE SET NULL,
  CONSTRAINT webhook_deliveries_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND event_public_id <> '' AND octet_length(event_public_id) <= 255
    AND event_type <> '' AND octet_length(event_type) <= 128
  ),
  CONSTRAINT webhook_deliveries_state_check CHECK (
    state IN ('queued', 'running', 'retry', 'completed', 'failed')
  ),
  CONSTRAINT webhook_deliveries_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT webhook_deliveries_payload_check CHECK (
    jsonb_typeof(event_payload) = 'object'
    AND octet_length(event_payload::text) <= 32768
    AND (provider_correlation_id IS NULL OR octet_length(provider_correlation_id) <= 255)
    AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
    AND (http_status IS NULL OR http_status BETWEEN 100 AND 599)
  ),
  CONSTRAINT webhook_deliveries_lease_check CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT webhook_deliveries_terminal_check CHECK (
    (state IN ('completed', 'failed') AND completed_at IS NOT NULL
      AND next_attempt_at IS NULL)
    OR (state IN ('queued', 'retry') AND completed_at IS NULL
      AND next_attempt_at IS NOT NULL)
    OR (state = 'running' AND completed_at IS NULL)
  ),
  CONSTRAINT webhook_deliveries_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT webhook_deliveries_redelivery_check CHECK (
    redelivery_of_public_id IS DISTINCT FROM public_id
  )
);

CREATE TABLE focowiki.operation_results (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_kind text NOT NULL,
  terminal_state text NOT NULL,
  result_code text NOT NULL,
  safe_message text,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_public_id text,
  completed_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT operation_results_operation_fkey FOREIGN KEY (
    knowledge_base_id, public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT operation_results_kind_check CHECK (
    operation_kind <> '' AND octet_length(operation_kind) <= 128
  ),
  CONSTRAINT operation_results_state_check CHECK (
    terminal_state IN ('completed', 'failed', 'cancelled', 'superseded', 'timed_out', 'deleted')
  ),
  CONSTRAINT operation_results_code_check CHECK (
    result_code <> '' AND octet_length(result_code) <= 128
  ),
  CONSTRAINT operation_results_message_check CHECK (
    safe_message IS NULL OR octet_length(safe_message) <= 2048
  ),
  CONSTRAINT operation_results_summary_check CHECK (
    jsonb_typeof(result_summary) = 'object'
    AND octet_length(result_summary::text) <= 32768
  ),
  CONSTRAINT operation_results_expiry_check CHECK (expires_at > completed_at)
);

CREATE TABLE focowiki.security_audit_events (
  public_id text NOT NULL,
  knowledge_base_id text,
  actor_public_id text,
  event_type text NOT NULL,
  target_kind text,
  target_public_id text,
  result text NOT NULL,
  reason_code text,
  source_ip inet,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT security_audit_events_pkey PRIMARY KEY (created_at, public_id),
  CONSTRAINT security_audit_events_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE SET NULL,
  CONSTRAINT security_audit_events_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND (actor_public_id IS NULL OR octet_length(actor_public_id) <= 255)
    AND event_type <> '' AND octet_length(event_type) <= 128
  ),
  CONSTRAINT security_audit_events_target_check CHECK (
    (target_kind IS NULL AND target_public_id IS NULL)
    OR (target_kind IS NOT NULL AND target_public_id IS NOT NULL
      AND octet_length(target_kind) <= 128 AND octet_length(target_public_id) <= 255)
  ),
  CONSTRAINT security_audit_events_result_check CHECK (
    result IN ('success', 'failure', 'blocked')
  ),
  CONSTRAINT security_audit_events_payload_check CHECK (
    (reason_code IS NULL OR octet_length(reason_code) <= 128)
    AND (user_agent IS NULL OR octet_length(user_agent) <= 1024)
  ),
  CONSTRAINT security_audit_events_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384
  ),
  CONSTRAINT security_audit_events_expiry_check CHECK (expires_at > created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE focowiki.diagnostic_events (
  public_id text NOT NULL,
  knowledge_base_id text,
  operation_public_id text,
  stage text NOT NULL,
  severity text NOT NULL,
  event_code text NOT NULL,
  safe_message text,
  duration_ms bigint,
  correlation_public_id text,
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT diagnostic_events_pkey PRIMARY KEY (created_at, public_id),
  CONSTRAINT diagnostic_events_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT diagnostic_events_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND stage <> '' AND octet_length(stage) <= 128
    AND event_code <> '' AND octet_length(event_code) <= 128
  ),
  CONSTRAINT diagnostic_events_severity_check CHECK (
    severity IN ('debug', 'info', 'warn', 'error')
  ),
  CONSTRAINT diagnostic_events_message_check CHECK (
    safe_message IS NULL OR octet_length(safe_message) <= 2048
  ),
  CONSTRAINT diagnostic_events_duration_check CHECK (
    duration_ms IS NULL OR duration_ms >= 0
  ),
  CONSTRAINT diagnostic_events_expiry_check CHECK (expires_at > created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE focowiki.deployment_scopes (
  public_id text PRIMARY KEY,
  run_id text NOT NULL,
  owner_marker text NOT NULL,
  postgres_scope text NOT NULL,
  object_scope text NOT NULL,
  search_scope text NOT NULL,
  coordination_scope text NOT NULL,
  filesystem_scope text NOT NULL,
  proof_checksum_sha256 text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT deployment_scopes_run_key UNIQUE (run_id),
  CONSTRAINT deployment_scopes_owner_key UNIQUE (owner_marker),
  CONSTRAINT deployment_scopes_targets_key UNIQUE (
    postgres_scope, object_scope, search_scope, coordination_scope, filesystem_scope
  ),
  CONSTRAINT deployment_scopes_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND run_id ~ '^svnext-[a-z0-9]{8,16}$'
    AND owner_marker <> '' AND octet_length(owner_marker) <= 255
  ),
  CONSTRAINT deployment_scopes_target_check CHECK (
    postgres_scope <> '' AND octet_length(postgres_scope) <= 255
    AND object_scope <> '' AND octet_length(object_scope) <= 1024
    AND search_scope <> '' AND octet_length(search_scope) <= 255
    AND coordination_scope <> '' AND octet_length(coordination_scope) <= 255
    AND filesystem_scope <> '' AND octet_length(filesystem_scope) <= 2048
  ),
  CONSTRAINT deployment_scopes_checksum_check CHECK (
    proof_checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE focowiki.deployment_states (
  public_id text PRIMARY KEY,
  scope_public_id text NOT NULL,
  phase text NOT NULL,
  schema_version text NOT NULL,
  active_snapshot_public_id text,
  revision bigint NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT deployment_states_scope_key UNIQUE (scope_public_id),
  CONSTRAINT deployment_states_scope_fkey FOREIGN KEY (scope_public_id)
    REFERENCES focowiki.deployment_scopes (public_id) ON DELETE CASCADE,
  CONSTRAINT deployment_states_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND schema_version = 'storage-vnext-v1'
    AND (active_snapshot_public_id IS NULL OR octet_length(active_snapshot_public_id) <= 255)
  ),
  CONSTRAINT deployment_states_phase_check CHECK (
    phase IN (
      'empty', 'bootstrapped', 'rebuilding', 'validated', 'active',
      'rollback_window', 'retirement_ready', 'retired'
    )
  ),
  CONSTRAINT deployment_states_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.rebuild_checkpoints (
  public_id text PRIMARY KEY,
  deployment_public_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  source_cursor text,
  completed_file_count bigint NOT NULL,
  completed_byte_count bigint NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT rebuild_checkpoints_scope_key UNIQUE (deployment_public_id, knowledge_base_id),
  CONSTRAINT rebuild_checkpoints_deployment_fkey FOREIGN KEY (deployment_public_id)
    REFERENCES focowiki.deployment_states (public_id) ON DELETE CASCADE,
  CONSTRAINT rebuild_checkpoints_knowledge_base_fkey FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT rebuild_checkpoints_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND (source_cursor IS NULL OR octet_length(source_cursor) <= 2048)
  ),
  CONSTRAINT rebuild_checkpoints_count_nonnegative_check CHECK (
    completed_file_count >= 0 AND completed_byte_count >= 0
  ),
  CONSTRAINT rebuild_checkpoints_payload_check CHECK (
    jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 32768
  )
);

CREATE TABLE focowiki.validation_evidence (
  public_id text PRIMARY KEY,
  deployment_public_id text NOT NULL,
  manifest_checksum_sha256 text NOT NULL,
  source_count bigint NOT NULL,
  logical_path_count bigint NOT NULL,
  object_count bigint NOT NULL,
  search_document_count bigint NOT NULL,
  graph_node_count bigint NOT NULL,
  graph_edge_count bigint NOT NULL,
  owner_closure_passed boolean NOT NULL,
  generated_structure_passed boolean NOT NULL,
  admin_contract_passed boolean NOT NULL,
  openapi_contract_passed boolean NOT NULL,
  resource_budget_passed boolean NOT NULL,
  restore_passed boolean NOT NULL,
  validated_at timestamp with time zone NOT NULL,
  CONSTRAINT validation_evidence_deployment_key UNIQUE (deployment_public_id),
  CONSTRAINT validation_evidence_deployment_fkey FOREIGN KEY (deployment_public_id)
    REFERENCES focowiki.deployment_states (public_id) ON DELETE CASCADE,
  CONSTRAINT validation_evidence_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
  ),
  CONSTRAINT validation_evidence_manifest_check CHECK (
    manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT validation_evidence_count_nonnegative_check CHECK (
    source_count >= 0 AND logical_path_count >= 0 AND object_count >= 0
    AND search_document_count >= 0 AND graph_node_count >= 0 AND graph_edge_count >= 0
  )
);

CREATE TABLE focowiki.rollback_evidence (
  public_id text PRIMARY KEY,
  deployment_public_id text NOT NULL,
  restorable_backup_public_id text NOT NULL,
  accepted_write_export_public_id text,
  pre_cutover_drill_passed boolean NOT NULL,
  post_cutover_drill_passed boolean NOT NULL,
  verified_at timestamp with time zone NOT NULL,
  CONSTRAINT rollback_evidence_deployment_key UNIQUE (deployment_public_id),
  CONSTRAINT rollback_evidence_deployment_fkey FOREIGN KEY (deployment_public_id)
    REFERENCES focowiki.deployment_states (public_id) ON DELETE CASCADE,
  CONSTRAINT rollback_evidence_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND restorable_backup_public_id <> ''
    AND octet_length(restorable_backup_public_id) <= 255
    AND (accepted_write_export_public_id IS NULL
      OR octet_length(accepted_write_export_public_id) <= 255)
  )
);

CREATE TABLE focowiki.retirement_evidence (
  public_id text PRIMARY KEY,
  deployment_public_id text NOT NULL,
  restorable_backup_public_id text NOT NULL,
  legacy_inventory_checksum_sha256 text NOT NULL,
  rollback_expired_at timestamp with time zone NOT NULL,
  product_parity_passed boolean NOT NULL,
  cleanup_closure_passed boolean NOT NULL,
  capacity_passed boolean NOT NULL,
  approved_at timestamp with time zone NOT NULL,
  CONSTRAINT retirement_evidence_deployment_key UNIQUE (deployment_public_id),
  CONSTRAINT retirement_evidence_deployment_fkey FOREIGN KEY (deployment_public_id)
    REFERENCES focowiki.deployment_states (public_id) ON DELETE CASCADE,
  CONSTRAINT retirement_evidence_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND restorable_backup_public_id <> ''
    AND octet_length(restorable_backup_public_id) <= 255
  ),
  CONSTRAINT retirement_evidence_checksum_check CHECK (
    legacy_inventory_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT retirement_evidence_approval_check CHECK (
    rollback_expired_at <= approved_at
    AND product_parity_passed AND cleanup_closure_passed AND capacity_passed
  )
);

DO $storage_vnext_partitions$
DECLARE
  current_month date := date_trunc('month', CURRENT_DATE)::date;
  partition_start date;
  partition_end date;
  family text;
BEGIN
  FOREACH family IN ARRAY ARRAY['security_audit_events', 'diagnostic_events']
  LOOP
    FOREACH partition_start IN ARRAY ARRAY[
      current_month,
      (current_month + interval '1 month')::date
    ]
    LOOP
      partition_end := (partition_start + interval '1 month')::date;
      EXECUTE format(
        'CREATE TABLE focowiki.%I PARTITION OF focowiki.%I FOR VALUES FROM (%L) TO (%L)',
        family || '_' || to_char(partition_start, 'YYYY_MM'),
        family,
        partition_start,
        partition_end
      );
    END LOOP;
  END LOOP;
END
$storage_vnext_partitions$;

CREATE INDEX source_directories_active_parent_path_idx ON focowiki.source_directories (knowledge_base_id, parent_public_id, normalized_path, public_id) WHERE deleted_at IS NULL;
CREATE INDEX source_files_active_directory_path_idx ON focowiki.source_files (knowledge_base_id, directory_public_id, normalized_path, public_id) WHERE deleted_at IS NULL;
CREATE INDEX source_files_active_model_invocation_idx ON focowiki.source_files (knowledge_base_id, model_invocation_status, logical_path, public_id) WHERE deleted_at IS NULL;
CREATE INDEX source_file_current_revisions_revision_idx ON focowiki.source_file_current_revisions (knowledge_base_id, source_revision_public_id, source_file_public_id);
CREATE INDEX source_revisions_object_idx ON focowiki.source_revisions (object_id, knowledge_base_id, public_id);
CREATE INDEX source_event_summaries_scope_time_idx ON focowiki.source_event_summaries (knowledge_base_id, source_file_public_id, created_at, sequence_number, public_id);
CREATE INDEX source_event_summaries_expiry_idx ON focowiki.source_event_summaries (expires_at, public_id);

CREATE INDEX graph_nodes_source_revision_idx ON focowiki.graph_nodes (knowledge_base_id, source_file_public_id, source_revision_public_id, public_id);
CREATE INDEX graph_edges_from_node_idx ON focowiki.graph_edges (knowledge_base_id, from_node_public_id, weight DESC, public_id);
CREATE INDEX graph_edges_to_node_idx ON focowiki.graph_edges (knowledge_base_id, to_node_public_id, weight DESC, public_id);
CREATE INDEX graph_evidence_refs_node_idx ON focowiki.graph_evidence_refs (knowledge_base_id, node_public_id, public_id) WHERE node_public_id IS NOT NULL;
CREATE INDEX graph_evidence_refs_edge_idx ON focowiki.graph_evidence_refs (knowledge_base_id, edge_public_id, public_id) WHERE edge_public_id IS NOT NULL;
CREATE INDEX graph_evidence_refs_source_file_idx ON focowiki.graph_evidence_refs (knowledge_base_id, source_file_public_id, public_id);

CREATE INDEX release_shards_object_idx ON focowiki.release_shards (object_id, knowledge_base_id, public_id);
CREATE INDEX release_root_shards_shard_idx ON focowiki.release_root_shards (knowledge_base_id, release_shard_public_id, release_root_public_id);
CREATE INDEX release_catalog_entries_source_file_idx ON focowiki.release_catalog_entries (knowledge_base_id, source_file_public_id, release_root_public_id) WHERE source_file_public_id IS NOT NULL;
CREATE INDEX release_catalog_entries_object_idx ON focowiki.release_catalog_entries (object_id, release_root_public_id, logical_path);
CREATE INDEX directory_summaries_directory_idx ON focowiki.directory_summaries (knowledge_base_id, directory_public_id, release_root_public_id);

CREATE INDEX active_snapshots_release_root_idx ON focowiki.active_snapshots (knowledge_base_id, release_root_public_id);
CREATE INDEX active_snapshots_search_projection_idx ON focowiki.active_snapshots (knowledge_base_id, search_projection_public_id);
CREATE INDEX active_snapshots_operation_idx ON focowiki.active_snapshots (knowledge_base_id, activated_by_operation_public_id);
CREATE INDEX search_projections_failed_cleanup_idx ON focowiki.search_projections (provider_kind, updated_at, public_id) WHERE projection_role = 'candidate' AND state = 'failed';
CREATE INDEX meilisearch_projection_maintenance_compaction_idx ON focowiki.meilisearch_projection_maintenance (last_compacted_at, projection_public_id);
CREATE INDEX release_candidates_operation_idx ON focowiki.release_candidates (knowledge_base_id, operation_public_id);
CREATE INDEX release_candidates_candidate_root_idx ON focowiki.release_candidates (knowledge_base_id, candidate_root_public_id);
CREATE INDEX release_candidates_expected_root_idx ON focowiki.release_candidates (knowledge_base_id, expected_active_root_public_id) WHERE expected_active_root_public_id IS NOT NULL;
CREATE INDEX release_event_summaries_scope_time_idx ON focowiki.release_event_summaries (knowledge_base_id, created_at DESC, public_id DESC);
CREATE INDEX release_event_summaries_expiry_idx ON focowiki.release_event_summaries (expires_at, public_id);

CREATE INDEX object_owners_source_revision_idx ON focowiki.object_owners (knowledge_base_id, source_revision_public_id, object_id) WHERE source_revision_public_id IS NOT NULL;
CREATE INDEX object_owners_release_root_idx ON focowiki.object_owners (knowledge_base_id, release_root_public_id, object_id) WHERE release_root_public_id IS NOT NULL;
CREATE INDEX object_owners_release_shard_idx ON focowiki.object_owners (knowledge_base_id, release_shard_public_id, object_id) WHERE release_shard_public_id IS NOT NULL;
CREATE INDEX object_owners_operation_idx ON focowiki.object_owners (knowledge_base_id, operation_public_id, object_id) WHERE operation_public_id IS NOT NULL;
CREATE INDEX object_registrations_zero_owner_idx ON focowiki.object_registrations (zero_owner_since, object_id) WHERE state = 'verified' AND zero_owner_since IS NOT NULL;
CREATE INDEX object_registrations_stale_reservation_idx ON focowiki.object_registrations (created_at, object_id) WHERE state = 'reserved';

CREATE INDEX operation_work_items_settings_idx ON focowiki.operation_work_items (settings_revision_public_id, operation_public_id);
CREATE INDEX operation_idempotency_operation_idx ON focowiki.operation_idempotency (knowledge_base_id, operation_public_id);
CREATE INDEX operation_dependencies_dependency_idx ON focowiki.operation_dependencies (knowledge_base_id, dependency_operation_public_id, operation_public_id);
CREATE UNIQUE INDEX operations_live_maintenance_owner_idx ON focowiki.operations (knowledge_base_id) WHERE operation_kind = 'maintenance' AND state IN ('accepted', 'validating', 'processing', 'publishing');
CREATE INDEX upload_entries_object_idx ON focowiki.upload_entries (object_id, upload_session_public_id) WHERE object_id IS NOT NULL;
CREATE INDEX upload_sessions_expiry_idx ON focowiki.upload_sessions (expires_at, public_id);
CREATE INDEX upload_path_reservations_expiry_idx ON focowiki.upload_path_reservations (expires_at, knowledge_base_id, normalized_path);
CREATE INDEX webhook_deliveries_subscription_idx ON focowiki.webhook_deliveries (knowledge_base_id, subscription_public_id, public_id);
CREATE INDEX webhook_deliveries_operation_idx ON focowiki.webhook_deliveries (knowledge_base_id, operation_public_id, public_id);
CREATE UNIQUE INDEX webhook_deliveries_original_event_idx ON focowiki.webhook_deliveries (subscription_public_id, event_public_id) WHERE redelivery_of_public_id IS NULL;

CREATE INDEX operation_work_items_claim_idx ON focowiki.operation_work_items (work_kind, next_attempt_at, updated_at, operation_public_id) WHERE state IN ('queued', 'retry');
CREATE INDEX operation_work_items_lease_idx ON focowiki.operation_work_items (lease_expires_at, operation_public_id) WHERE state = 'running';
CREATE INDEX operation_results_scope_time_idx ON focowiki.operation_results (knowledge_base_id, completed_at DESC, public_id DESC);
CREATE INDEX cleanup_actions_claim_idx ON focowiki.cleanup_actions (not_before, sequence_number, updated_at, public_id) WHERE state IN ('queued', 'retry');
CREATE INDEX cleanup_actions_lease_idx ON focowiki.cleanup_actions (lease_expires_at, public_id) WHERE state = 'running';
CREATE INDEX webhook_deliveries_claim_idx ON focowiki.webhook_deliveries (next_attempt_at, updated_at, public_id) WHERE state IN ('queued', 'retry');
CREATE INDEX webhook_deliveries_lease_idx ON focowiki.webhook_deliveries (lease_expires_at, public_id) WHERE state = 'running';
CREATE INDEX webhook_deliveries_expiry_idx ON focowiki.webhook_deliveries (expires_at, public_id) WHERE state IN ('completed', 'failed');

CREATE INDEX security_audit_events_scope_time_idx ON focowiki.security_audit_events (knowledge_base_id, created_at DESC, public_id);
CREATE INDEX security_audit_events_type_time_idx ON focowiki.security_audit_events (event_type, result, created_at DESC, public_id);

CREATE TABLE focowiki.runtime_generation (
  singleton boolean PRIMARY KEY,
  generation text NOT NULL,
  initialized_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT runtime_generation_singleton_check CHECK (singleton),
  CONSTRAINT runtime_generation_value_check CHECK (generation = 'storage-vnext-v1')
);

INSERT INTO focowiki.runtime_generation (singleton, generation)
VALUES (true, 'storage-vnext-v1');
