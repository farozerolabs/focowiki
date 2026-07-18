--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: focowiki; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA focowiki;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA focowiki;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: active_object_refs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.active_object_refs (
    knowledge_base_id text NOT NULL,
    ref_kind text NOT NULL,
    ref_key text NOT NULL,
    file_id text NOT NULL,
    last_changed_generation_id text NOT NULL,
    checksum_sha256 text NOT NULL,
    format_version integer NOT NULL,
    logical_path text,
    source_file_id text,
    projection_shard_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: active_projection_records; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.active_projection_records (
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    record_id text NOT NULL,
    last_changed_generation_id text NOT NULL,
    shard_key text NOT NULL,
    source_file_id text,
    related_source_file_id text,
    logical_path text,
    parent_path text,
    sort_key text,
    title text,
    summary text,
    searchable_text text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT active_projection_records_kind_check CHECK ((projection_kind = ANY (ARRAY['search'::text, 'links'::text, 'manifest'::text, 'tree'::text, 'graph_node'::text, 'graph_edge'::text, 'related_files'::text]))),
    CONSTRAINT active_projection_records_payload_check CHECK ((jsonb_typeof(payload_json) = 'object'::text))
);


--
-- Name: admin_audit_events; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.admin_audit_events (
    id text NOT NULL,
    event_type text NOT NULL,
    result text NOT NULL,
    error_code text,
    username text,
    client_ip text,
    user_agent text,
    origin text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_audit_events_result_check CHECK ((result = ANY (ARRAY['success'::text, 'failure'::text, 'blocked'::text])))
);


--
-- Name: cleanup_checkpoints; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.cleanup_checkpoints (
    job_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    deletion_intent_id text NOT NULL,
    phase text NOT NULL,
    discovery_cursor text,
    discovery_completed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cleanup_checkpoints_phase_check CHECK ((phase = ANY (ARRAY['object_discovery'::text, 'object_deletion'::text, 'database_cleanup'::text]))),
    CONSTRAINT cleanup_checkpoints_target_kind_check CHECK ((target_kind = ANY (ARRAY['source_file'::text, 'source_directory'::text, 'knowledge_base'::text])))
);


--
-- Name: cleanup_object_deletions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.cleanup_object_deletions (
    job_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    object_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cleanup_object_deletions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'deleted'::text])))
);


--
-- Name: deletion_intents; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.deletion_intents (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    catalog_generation bigint NOT NULL,
    state text DEFAULT 'accepted'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    progress_cursor text,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT deletion_intents_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT deletion_intents_catalog_generation_check CHECK ((catalog_generation >= 0)),
    CONSTRAINT deletion_intents_state_check CHECK ((state = ANY (ARRAY['accepted'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text]))),
    CONSTRAINT deletion_intents_target_kind_check CHECK ((target_kind = ANY (ARRAY['source_file'::text, 'source_directory'::text, 'knowledge_base'::text])))
);


--
-- Name: directory_navigation_leaves; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.directory_navigation_leaves (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    directory_path text NOT NULL,
    previous_leaf_id text,
    next_leaf_id text,
    entry_count integer NOT NULL,
    byte_count integer NOT NULL,
    first_sort_key text,
    last_sort_key text,
    entries_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT directory_navigation_leaves_count_check CHECK (((entry_count >= 0) AND (byte_count >= 0))),
    CONSTRAINT directory_navigation_leaves_entries_check CHECK ((jsonb_typeof(entries_json) = 'array'::text))
);


--
-- Name: directory_navigation_summaries; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.directory_navigation_summaries (
    knowledge_base_id text NOT NULL,
    directory_path text NOT NULL,
    entry_count bigint DEFAULT 0 NOT NULL,
    first_leaf_id text,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT directory_navigation_summaries_count_check CHECK ((entry_count >= 0))
);


--
-- Name: dispatch_pressure_state; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.dispatch_pressure_state (
    scope text NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    reason text,
    pressure_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dispatch_pressure_state_json_check CHECK ((jsonb_typeof(pressure_json) = 'object'::text)),
    CONSTRAINT dispatch_pressure_state_scope_check CHECK ((scope = 'global'::text))
);


--
-- Name: generation_object_refs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.generation_object_refs (
    generation_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    ref_kind text NOT NULL,
    ref_key text NOT NULL,
    file_id text,
    action text DEFAULT 'upsert'::text NOT NULL,
    checksum_sha256 text,
    format_version integer,
    logical_path text,
    source_file_id text,
    projection_shard_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_object_refs_action_check CHECK ((action = ANY (ARRAY['upsert'::text, 'delete'::text]))),
    CONSTRAINT generation_object_refs_object_check CHECK ((((action = 'upsert'::text) AND (file_id IS NOT NULL) AND (checksum_sha256 IS NOT NULL) AND (format_version IS NOT NULL)) OR ((action = 'delete'::text) AND (file_id IS NULL) AND (checksum_sha256 IS NULL) AND (format_version IS NULL))))
);


--
-- Name: generation_projection_records; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.generation_projection_records (
    generation_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    record_id text NOT NULL,
    action text DEFAULT 'upsert'::text NOT NULL,
    shard_key text NOT NULL,
    source_file_id text,
    related_source_file_id text,
    logical_path text,
    parent_path text,
    sort_key text,
    title text,
    summary text,
    searchable_text text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_projection_records_action_check CHECK ((action = ANY (ARRAY['upsert'::text, 'delete'::text]))),
    CONSTRAINT generation_projection_records_kind_check CHECK ((projection_kind = ANY (ARRAY['search'::text, 'links'::text, 'manifest'::text, 'tree'::text, 'graph_node'::text, 'graph_edge'::text, 'related_files'::text]))),
    CONSTRAINT generation_projection_records_payload_check CHECK ((jsonb_typeof(payload_json) = 'object'::text))
);


--
-- Name: immutable_objects; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.immutable_objects (
    checksum_sha256 text NOT NULL,
    format_version integer NOT NULL,
    object_key text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    deletion_job_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT immutable_objects_checksum_check CHECK ((checksum_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT immutable_objects_format_check CHECK ((format_version > 0)),
    CONSTRAINT immutable_objects_lifecycle_check CHECK ((((lifecycle_state = 'active'::text) AND (deletion_job_id IS NULL)) OR ((lifecycle_state = 'deleting'::text) AND (deletion_job_id IS NOT NULL)))),
    CONSTRAINT immutable_objects_size_check CHECK ((size_bytes >= 0))
);


--
-- Name: knowledge_bases; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_bases (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    active_generation_id text,
    resource_revision integer DEFAULT 1 NOT NULL,
    catalog_generation bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT knowledge_bases_catalog_generation_check CHECK ((catalog_generation >= 0)),
    CONSTRAINT knowledge_bases_id_check CHECK ((id ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'::text)),
    CONSTRAINT knowledge_bases_resource_revision_check CHECK ((resource_revision >= 1))
);


--
-- Name: model_configs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.model_configs (
    id text NOT NULL,
    display_name text NOT NULL,
    api_mode text DEFAULT 'responses'::text NOT NULL,
    base_url text NOT NULL,
    encrypted_api_key text NOT NULL,
    api_key_fingerprint text NOT NULL,
    model_name text NOT NULL,
    context_window_tokens integer NOT NULL,
    request_max_timeout_ms integer NOT NULL,
    request_idle_timeout_ms integer NOT NULL,
    suggestion_concurrency integer NOT NULL,
    transient_retry_delay_ms integer NOT NULL,
    request_min_interval_ms integer NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT model_configs_api_mode_check CHECK ((api_mode = ANY (ARRAY['responses'::text, 'chat_completions'::text]))),
    CONSTRAINT model_configs_positive_values_check CHECK (((context_window_tokens > 0) AND (request_max_timeout_ms > 0) AND (request_idle_timeout_ms > 0) AND (suggestion_concurrency > 0) AND (transient_retry_delay_ms > 0) AND (request_min_interval_ms >= 0))),
    CONSTRAINT model_configs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'deleted'::text])))
);


--
-- Name: model_invocations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.model_invocations (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    api_mode text,
    model_name text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    warning_count integer DEFAULT 0 NOT NULL,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model_config_id text,
    CONSTRAINT model_invocations_api_mode_check CHECK (((api_mode IS NULL) OR (api_mode = ANY (ARRAY['responses'::text, 'chat_completions'::text])))),
    CONSTRAINT model_invocations_check CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT model_invocations_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT model_invocations_warning_count_check CHECK ((warning_count >= 0))
);


--
-- Name: projection_shards; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.projection_shards (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    shard_key text NOT NULL,
    format_version integer NOT NULL,
    checksum_sha256 text NOT NULL,
    object_key text NOT NULL,
    record_count integer NOT NULL,
    first_sort_key text,
    last_sort_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_shards_format_check CHECK ((format_version > 0)),
    CONSTRAINT projection_shards_record_count_check CHECK ((record_count >= 0))
);


--
-- Name: public_api_keys; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.public_api_keys (
    id text NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    key_suffix text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT public_api_keys_check CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT public_api_keys_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);


--
-- Name: publication_change_facts; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.publication_change_facts (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text,
    source_revision_id text,
    operation_id text,
    deletion_intent_id text,
    kind text NOT NULL,
    previous_path text,
    path text,
    resource_revision bigint NOT NULL,
    generation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_change_facts_kind_check CHECK ((kind = ANY (ARRAY['source_created'::text, 'source_replaced'::text, 'source_metadata_changed'::text, 'source_moved'::text, 'source_renamed'::text, 'directory_moved'::text, 'knowledge_base_metadata_changed'::text, 'source_deleted'::text, 'directory_deleted'::text, 'knowledge_base_deleted'::text]))),
    CONSTRAINT publication_change_facts_revision_check CHECK ((resource_revision > 0))
);


--
-- Name: publication_generations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.publication_generations (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    predecessor_generation_id text,
    successor_generation_id text,
    state text DEFAULT 'open'::text NOT NULL,
    format_version integer DEFAULT 1 NOT NULL,
    root_manifest_checksum_sha256 text,
    root_manifest_object_key text,
    frozen_at timestamp with time zone,
    validated_at timestamp with time zone,
    activated_at timestamp with time zone,
    failed_at timestamp with time zone,
    safe_error_code text,
    safe_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_generations_error_check CHECK ((((state = 'failed'::text) AND (safe_error_code IS NOT NULL) AND (safe_error_message IS NOT NULL) AND (failed_at IS NOT NULL)) OR ((state <> 'failed'::text) AND (safe_error_code IS NULL) AND (safe_error_message IS NULL) AND (failed_at IS NULL)))),
    CONSTRAINT publication_generations_format_check CHECK ((format_version > 0)),
    CONSTRAINT publication_generations_state_check CHECK ((state = ANY (ARRAY['open'::text, 'frozen'::text, 'building'::text, 'validating'::text, 'active'::text, 'failed'::text, 'superseded'::text])))
);


--
-- Name: publication_impact_causes; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.publication_impact_causes (
    impact_id text NOT NULL,
    change_fact_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: publication_impacts; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.publication_impacts (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    generation_id text NOT NULL,
    projection_kind text NOT NULL,
    projection_key text NOT NULL,
    record_identity text NOT NULL,
    action text NOT NULL,
    projection_input_key text,
    status text DEFAULT 'pending'::text NOT NULL,
    retry_cursor_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_impacts_action_check CHECK ((action = ANY (ARRAY['upsert'::text, 'delete'::text, 'validate'::text]))),
    CONSTRAINT publication_impacts_attempt_check CHECK (((attempt_count >= 0) AND (max_attempts > 0))),
    CONSTRAINT publication_impacts_projection_kind_check CHECK ((projection_kind = ANY (ARRAY['page'::text, 'directory'::text, 'root'::text, 'search'::text, 'links'::text, 'manifest'::text, 'tree'::text, 'graph_node'::text, 'graph_edge'::text, 'graph_reverse_neighbor'::text, 'related_files'::text, 'cleanup'::text]))),
    CONSTRAINT publication_impacts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: publication_projection_inputs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.publication_projection_inputs (
    knowledge_base_id text NOT NULL,
    generation_id text NOT NULL,
    input_key text NOT NULL,
    payload_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_projection_inputs_payload_check CHECK ((jsonb_typeof(payload_json) = 'object'::text))
);


--
-- Name: publication_progress; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.publication_progress (
    knowledge_base_id text NOT NULL,
    generation_id text NOT NULL,
    stage text NOT NULL,
    processed_impact_count bigint DEFAULT 0 NOT NULL,
    total_impact_count bigint DEFAULT 0 NOT NULL,
    touched_shard_count bigint DEFAULT 0 NOT NULL,
    oldest_dirty_at timestamp with time zone,
    queued_at timestamp with time zone,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_success_at timestamp with time zone,
    safe_error_code text,
    safe_error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_progress_counts_check CHECK (((processed_impact_count >= 0) AND (total_impact_count >= 0) AND (processed_impact_count <= total_impact_count) AND (touched_shard_count >= 0))),
    CONSTRAINT publication_progress_stage_check CHECK ((stage = ANY (ARRAY['pending'::text, 'planning'::text, 'projection'::text, 'validation'::text, 'activation'::text, 'active'::text, 'failed'::text])))
);


--
-- Name: resource_operation_targets; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.resource_operation_targets (
    operation_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    expected_resource_revision integer,
    sequence_number bigint DEFAULT 0 NOT NULL,
    current_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    candidate_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_operation_targets_target_kind_check CHECK ((target_kind = ANY (ARRAY['source_file'::text, 'source_directory'::text, 'knowledge_base'::text])))
);


--
-- Name: resource_operations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.resource_operations (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_kind text NOT NULL,
    state text DEFAULT 'accepted'::text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    request_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    expected_resource_revision integer,
    candidate_catalog_generation bigint NOT NULL,
    result_json jsonb,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT resource_operations_candidate_catalog_generation_check CHECK ((candidate_catalog_generation >= 0)),
    CONSTRAINT resource_operations_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['source_file_replace'::text, 'source_file_move'::text, 'source_directory_move'::text, 'source_file_delete'::text, 'source_directory_delete'::text, 'knowledge_base_delete'::text]))),
    CONSTRAINT resource_operations_state_check CHECK ((state = ANY (ARRAY['accepted'::text, 'validating'::text, 'processing'::text, 'publishing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text])))
);


--
-- Name: resource_path_reservations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.resource_path_reservations (
    knowledge_base_id text NOT NULL,
    resource_kind text NOT NULL,
    path_key text NOT NULL,
    operation_id text NOT NULL,
    target_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_path_reservations_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['source_file'::text, 'source_directory'::text])))
);


--
-- Name: role_heartbeats; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.role_heartbeats (
    worker_id text NOT NULL,
    role text NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    active_job_count integer DEFAULT 0 NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_heartbeats_count_check CHECK ((active_job_count >= 0)),
    CONSTRAINT role_heartbeats_role_check CHECK ((role = ANY (ARRAY['source'::text, 'publication'::text, 'maintenance'::text])))
);


--
-- Name: role_jobs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.role_jobs (
    id text NOT NULL,
    role text NOT NULL,
    kind text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text,
    source_revision_id text,
    generation_id text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    locked_by text,
    locked_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_jobs_attempt_check CHECK (((attempt_count >= 0) AND (max_attempts > 0))),
    CONSTRAINT role_jobs_role_check CHECK ((role = ANY (ARRAY['source'::text, 'publication'::text, 'maintenance'::text]))),
    CONSTRAINT role_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'dead_letter'::text, 'cancelled'::text])))
);


--
-- Name: runtime_generation; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.runtime_generation (
    singleton boolean DEFAULT true NOT NULL,
    generation text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_generation_singleton_check CHECK (singleton)
);


--
-- Name: runtime_setting_audit_logs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.runtime_setting_audit_logs (
    id text NOT NULL,
    setting_key text NOT NULL,
    action text NOT NULL,
    actor text,
    value_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: runtime_settings; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.runtime_settings (
    key text NOT NULL,
    value_json jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    source text DEFAULT 'bootstrap'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_settings_key_check CHECK ((key = ANY (ARRAY['rate_limits'::text, 'worker'::text, 'publication'::text, 'graph'::text]))),
    CONSTRAINT runtime_settings_source_check CHECK ((source = ANY (ARRAY['bootstrap'::text, 'admin'::text])))
);


--
-- Name: source_directories; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_directories (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    parent_id text,
    name text NOT NULL,
    relative_path text NOT NULL,
    path_key text NOT NULL,
    depth integer NOT NULL,
    resource_revision integer DEFAULT 1 NOT NULL,
    deletion_intent_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    candidate_operation_id text,
    candidate_parent_id text,
    candidate_name text,
    candidate_relative_path text,
    candidate_path_key text,
    candidate_depth integer,
    CONSTRAINT source_directories_check CHECK ((((parent_id IS NULL) AND (depth = 1)) OR ((parent_id IS NOT NULL) AND (depth > 1)))),
    CONSTRAINT source_directories_depth_check CHECK ((depth >= 1)),
    CONSTRAINT source_directories_resource_revision_check CHECK ((resource_revision >= 1))
);


--
-- Name: source_dispatch_markers; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_dispatch_markers (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    source_revision_id text NOT NULL,
    sequence_number bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    dispatched_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_dispatch_markers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'dispatched'::text, 'cancelled'::text])))
);


--
-- Name: source_dispatch_markers_sequence_number_seq; Type: SEQUENCE; Schema: focowiki; Owner: -
--

ALTER TABLE focowiki.source_dispatch_markers ALTER COLUMN sequence_number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME focowiki.source_dispatch_markers_sequence_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: source_file_events; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_file_events (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    stage_key text NOT NULL,
    message_key text NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    severity text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_events_check CHECK (((ended_at IS NULL) OR (started_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT source_file_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text]))),
    CONSTRAINT source_file_events_stage_key_check CHECK ((stage_key = ANY (ARRAY['upload_storage'::text, 'source_deletion'::text, 'metadata_resolution'::text, 'llm_suggestion'::text, 'graph_generation'::text, 'projection_generation'::text, 'generation_validation'::text, 'generation_activation'::text])))
);


--
-- Name: source_file_graph_edges; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_file_graph_edges (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    from_source_file_id text NOT NULL,
    to_source_file_id text NOT NULL,
    relation_type text NOT NULL,
    weight numeric NOT NULL,
    reason text NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    evidence_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_graph_edges_check CHECK ((from_source_file_id <> to_source_file_id)),
    CONSTRAINT source_file_graph_edges_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'rejected'::text]))),
    CONSTRAINT source_file_graph_edges_weight_check CHECK (((weight >= (0)::numeric) AND (weight <= (1)::numeric)))
);


--
-- Name: source_file_graph_jobs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_file_graph_jobs (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_graph_jobs_check CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT source_file_graph_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: source_file_graph_nodes; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_file_graph_nodes (
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    path text NOT NULL,
    title text NOT NULL,
    type text,
    description text,
    summary text,
    subjects_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    entities_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    explicit_references_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    relationship_hints_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    headings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    keywords_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    language text,
    profile_version text,
    profile_source text,
    profile_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_file_retry_attempts; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_file_retry_attempts (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_retry_attempts_check CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT source_file_retry_attempts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: source_files; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_files (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    object_key text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_suggestions_json jsonb,
    processing_status text DEFAULT 'queued'::text NOT NULL,
    processing_stage text DEFAULT 'upload_storage'::text NOT NULL,
    processing_started_at timestamp with time zone,
    processing_ended_at timestamp with time zone,
    terminal_failure_stage text,
    terminal_failure_code text,
    terminal_failure_message text,
    terminal_failure_at timestamp with time zone,
    terminal_failure_retry_kind text,
    terminal_failure_correlation_id text,
    generated_output_status text DEFAULT 'pending'::text NOT NULL,
    graph_relationship_count integer DEFAULT 0 NOT NULL,
    graph_top_relationships_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    model_invocation_status text,
    model_invocation_model_name text,
    model_invocation_started_at timestamp with time zone,
    model_invocation_ended_at timestamp with time zone,
    model_invocation_warning_count integer,
    model_invocation_error_code text,
    retry_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    task_deleted_at timestamp with time zone,
    deleted_at timestamp with time zone,
    name text NOT NULL,
    relative_path text NOT NULL,
    path_key text NOT NULL,
    directory_id text,
    active_revision_id text NOT NULL,
    resource_revision integer DEFAULT 1 NOT NULL,
    content_revision integer DEFAULT 1 NOT NULL,
    candidate_operation_id text,
    candidate_revision_id text,
    candidate_name text,
    candidate_relative_path text,
    candidate_path_key text,
    candidate_directory_id text,
    candidate_object_key text,
    candidate_content_type text,
    candidate_size_bytes bigint,
    candidate_checksum_sha256 text,
    candidate_metadata_json jsonb,
    candidate_model_suggestions_json jsonb,
    deletion_intent_id text,
    CONSTRAINT source_files_check CHECK (((processing_ended_at IS NULL) OR (processing_started_at IS NULL) OR (processing_ended_at >= processing_started_at))),
    CONSTRAINT source_files_generated_output_status_check CHECK ((generated_output_status = ANY (ARRAY['pending'::text, 'visible'::text, 'unavailable'::text]))),
    CONSTRAINT source_files_graph_relationship_count_check CHECK ((graph_relationship_count >= 0)),
    CONSTRAINT source_files_graph_top_relationships_json_check CHECK ((jsonb_typeof(graph_top_relationships_json) = 'array'::text)),
    CONSTRAINT source_files_model_invocation_status_check CHECK (((model_invocation_status IS NULL) OR (model_invocation_status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'skipped'::text])))),
    CONSTRAINT source_files_processing_stage_check CHECK ((processing_stage = ANY (ARRAY['upload_storage'::text, 'metadata_resolution'::text, 'llm_suggestion'::text, 'graph_generation'::text, 'projection_generation'::text, 'generation_validation'::text, 'generation_activation'::text]))),
    CONSTRAINT source_files_processing_status_check CHECK ((processing_status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT source_files_processing_time_check CHECK (((processing_ended_at IS NULL) OR (processing_started_at IS NULL) OR (processing_ended_at >= processing_started_at))),
    CONSTRAINT source_files_retry_count_check CHECK ((retry_count >= 0)),
    CONSTRAINT source_files_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT source_files_terminal_failure_check CHECK ((((terminal_failure_code IS NULL) AND (terminal_failure_stage IS NULL) AND (terminal_failure_message IS NULL) AND (terminal_failure_at IS NULL) AND (terminal_failure_retry_kind IS NULL) AND (terminal_failure_correlation_id IS NULL)) OR ((terminal_failure_code IS NOT NULL) AND (terminal_failure_stage IS NOT NULL) AND (terminal_failure_message IS NOT NULL) AND (terminal_failure_at IS NOT NULL) AND (terminal_failure_retry_kind IS NOT NULL) AND (terminal_failure_correlation_id IS NOT NULL)))),
    CONSTRAINT source_files_terminal_failure_code_length_check CHECK (((terminal_failure_code IS NULL) OR (char_length(terminal_failure_code) <= 128))),
    CONSTRAINT source_files_terminal_failure_correlation_length_check CHECK (((terminal_failure_correlation_id IS NULL) OR (char_length(terminal_failure_correlation_id) <= 200))),
    CONSTRAINT source_files_terminal_failure_message_length_check CHECK (((terminal_failure_message IS NULL) OR (char_length(terminal_failure_message) <= 1000))),
    CONSTRAINT source_files_terminal_failure_retry_kind_check CHECK (((terminal_failure_retry_kind IS NULL) OR (terminal_failure_retry_kind = ANY (ARRAY['source_processing'::text, 'publication'::text, 'none'::text])))),
    CONSTRAINT source_files_terminal_failure_stage_check CHECK (((terminal_failure_stage IS NULL) OR (terminal_failure_stage = ANY (ARRAY['upload_storage'::text, 'metadata_resolution'::text, 'llm_suggestion'::text, 'graph_generation'::text, 'projection_generation'::text, 'generation_validation'::text, 'generation_activation'::text])))),
    CONSTRAINT source_files_visible_failure_check CHECK (((generated_output_status <> 'visible'::text) OR (terminal_failure_code IS NULL)))
);


--
-- Name: source_path_reservations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_path_reservations (
    knowledge_base_id text NOT NULL,
    path_key text NOT NULL,
    session_id text NOT NULL,
    entry_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_revisions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_revisions (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    revision integer NOT NULL,
    object_key text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    processing_status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_revisions_processing_status_check CHECK ((processing_status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'superseded'::text]))),
    CONSTRAINT source_revisions_revision_check CHECK ((revision >= 1)),
    CONSTRAINT source_revisions_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: upload_session_entries; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.upload_session_entries (
    id text NOT NULL,
    session_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    sequence_number bigint NOT NULL,
    relative_path text NOT NULL,
    path_key text NOT NULL,
    directory_path text NOT NULL,
    name text NOT NULL,
    declared_size bigint NOT NULL,
    received_size bigint,
    checksum_sha256 text,
    received_checksum_sha256 text,
    disposition text DEFAULT 'pending'::text NOT NULL,
    transfer_state text DEFAULT 'pending'::text NOT NULL,
    staging_object_key text,
    source_directory_id text,
    source_file_id text,
    existing_resource_revision integer,
    generated_path text NOT NULL,
    error_code text,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_session_entries_declared_size_check CHECK ((declared_size >= 0)),
    CONSTRAINT upload_session_entries_disposition_check CHECK ((disposition = ANY (ARRAY['pending'::text, 'upload_required'::text, 'skipped_existing'::text, 'waiting_reservation'::text, 'rejected_deleting'::text]))),
    CONSTRAINT upload_session_entries_received_size_check CHECK ((received_size >= 0)),
    CONSTRAINT upload_session_entries_transfer_state_check CHECK ((transfer_state = ANY (ARRAY['pending'::text, 'missing'::text, 'uploading'::text, 'uploaded'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: upload_sessions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.upload_sessions (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    idempotency_key text NOT NULL,
    manifest_fingerprint text,
    declared_file_count integer NOT NULL,
    declared_byte_count bigint NOT NULL,
    selected_count integer DEFAULT 0 NOT NULL,
    upload_required_count integer DEFAULT 0 NOT NULL,
    skipped_existing_count integer DEFAULT 0 NOT NULL,
    waiting_reservation_count integer DEFAULT 0 NOT NULL,
    rejected_deleting_count integer DEFAULT 0 NOT NULL,
    uploaded_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    finalized_count integer DEFAULT 0 NOT NULL,
    error_code text,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_sessions_declared_byte_count_check CHECK ((declared_byte_count >= 0)),
    CONSTRAINT upload_sessions_declared_file_count_check CHECK ((declared_file_count >= 0)),
    CONSTRAINT upload_sessions_failed_count_check CHECK ((failed_count >= 0)),
    CONSTRAINT upload_sessions_finalized_count_check CHECK ((finalized_count >= 0)),
    CONSTRAINT upload_sessions_rejected_deleting_count_check CHECK ((rejected_deleting_count >= 0)),
    CONSTRAINT upload_sessions_selected_count_check CHECK ((selected_count >= 0)),
    CONSTRAINT upload_sessions_skipped_existing_count_check CHECK ((skipped_existing_count >= 0)),
    CONSTRAINT upload_sessions_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'manifest_building'::text, 'manifest_sealed'::text, 'uploading'::text, 'finalizing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT upload_sessions_upload_required_count_check CHECK ((upload_required_count >= 0)),
    CONSTRAINT upload_sessions_uploaded_count_check CHECK ((uploaded_count >= 0)),
    CONSTRAINT upload_sessions_waiting_reservation_count_check CHECK ((waiting_reservation_count >= 0))
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.webhook_deliveries (
    id text NOT NULL,
    webhook_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    http_status integer,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_deliveries_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT webhook_deliveries_id_check CHECK ((id ~ '^delivery-[a-zA-Z0-9-]+$'::text)),
    CONSTRAINT webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: webhook_subscriptions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.webhook_subscriptions (
    id text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    signing_secret text NOT NULL,
    events_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_delivery_at timestamp with time zone,
    CONSTRAINT webhook_subscriptions_id_check CHECK ((id ~ '^webhook-[a-zA-Z0-9-]+$'::text))
);


--
-- Name: active_object_refs active_object_refs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.active_object_refs
    ADD CONSTRAINT active_object_refs_pkey PRIMARY KEY (knowledge_base_id, ref_kind, ref_key);


--
-- Name: active_projection_records active_projection_records_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.active_projection_records
    ADD CONSTRAINT active_projection_records_pkey PRIMARY KEY (knowledge_base_id, projection_kind, record_id);


--
-- Name: admin_audit_events admin_audit_events_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.admin_audit_events
    ADD CONSTRAINT admin_audit_events_pkey PRIMARY KEY (id);


--
-- Name: cleanup_checkpoints cleanup_checkpoints_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.cleanup_checkpoints
    ADD CONSTRAINT cleanup_checkpoints_pkey PRIMARY KEY (job_id);


--
-- Name: cleanup_object_deletions cleanup_object_deletions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.cleanup_object_deletions
    ADD CONSTRAINT cleanup_object_deletions_pkey PRIMARY KEY (job_id, object_key);


--
-- Name: deletion_intents deletion_intents_knowledge_base_id_target_kind_target_id_ca_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.deletion_intents
    ADD CONSTRAINT deletion_intents_knowledge_base_id_target_kind_target_id_ca_key UNIQUE (knowledge_base_id, target_kind, target_id, catalog_generation);


--
-- Name: deletion_intents deletion_intents_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.deletion_intents
    ADD CONSTRAINT deletion_intents_pkey PRIMARY KEY (id);


--
-- Name: directory_navigation_leaves directory_navigation_leaves_knowledge_base_id_directory_pat_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.directory_navigation_leaves
    ADD CONSTRAINT directory_navigation_leaves_knowledge_base_id_directory_pat_key UNIQUE (knowledge_base_id, directory_path, id);


--
-- Name: directory_navigation_leaves directory_navigation_leaves_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.directory_navigation_leaves
    ADD CONSTRAINT directory_navigation_leaves_pkey PRIMARY KEY (id);


--
-- Name: directory_navigation_summaries directory_navigation_summaries_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.directory_navigation_summaries
    ADD CONSTRAINT directory_navigation_summaries_pkey PRIMARY KEY (knowledge_base_id, directory_path);


--
-- Name: dispatch_pressure_state dispatch_pressure_state_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.dispatch_pressure_state
    ADD CONSTRAINT dispatch_pressure_state_pkey PRIMARY KEY (scope);


--
-- Name: generation_object_refs generation_object_refs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_object_refs
    ADD CONSTRAINT generation_object_refs_pkey PRIMARY KEY (generation_id, ref_kind, ref_key);


--
-- Name: generation_projection_records generation_projection_records_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_projection_records
    ADD CONSTRAINT generation_projection_records_pkey PRIMARY KEY (generation_id, projection_kind, record_id);


--
-- Name: immutable_objects immutable_objects_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.immutable_objects
    ADD CONSTRAINT immutable_objects_pkey PRIMARY KEY (checksum_sha256, format_version);


--
-- Name: knowledge_bases knowledge_bases_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_bases
    ADD CONSTRAINT knowledge_bases_pkey PRIMARY KEY (id);


--
-- Name: model_configs model_configs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_configs
    ADD CONSTRAINT model_configs_pkey PRIMARY KEY (id);


--
-- Name: model_invocations model_invocations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_invocations
    ADD CONSTRAINT model_invocations_pkey PRIMARY KEY (id);


--
-- Name: projection_shards projection_shards_knowledge_base_id_projection_kind_shard_k_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.projection_shards
    ADD CONSTRAINT projection_shards_knowledge_base_id_projection_kind_shard_k_key UNIQUE (knowledge_base_id, projection_kind, shard_key, format_version, checksum_sha256);


--
-- Name: projection_shards projection_shards_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.projection_shards
    ADD CONSTRAINT projection_shards_pkey PRIMARY KEY (id);


--
-- Name: public_api_keys public_api_keys_key_hash_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.public_api_keys
    ADD CONSTRAINT public_api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: public_api_keys public_api_keys_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.public_api_keys
    ADD CONSTRAINT public_api_keys_pkey PRIMARY KEY (id);


--
-- Name: publication_change_facts publication_change_facts_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_change_facts
    ADD CONSTRAINT publication_change_facts_pkey PRIMARY KEY (id);


--
-- Name: publication_generations publication_generations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_generations
    ADD CONSTRAINT publication_generations_pkey PRIMARY KEY (id);


--
-- Name: publication_impact_causes publication_impact_causes_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impact_causes
    ADD CONSTRAINT publication_impact_causes_pkey PRIMARY KEY (impact_id, change_fact_id);


--
-- Name: publication_impacts publication_impacts_generation_id_projection_kind_projectio_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impacts
    ADD CONSTRAINT publication_impacts_generation_id_projection_kind_projectio_key UNIQUE (generation_id, projection_kind, projection_key, record_identity);


--
-- Name: publication_impacts publication_impacts_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impacts
    ADD CONSTRAINT publication_impacts_pkey PRIMARY KEY (id);


--
-- Name: publication_projection_inputs publication_projection_inputs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_projection_inputs
    ADD CONSTRAINT publication_projection_inputs_pkey PRIMARY KEY (generation_id, input_key);


--
-- Name: publication_progress publication_progress_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_progress
    ADD CONSTRAINT publication_progress_pkey PRIMARY KEY (knowledge_base_id, generation_id);


--
-- Name: resource_operation_targets resource_operation_targets_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_operation_targets
    ADD CONSTRAINT resource_operation_targets_pkey PRIMARY KEY (operation_id, target_kind, target_id);


--
-- Name: resource_operations resource_operations_knowledge_base_id_idempotency_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_operations
    ADD CONSTRAINT resource_operations_knowledge_base_id_idempotency_key_key UNIQUE (knowledge_base_id, idempotency_key);


--
-- Name: resource_operations resource_operations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_operations
    ADD CONSTRAINT resource_operations_pkey PRIMARY KEY (id);


--
-- Name: resource_path_reservations resource_path_reservations_operation_id_resource_kind_targe_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_path_reservations
    ADD CONSTRAINT resource_path_reservations_operation_id_resource_kind_targe_key UNIQUE (operation_id, resource_kind, target_id);


--
-- Name: resource_path_reservations resource_path_reservations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_path_reservations
    ADD CONSTRAINT resource_path_reservations_pkey PRIMARY KEY (knowledge_base_id, resource_kind, path_key);


--
-- Name: role_heartbeats role_heartbeats_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.role_heartbeats
    ADD CONSTRAINT role_heartbeats_pkey PRIMARY KEY (worker_id);


--
-- Name: role_jobs role_jobs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.role_jobs
    ADD CONSTRAINT role_jobs_pkey PRIMARY KEY (id);


--
-- Name: runtime_generation runtime_generation_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_pkey PRIMARY KEY (singleton);


--
-- Name: runtime_setting_audit_logs runtime_setting_audit_logs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.runtime_setting_audit_logs
    ADD CONSTRAINT runtime_setting_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: runtime_settings runtime_settings_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.runtime_settings
    ADD CONSTRAINT runtime_settings_pkey PRIMARY KEY (key);


--
-- Name: source_directories source_directories_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_pkey PRIMARY KEY (id);


--
-- Name: source_dispatch_markers source_dispatch_markers_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_dispatch_markers
    ADD CONSTRAINT source_dispatch_markers_pkey PRIMARY KEY (id);


--
-- Name: source_dispatch_markers source_dispatch_markers_source_revision_id_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_dispatch_markers
    ADD CONSTRAINT source_dispatch_markers_source_revision_id_key UNIQUE (source_revision_id);


--
-- Name: source_file_events source_file_events_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_events
    ADD CONSTRAINT source_file_events_pkey PRIMARY KEY (id);


--
-- Name: source_file_graph_edges source_file_graph_edges_knowledge_base_id_from_source_file__key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_edges
    ADD CONSTRAINT source_file_graph_edges_knowledge_base_id_from_source_file__key UNIQUE (knowledge_base_id, from_source_file_id, to_source_file_id, relation_type);


--
-- Name: source_file_graph_edges source_file_graph_edges_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_edges
    ADD CONSTRAINT source_file_graph_edges_pkey PRIMARY KEY (id);


--
-- Name: source_file_graph_jobs source_file_graph_jobs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_jobs
    ADD CONSTRAINT source_file_graph_jobs_pkey PRIMARY KEY (id);


--
-- Name: source_file_graph_nodes source_file_graph_nodes_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_nodes
    ADD CONSTRAINT source_file_graph_nodes_pkey PRIMARY KEY (knowledge_base_id, source_file_id);


--
-- Name: source_file_retry_attempts source_file_retry_attempts_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_retry_attempts
    ADD CONSTRAINT source_file_retry_attempts_pkey PRIMARY KEY (id);


--
-- Name: source_files source_files_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_pkey PRIMARY KEY (id);


--
-- Name: source_path_reservations source_path_reservations_entry_id_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_path_reservations
    ADD CONSTRAINT source_path_reservations_entry_id_key UNIQUE (entry_id);


--
-- Name: source_path_reservations source_path_reservations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_path_reservations
    ADD CONSTRAINT source_path_reservations_pkey PRIMARY KEY (knowledge_base_id, path_key);


--
-- Name: source_revisions source_revisions_object_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_object_key_key UNIQUE (object_key);


--
-- Name: source_revisions source_revisions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_pkey PRIMARY KEY (id);


--
-- Name: source_revisions source_revisions_source_file_id_revision_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_source_file_id_revision_key UNIQUE (source_file_id, revision);


--
-- Name: upload_session_entries upload_session_entries_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_session_entries
    ADD CONSTRAINT upload_session_entries_pkey PRIMARY KEY (id);


--
-- Name: upload_session_entries upload_session_entries_session_id_path_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_session_entries
    ADD CONSTRAINT upload_session_entries_session_id_path_key_key UNIQUE (session_id, path_key);


--
-- Name: upload_session_entries upload_session_entries_session_id_sequence_number_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_session_entries
    ADD CONSTRAINT upload_session_entries_session_id_sequence_number_key UNIQUE (session_id, sequence_number);


--
-- Name: upload_sessions upload_sessions_knowledge_base_id_idempotency_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_sessions
    ADD CONSTRAINT upload_sessions_knowledge_base_id_idempotency_key_key UNIQUE (knowledge_base_id, idempotency_key);


--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhook_subscriptions webhook_subscriptions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: active_object_refs_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX active_object_refs_file_idx ON focowiki.active_object_refs USING btree (knowledge_base_id, file_id);


--
-- Name: active_object_refs_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX active_object_refs_path_idx ON focowiki.active_object_refs USING btree (knowledge_base_id, logical_path) WHERE (logical_path IS NOT NULL);


--
-- Name: active_object_refs_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX active_object_refs_source_idx ON focowiki.active_object_refs USING btree (knowledge_base_id, source_file_id, ref_key) WHERE (source_file_id IS NOT NULL);


--
-- Name: active_projection_records_graph_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX active_projection_records_graph_idx ON focowiki.active_projection_records USING btree (knowledge_base_id, source_file_id, related_source_file_id, record_id) WHERE (projection_kind = ANY (ARRAY['graph_edge'::text, 'related_files'::text]));

CREATE INDEX active_projection_records_graph_search_fts_idx ON focowiki.active_projection_records USING gin (to_tsvector('simple'::regconfig, COALESCE(searchable_text, ''::text))) WHERE (projection_kind = ANY (ARRAY['graph_node'::text, 'graph_edge'::text]));

CREATE INDEX active_projection_records_graph_search_trgm_idx ON focowiki.active_projection_records USING gin (lower(COALESCE(searchable_text, ''::text)) focowiki.gin_trgm_ops) WHERE (projection_kind = ANY (ARRAY['graph_node'::text, 'graph_edge'::text]));


--
-- Name: active_projection_records_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX active_projection_records_path_idx ON focowiki.active_projection_records USING btree (knowledge_base_id, projection_kind, logical_path, record_id) WHERE (logical_path IS NOT NULL);


--
-- Name: active_projection_records_search_fts_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX active_projection_records_search_fts_idx ON focowiki.active_projection_records USING gin (to_tsvector('simple'::regconfig, COALESCE(searchable_text, ''::text))) WHERE (projection_kind = 'search'::text);


--
-- Name: active_projection_records_search_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX active_projection_records_search_trgm_idx ON focowiki.active_projection_records USING gin (lower(COALESCE(searchable_text, ''::text)) focowiki.gin_trgm_ops) WHERE (projection_kind = 'search'::text);


--
-- Name: active_projection_records_tree_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX active_projection_records_tree_idx ON focowiki.active_projection_records USING btree (knowledge_base_id, parent_path, sort_key, record_id) WHERE (projection_kind = 'tree'::text);

CREATE INDEX active_projection_records_tree_search_trgm_idx ON focowiki.active_projection_records USING gin (lower(COALESCE(title, ''::text) || ' '::text || COALESCE(logical_path, ''::text)) focowiki.gin_trgm_ops) WHERE (projection_kind = 'tree'::text);


--
-- Name: admin_audit_events_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX admin_audit_events_created_idx ON focowiki.admin_audit_events USING btree (created_at DESC, id);


--
-- Name: admin_audit_events_type_result_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX admin_audit_events_type_result_idx ON focowiki.admin_audit_events USING btree (event_type, result, created_at DESC);


--
-- Name: cleanup_checkpoints_scope_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX cleanup_checkpoints_scope_idx ON focowiki.cleanup_checkpoints USING btree (knowledge_base_id, phase, updated_at, job_id);


--
-- Name: cleanup_object_deletions_pending_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX cleanup_object_deletions_pending_idx ON focowiki.cleanup_object_deletions USING btree (job_id, status, object_key);


--
-- Name: deletion_intents_owner_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX deletion_intents_owner_idx ON focowiki.deletion_intents USING btree (knowledge_base_id, target_kind, target_id, state);


--
-- Name: deletion_intents_work_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX deletion_intents_work_idx ON focowiki.deletion_intents USING btree (state, updated_at, id);


--
-- Name: directory_navigation_leaves_entries_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX directory_navigation_leaves_entries_idx ON focowiki.directory_navigation_leaves USING gin (entries_json jsonb_path_ops);


--
-- Name: directory_navigation_leaves_order_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX directory_navigation_leaves_order_idx ON focowiki.directory_navigation_leaves USING btree (knowledge_base_id, directory_path, first_sort_key, id);


--
-- Name: generation_object_refs_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generation_object_refs_file_idx ON focowiki.generation_object_refs USING btree (knowledge_base_id, generation_id, file_id) WHERE (file_id IS NOT NULL);


--
-- Name: generation_object_refs_object_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generation_object_refs_object_idx ON focowiki.generation_object_refs USING btree (checksum_sha256, format_version, generation_id);


--
-- Name: generation_object_refs_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generation_object_refs_path_idx ON focowiki.generation_object_refs USING btree (knowledge_base_id, generation_id, logical_path, ref_key) WHERE (logical_path IS NOT NULL);


--
-- Name: generation_object_refs_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generation_object_refs_source_idx ON focowiki.generation_object_refs USING btree (knowledge_base_id, generation_id, source_file_id) WHERE (source_file_id IS NOT NULL);


--
-- Name: generation_projection_records_shard_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generation_projection_records_shard_idx ON focowiki.generation_projection_records USING btree (knowledge_base_id, generation_id, projection_kind, shard_key, record_id);


--
-- Name: immutable_objects_gc_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX immutable_objects_gc_idx ON focowiki.immutable_objects USING btree (lifecycle_state, created_at, checksum_sha256, format_version);


--
-- Name: immutable_objects_key_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX immutable_objects_key_idx ON focowiki.immutable_objects USING btree (object_key);


--
-- Name: knowledge_bases_list_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_bases_list_cursor_idx ON focowiki.knowledge_bases USING btree (deleted_at, created_at DESC, id);


--
-- Name: knowledge_bases_metadata_search_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_bases_metadata_search_trgm_idx ON focowiki.knowledge_bases USING gin (lower(((((id || ' '::text) || name) || ' '::text) || COALESCE(description, ''::text))) focowiki.gin_trgm_ops) WHERE (deleted_at IS NULL);


--
-- Name: knowledge_bases_name_active_unique; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX knowledge_bases_name_active_unique ON focowiki.knowledge_bases USING btree (lower(name)) WHERE (deleted_at IS NULL);


--
-- Name: model_configs_one_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX model_configs_one_active_idx ON focowiki.model_configs USING btree (is_active) WHERE ((is_active = true) AND (status = 'active'::text) AND (deleted_at IS NULL));


--
-- Name: model_configs_status_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX model_configs_status_created_idx ON focowiki.model_configs USING btree (status, created_at DESC);


--
-- Name: model_invocations_model_config_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX model_invocations_model_config_created_idx ON focowiki.model_invocations USING btree (model_config_id, created_at DESC);


--
-- Name: model_invocations_source_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX model_invocations_source_created_idx ON focowiki.model_invocations USING btree (source_file_id, created_at DESC, id);


--
-- Name: projection_shards_lookup_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX projection_shards_lookup_idx ON focowiki.projection_shards USING btree (knowledge_base_id, projection_kind, shard_key, created_at DESC, id);


--
-- Name: public_api_keys_active_hash_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX public_api_keys_active_hash_idx ON focowiki.public_api_keys USING btree (key_hash) WHERE (status = 'active'::text);


--
-- Name: public_api_keys_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX public_api_keys_created_cursor_idx ON focowiki.public_api_keys USING btree (created_at DESC, id);


--
-- Name: public_api_keys_status_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX public_api_keys_status_created_cursor_idx ON focowiki.public_api_keys USING btree (status, created_at DESC, id);


--
-- Name: publication_change_facts_deletion_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_change_facts_deletion_idx ON focowiki.publication_change_facts USING btree (knowledge_base_id, deletion_intent_id, id) WHERE (deletion_intent_id IS NOT NULL);


--
-- Name: publication_change_facts_operation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_change_facts_operation_idx ON focowiki.publication_change_facts USING btree (knowledge_base_id, operation_id, id) WHERE (operation_id IS NOT NULL);


--
-- Name: publication_change_facts_source_revision_kind_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX publication_change_facts_source_revision_kind_idx ON focowiki.publication_change_facts USING btree (knowledge_base_id, COALESCE(source_revision_id, '-'::text), kind, COALESCE(previous_path, '-'::text), COALESCE(path, '-'::text));


--
-- Name: publication_change_facts_unassigned_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_change_facts_unassigned_idx ON focowiki.publication_change_facts USING btree (knowledge_base_id, created_at, id) WHERE (generation_id IS NULL);


--
-- Name: publication_generations_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_generations_claim_idx ON focowiki.publication_generations USING btree (state, created_at, id);


--
-- Name: publication_generations_one_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX publication_generations_one_active_idx ON focowiki.publication_generations USING btree (knowledge_base_id) WHERE (state = 'active'::text);


--
-- Name: publication_generations_one_frozen_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX publication_generations_one_frozen_idx ON focowiki.publication_generations USING btree (knowledge_base_id) WHERE (state = ANY (ARRAY['frozen'::text, 'building'::text, 'validating'::text]));


--
-- Name: publication_generations_one_open_successor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX publication_generations_one_open_successor_idx ON focowiki.publication_generations USING btree (knowledge_base_id) WHERE (state = 'open'::text);


--
-- Name: publication_impact_causes_fact_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_impact_causes_fact_idx ON focowiki.publication_impact_causes USING btree (change_fact_id, impact_id);


--
-- Name: publication_impacts_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_impacts_claim_idx ON focowiki.publication_impacts USING btree (generation_id, status, run_after, created_at, id);


--
-- Name: publication_impacts_dirty_shard_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_impacts_dirty_shard_idx ON focowiki.publication_impacts USING btree (knowledge_base_id, projection_kind, projection_key, status, id);


--
-- Name: publication_progress_summary_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_progress_summary_idx ON focowiki.publication_progress USING btree (knowledge_base_id, updated_at DESC, generation_id);


--
-- Name: resource_operation_targets_target_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX resource_operation_targets_target_idx ON focowiki.resource_operation_targets USING btree (target_kind, target_id, operation_id);


--
-- Name: resource_operations_fingerprint_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX resource_operations_fingerprint_idx ON focowiki.resource_operations USING btree (knowledge_base_id, request_fingerprint, created_at DESC);


--
-- Name: resource_operations_status_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX resource_operations_status_idx ON focowiki.resource_operations USING btree (knowledge_base_id, state, created_at DESC, id DESC);


--
-- Name: resource_path_reservations_operation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX resource_path_reservations_operation_idx ON focowiki.resource_path_reservations USING btree (operation_id, resource_kind, target_id);


--
-- Name: role_heartbeats_seen_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX role_heartbeats_seen_idx ON focowiki.role_heartbeats USING btree (role, last_seen_at DESC, worker_id);


--
-- Name: role_jobs_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX role_jobs_claim_idx ON focowiki.role_jobs USING btree (role, status, run_after, created_at, id);


--
-- Name: role_jobs_publication_generation_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX role_jobs_publication_generation_active_idx ON focowiki.role_jobs USING btree (knowledge_base_id) WHERE ((role = 'publication'::text) AND (status = 'running'::text));


--
-- Name: role_jobs_publication_generation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX role_jobs_publication_generation_idx ON focowiki.role_jobs USING btree (generation_id) WHERE ((role = 'publication'::text) AND (generation_id IS NOT NULL));


--
-- Name: role_jobs_source_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX role_jobs_source_revision_idx ON focowiki.role_jobs USING btree (source_revision_id) WHERE ((role = 'source'::text) AND (source_revision_id IS NOT NULL));


--
-- Name: runtime_setting_audit_logs_setting_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX runtime_setting_audit_logs_setting_created_idx ON focowiki.runtime_setting_audit_logs USING btree (setting_key, created_at DESC);


--
-- Name: source_directories_active_path_key_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX source_directories_active_path_key_idx ON focowiki.source_directories USING btree (knowledge_base_id, path_key) WHERE (deleted_at IS NULL);


--
-- Name: source_directories_parent_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_directories_parent_cursor_idx ON focowiki.source_directories USING btree (knowledge_base_id, parent_id, name, id) WHERE (deleted_at IS NULL);


--
-- Name: source_directories_path_prefix_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_directories_path_prefix_idx ON focowiki.source_directories USING btree (knowledge_base_id, path_key COLLATE "C", id);


--
-- Name: source_dispatch_markers_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_dispatch_markers_claim_idx ON focowiki.source_dispatch_markers USING btree (status, run_after, sequence_number, id);


--
-- Name: source_dispatch_markers_kb_pressure_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_dispatch_markers_kb_pressure_idx ON focowiki.source_dispatch_markers USING btree (knowledge_base_id, status, created_at, id);


--
-- Name: source_file_events_file_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_events_file_created_cursor_idx ON focowiki.source_file_events USING btree (knowledge_base_id, source_file_id, created_at, id);


--
-- Name: source_file_graph_edges_from_weight_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_edges_from_weight_idx ON focowiki.source_file_graph_edges USING btree (knowledge_base_id, from_source_file_id, weight DESC, to_source_file_id) WHERE (status = 'accepted'::text);


--
-- Name: source_file_graph_edges_relation_weight_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_edges_relation_weight_idx ON focowiki.source_file_graph_edges USING btree (knowledge_base_id, relation_type, weight DESC, id) WHERE (status = 'accepted'::text);


--
-- Name: source_file_graph_edges_to_weight_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_edges_to_weight_idx ON focowiki.source_file_graph_edges USING btree (knowledge_base_id, to_source_file_id, weight DESC, from_source_file_id) WHERE (status = 'accepted'::text);


--
-- Name: source_file_graph_jobs_source_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_jobs_source_created_idx ON focowiki.source_file_graph_jobs USING btree (knowledge_base_id, source_file_id, created_at DESC, id);


--
-- Name: source_file_graph_nodes_entities_gin_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_nodes_entities_gin_idx ON focowiki.source_file_graph_nodes USING gin (entities_json);


--
-- Name: source_file_graph_nodes_explicit_references_gin_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_nodes_explicit_references_gin_idx ON focowiki.source_file_graph_nodes USING gin (explicit_references_json);


--
-- Name: source_file_graph_nodes_kb_path_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_nodes_kb_path_cursor_idx ON focowiki.source_file_graph_nodes USING btree (knowledge_base_id, path, source_file_id);


--
-- Name: source_file_graph_nodes_keywords_gin_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_nodes_keywords_gin_idx ON focowiki.source_file_graph_nodes USING gin (keywords_json);


--
-- Name: source_file_graph_nodes_profile_version_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_nodes_profile_version_idx ON focowiki.source_file_graph_nodes USING btree (knowledge_base_id, profile_version, source_file_id);


--
-- Name: source_file_graph_nodes_subjects_gin_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_nodes_subjects_gin_idx ON focowiki.source_file_graph_nodes USING gin (subjects_json);


--
-- Name: source_file_graph_nodes_tags_gin_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_graph_nodes_tags_gin_idx ON focowiki.source_file_graph_nodes USING gin (tags_json);


--
-- Name: source_file_retry_attempts_file_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_retry_attempts_file_created_cursor_idx ON focowiki.source_file_retry_attempts USING btree (knowledge_base_id, source_file_id, created_at DESC, id);


--
-- Name: source_files_active_path_key_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX source_files_active_path_key_idx ON focowiki.source_files USING btree (knowledge_base_id, path_key) WHERE ((deleted_at IS NULL) AND (path_key IS NOT NULL));


--
-- Name: source_files_active_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_active_revision_idx ON focowiki.source_files USING btree (active_revision_id);


--
-- Name: source_files_candidate_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_candidate_revision_idx ON focowiki.source_files USING btree (candidate_revision_id) WHERE (candidate_revision_id IS NOT NULL);


--
-- Name: source_files_directory_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_directory_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, directory_id, relative_path, id) WHERE (deleted_at IS NULL);


--
-- Name: source_files_kb_active_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_active_created_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, deleted_at, created_at DESC, id);


--
-- Name: source_files_kb_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_created_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id);


--
-- Name: source_files_kb_ended_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_ended_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_ended_at DESC, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (processing_ended_at IS NOT NULL));


--
-- Name: source_files_kb_error_state_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_error_state_created_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (terminal_failure_code IS NOT NULL));


--
-- Name: source_files_kb_generated_output_status_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_generated_output_status_idx ON focowiki.source_files USING btree (knowledge_base_id, generated_output_status, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL));


--
-- Name: source_files_kb_model_invocation_status_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_model_invocation_status_idx ON focowiki.source_files USING btree (knowledge_base_id, model_invocation_status, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL));


--
-- Name: source_files_kb_no_error_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_no_error_created_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (terminal_failure_code IS NULL));


--
-- Name: source_files_kb_openable_action_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_openable_action_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (generated_output_status = 'visible'::text));


--
-- Name: source_files_kb_processing_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_processing_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_status, processing_stage, created_at DESC, id);



--
-- Name: source_files_kb_retryable_action_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_retryable_action_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (terminal_failure_retry_kind = ANY (ARRAY['source_processing'::text, 'publication'::text])));


--
-- Name: source_files_kb_started_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_started_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_started_at DESC, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (processing_started_at IS NOT NULL));


--
-- Name: source_files_kb_task_visible_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_task_visible_created_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL));


--
-- Name: source_files_kb_task_visible_processing_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_task_visible_processing_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_status, processing_stage, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL));


--
-- Name: source_files_kb_terminal_failure_code_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_terminal_failure_code_idx ON focowiki.source_files USING btree (knowledge_base_id, terminal_failure_code, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (terminal_failure_code IS NOT NULL));


--
-- Name: source_files_kb_terminal_failure_retry_kind_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_terminal_failure_retry_kind_idx ON focowiki.source_files USING btree (knowledge_base_id, terminal_failure_retry_kind, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (terminal_failure_retry_kind IS NOT NULL));


--
-- Name: source_files_kb_terminal_failure_stage_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_terminal_failure_stage_idx ON focowiki.source_files USING btree (knowledge_base_id, terminal_failure_stage, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (terminal_failure_stage IS NOT NULL));


--
-- Name: source_files_object_key_unique; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX source_files_object_key_unique ON focowiki.source_files USING btree (object_key);


--
-- Name: source_files_path_prefix_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_path_prefix_idx ON focowiki.source_files USING btree (knowledge_base_id, path_key COLLATE "C", id);


--
-- Name: source_files_relative_path_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_relative_path_trgm_idx ON focowiki.source_files USING gin (relative_path focowiki.gin_trgm_ops) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL));


--
-- Name: source_files_resource_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_resource_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, id) WHERE ((deleted_at IS NULL) AND (deletion_intent_id IS NULL));


--
-- Name: source_files_resource_id_prefix_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_resource_id_prefix_idx ON focowiki.source_files USING btree (knowledge_base_id, id text_pattern_ops) WHERE ((deleted_at IS NULL) AND (deletion_intent_id IS NULL));


--
-- Name: source_files_resource_processing_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_resource_processing_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_status, processing_stage, generated_output_status, id) WHERE ((deleted_at IS NULL) AND (deletion_intent_id IS NULL));


--
-- Name: source_files_resource_relative_path_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_resource_relative_path_trgm_idx ON focowiki.source_files USING gin (relative_path focowiki.gin_trgm_ops) WHERE ((deleted_at IS NULL) AND (deletion_intent_id IS NULL));


--
-- Name: source_path_reservations_expiry_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_path_reservations_expiry_idx ON focowiki.source_path_reservations USING btree (expires_at, session_id);


--
-- Name: source_revisions_file_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_revisions_file_revision_idx ON focowiki.source_revisions USING btree (knowledge_base_id, source_file_id, revision DESC);


--
-- Name: upload_session_entries_disposition_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_session_entries_disposition_idx ON focowiki.upload_session_entries USING btree (session_id, disposition, sequence_number, id);


--
-- Name: upload_session_entries_finalization_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_session_entries_finalization_idx ON focowiki.upload_session_entries USING btree (session_id, sequence_number, id) WHERE ((disposition = 'upload_required'::text) AND (transfer_state = 'uploaded'::text) AND (finalized_at IS NULL));


--
-- Name: upload_session_entries_path_disposition_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_session_entries_path_disposition_idx ON focowiki.upload_session_entries USING btree (knowledge_base_id, path_key COLLATE "C", disposition, id);


--
-- Name: upload_session_entries_resume_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_session_entries_resume_idx ON focowiki.upload_session_entries USING btree (session_id, transfer_state, sequence_number, id);


--
-- Name: upload_sessions_kb_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_sessions_kb_created_cursor_idx ON focowiki.upload_sessions USING btree (knowledge_base_id, created_at DESC, id DESC);


--
-- Name: upload_sessions_state_expiry_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_sessions_state_expiry_idx ON focowiki.upload_sessions USING btree (state, expires_at, id);


--
-- Name: webhook_deliveries_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_deliveries_created_cursor_idx ON focowiki.webhook_deliveries USING btree (created_at DESC, id);


--
-- Name: webhook_deliveries_webhook_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_deliveries_webhook_created_idx ON focowiki.webhook_deliveries USING btree (webhook_id, created_at DESC, id);


--
-- Name: webhook_subscriptions_enabled_created_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_subscriptions_enabled_created_cursor_idx ON focowiki.webhook_subscriptions USING btree (enabled, created_at DESC, id);


--
-- Name: active_object_refs active_object_refs_checksum_sha256_format_version_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.active_object_refs
    ADD CONSTRAINT active_object_refs_checksum_sha256_format_version_fkey FOREIGN KEY (checksum_sha256, format_version) REFERENCES focowiki.immutable_objects(checksum_sha256, format_version) ON DELETE RESTRICT;


--
-- Name: active_object_refs active_object_refs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.active_object_refs
    ADD CONSTRAINT active_object_refs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: active_projection_records active_projection_records_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.active_projection_records
    ADD CONSTRAINT active_projection_records_generation_id_fkey FOREIGN KEY (last_changed_generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE RESTRICT;


--
-- Name: active_projection_records active_projection_records_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.active_projection_records
    ADD CONSTRAINT active_projection_records_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: deletion_intents deletion_intents_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.deletion_intents
    ADD CONSTRAINT deletion_intents_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: directory_navigation_leaves directory_navigation_leaves_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.directory_navigation_leaves
    ADD CONSTRAINT directory_navigation_leaves_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: directory_navigation_summaries directory_navigation_summaries_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.directory_navigation_summaries
    ADD CONSTRAINT directory_navigation_summaries_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: generation_object_refs generation_object_refs_checksum_sha256_format_version_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_object_refs
    ADD CONSTRAINT generation_object_refs_checksum_sha256_format_version_fkey FOREIGN KEY (checksum_sha256, format_version) REFERENCES focowiki.immutable_objects(checksum_sha256, format_version) ON DELETE RESTRICT;


--
-- Name: generation_object_refs generation_object_refs_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_object_refs
    ADD CONSTRAINT generation_object_refs_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE;


--
-- Name: generation_object_refs generation_object_refs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_object_refs
    ADD CONSTRAINT generation_object_refs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: generation_object_refs generation_object_refs_projection_shard_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_object_refs
    ADD CONSTRAINT generation_object_refs_projection_shard_id_fkey FOREIGN KEY (projection_shard_id) REFERENCES focowiki.projection_shards(id) ON DELETE RESTRICT;


--
-- Name: generation_projection_records generation_projection_records_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_projection_records
    ADD CONSTRAINT generation_projection_records_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE;


--
-- Name: generation_projection_records generation_projection_records_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generation_projection_records
    ADD CONSTRAINT generation_projection_records_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: model_invocations model_invocations_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_invocations
    ADD CONSTRAINT model_invocations_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: model_invocations model_invocations_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_invocations
    ADD CONSTRAINT model_invocations_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: projection_shards projection_shards_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.projection_shards
    ADD CONSTRAINT projection_shards_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: publication_change_facts publication_change_facts_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_change_facts
    ADD CONSTRAINT publication_change_facts_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE SET NULL;


--
-- Name: publication_change_facts publication_change_facts_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_change_facts
    ADD CONSTRAINT publication_change_facts_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: publication_generations publication_generations_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_generations
    ADD CONSTRAINT publication_generations_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: publication_impact_causes publication_impact_causes_change_fact_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impact_causes
    ADD CONSTRAINT publication_impact_causes_change_fact_id_fkey FOREIGN KEY (change_fact_id) REFERENCES focowiki.publication_change_facts(id) ON DELETE CASCADE;


--
-- Name: publication_impact_causes publication_impact_causes_impact_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impact_causes
    ADD CONSTRAINT publication_impact_causes_impact_id_fkey FOREIGN KEY (impact_id) REFERENCES focowiki.publication_impacts(id) ON DELETE CASCADE;


--
-- Name: publication_impacts publication_impacts_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impacts
    ADD CONSTRAINT publication_impacts_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE;


--
-- Name: publication_impacts publication_impacts_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impacts
    ADD CONSTRAINT publication_impacts_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: publication_impacts publication_impacts_projection_input_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_impacts
    ADD CONSTRAINT publication_impacts_projection_input_fkey FOREIGN KEY (generation_id, projection_input_key) REFERENCES focowiki.publication_projection_inputs(generation_id, input_key) ON DELETE CASCADE;


--
-- Name: publication_projection_inputs publication_projection_inputs_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_projection_inputs
    ADD CONSTRAINT publication_projection_inputs_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE;


--
-- Name: publication_projection_inputs publication_projection_inputs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_projection_inputs
    ADD CONSTRAINT publication_projection_inputs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: publication_progress publication_progress_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_progress
    ADD CONSTRAINT publication_progress_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE;


--
-- Name: publication_progress publication_progress_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_progress
    ADD CONSTRAINT publication_progress_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: resource_operation_targets resource_operation_targets_operation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_operation_targets
    ADD CONSTRAINT resource_operation_targets_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES focowiki.resource_operations(id) ON DELETE CASCADE;


--
-- Name: resource_operations resource_operations_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_operations
    ADD CONSTRAINT resource_operations_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: resource_path_reservations resource_path_reservations_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_path_reservations
    ADD CONSTRAINT resource_path_reservations_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: resource_path_reservations resource_path_reservations_operation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.resource_path_reservations
    ADD CONSTRAINT resource_path_reservations_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES focowiki.resource_operations(id) ON DELETE CASCADE;


--
-- Name: role_jobs role_jobs_generation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.role_jobs
    ADD CONSTRAINT role_jobs_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE;


--
-- Name: role_jobs role_jobs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.role_jobs
    ADD CONSTRAINT role_jobs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: role_jobs role_jobs_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.role_jobs
    ADD CONSTRAINT role_jobs_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id) ON DELETE CASCADE;


--
-- Name: role_jobs role_jobs_source_revision_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.role_jobs
    ADD CONSTRAINT role_jobs_source_revision_id_fkey FOREIGN KEY (source_revision_id) REFERENCES focowiki.source_revisions(id) ON DELETE CASCADE;


--
-- Name: source_directories source_directories_candidate_operation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_candidate_operation_id_fkey FOREIGN KEY (candidate_operation_id) REFERENCES focowiki.resource_operations(id);


--
-- Name: source_directories source_directories_candidate_parent_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_candidate_parent_id_fkey FOREIGN KEY (candidate_parent_id) REFERENCES focowiki.source_directories(id);


--
-- Name: source_directories source_directories_deletion_intent_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_deletion_intent_id_fkey FOREIGN KEY (deletion_intent_id) REFERENCES focowiki.deletion_intents(id);


--
-- Name: source_directories source_directories_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_directories source_directories_parent_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES focowiki.source_directories(id) ON DELETE CASCADE;


--
-- Name: source_dispatch_markers source_dispatch_markers_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_dispatch_markers
    ADD CONSTRAINT source_dispatch_markers_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_dispatch_markers source_dispatch_markers_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_dispatch_markers
    ADD CONSTRAINT source_dispatch_markers_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id) ON DELETE CASCADE;


--
-- Name: source_dispatch_markers source_dispatch_markers_source_revision_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_dispatch_markers
    ADD CONSTRAINT source_dispatch_markers_source_revision_id_fkey FOREIGN KEY (source_revision_id) REFERENCES focowiki.source_revisions(id) ON DELETE CASCADE;


--
-- Name: source_file_events source_file_events_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_events
    ADD CONSTRAINT source_file_events_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_file_events source_file_events_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_events
    ADD CONSTRAINT source_file_events_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_graph_edges source_file_graph_edges_from_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_edges
    ADD CONSTRAINT source_file_graph_edges_from_source_file_id_fkey FOREIGN KEY (from_source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_graph_edges source_file_graph_edges_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_edges
    ADD CONSTRAINT source_file_graph_edges_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_file_graph_edges source_file_graph_edges_to_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_edges
    ADD CONSTRAINT source_file_graph_edges_to_source_file_id_fkey FOREIGN KEY (to_source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_graph_jobs source_file_graph_jobs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_jobs
    ADD CONSTRAINT source_file_graph_jobs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_file_graph_jobs source_file_graph_jobs_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_jobs
    ADD CONSTRAINT source_file_graph_jobs_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_graph_nodes source_file_graph_nodes_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_nodes
    ADD CONSTRAINT source_file_graph_nodes_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_file_graph_nodes source_file_graph_nodes_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_nodes
    ADD CONSTRAINT source_file_graph_nodes_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_retry_attempts source_file_retry_attempts_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_retry_attempts
    ADD CONSTRAINT source_file_retry_attempts_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_file_retry_attempts source_file_retry_attempts_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_retry_attempts
    ADD CONSTRAINT source_file_retry_attempts_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_files source_files_active_revision_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_active_revision_id_fkey FOREIGN KEY (active_revision_id) REFERENCES focowiki.source_revisions(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: source_files source_files_candidate_directory_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_candidate_directory_id_fkey FOREIGN KEY (candidate_directory_id) REFERENCES focowiki.source_directories(id);


--
-- Name: source_files source_files_candidate_operation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_candidate_operation_id_fkey FOREIGN KEY (candidate_operation_id) REFERENCES focowiki.resource_operations(id);


--
-- Name: source_files source_files_candidate_revision_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_candidate_revision_id_fkey FOREIGN KEY (candidate_revision_id) REFERENCES focowiki.source_revisions(id);


--
-- Name: source_files source_files_deletion_intent_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_deletion_intent_id_fkey FOREIGN KEY (deletion_intent_id) REFERENCES focowiki.deletion_intents(id);


--
-- Name: source_files source_files_directory_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_directory_id_fkey FOREIGN KEY (directory_id) REFERENCES focowiki.source_directories(id);


--
-- Name: source_files source_files_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_path_reservations source_path_reservations_entry_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_path_reservations
    ADD CONSTRAINT source_path_reservations_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES focowiki.upload_session_entries(id) ON DELETE CASCADE;


--
-- Name: source_path_reservations source_path_reservations_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_path_reservations
    ADD CONSTRAINT source_path_reservations_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_path_reservations source_path_reservations_session_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_path_reservations
    ADD CONSTRAINT source_path_reservations_session_id_fkey FOREIGN KEY (session_id) REFERENCES focowiki.upload_sessions(id) ON DELETE CASCADE;


--
-- Name: source_revisions source_revisions_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: source_revisions source_revisions_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id) ON DELETE CASCADE;


--
-- Name: upload_session_entries upload_session_entries_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_session_entries
    ADD CONSTRAINT upload_session_entries_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: upload_session_entries upload_session_entries_session_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_session_entries
    ADD CONSTRAINT upload_session_entries_session_id_fkey FOREIGN KEY (session_id) REFERENCES focowiki.upload_sessions(id) ON DELETE CASCADE;


--
-- Name: upload_session_entries upload_session_entries_source_directory_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_session_entries
    ADD CONSTRAINT upload_session_entries_source_directory_id_fkey FOREIGN KEY (source_directory_id) REFERENCES focowiki.source_directories(id) ON DELETE SET NULL;


--
-- Name: upload_sessions upload_sessions_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_sessions
    ADD CONSTRAINT upload_sessions_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_webhook_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES focowiki.webhook_subscriptions(id);


--
-- PostgreSQL database dump complete
--



INSERT INTO focowiki.runtime_generation (singleton, generation)
VALUES (true, 'incremental-sharded-publication-v1');
