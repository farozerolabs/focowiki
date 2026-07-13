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

CREATE EXTENSION pg_trgm WITH SCHEMA focowiki;


--
-- Name: adjust_worker_queue_summary(text, text, text, integer); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.adjust_worker_queue_summary(input_knowledge_base_id text, input_kind text, input_status text, input_delta integer) RETURNS void
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


--
-- Name: sync_worker_queue_summary(); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.sync_worker_queue_summary() RETURNS trigger
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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
-- Name: bundle_files; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.bundle_files (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    release_id text NOT NULL,
    source_file_id text,
    file_kind text NOT NULL,
    logical_path text NOT NULL,
    object_key text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    okf_type text,
    title text,
    description text,
    tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    frontmatter_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    navigation_only boolean DEFAULT false NOT NULL,
    source_directory_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bundle_files_check CHECK ((((file_kind = 'page'::text) AND (source_file_id IS NOT NULL)) OR ((file_kind <> 'page'::text) AND (source_file_id IS NULL)))),
    CONSTRAINT bundle_files_file_kind_check CHECK ((file_kind = ANY (ARRAY['page'::text, 'index'::text, 'log'::text, 'history_page'::text, 'schema'::text, 'directory_index'::text, 'directory_index_page'::text, 'directory_index_map'::text, 'index_catalog'::text, 'manifest_index'::text, 'manifest_index_shard'::text, 'search_index'::text, 'search_index_shard'::text, 'link_index'::text, 'link_index_shard'::text, 'change_index'::text, 'change_index_shard'::text, 'graph_index'::text, 'graph_manifest'::text, 'graph_node_index'::text, 'graph_edge_shard'::text, 'graph_file'::text, 'graph_community'::text, 'graph_insight'::text]))),
    CONSTRAINT bundle_files_size_bytes_check CHECK ((size_bytes >= 0))
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
-- Name: hard_delete_object_deletions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.hard_delete_object_deletions (
    id text NOT NULL,
    job_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text,
    object_key text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_bases; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_bases (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    active_release_id text,
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
-- Name: knowledge_file_tree_nodes; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_file_tree_nodes (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    release_id text NOT NULL,
    parent_id text,
    path text NOT NULL,
    name text NOT NULL,
    node_type text NOT NULL,
    file_id text,
    source_directory_id text,
    depth integer NOT NULL,
    sort_key text NOT NULL,
    child_count integer DEFAULT 0 NOT NULL,
    direct_file_count integer DEFAULT 0 NOT NULL,
    descendant_file_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_file_tree_nodes_check CHECK ((((node_type = 'directory'::text) AND (file_id IS NULL)) OR ((node_type = 'file'::text) AND (file_id IS NOT NULL)))),
    CONSTRAINT knowledge_file_tree_nodes_child_count_check CHECK ((child_count >= 0)),
    CONSTRAINT knowledge_file_tree_nodes_depth_check CHECK ((depth >= 0)),
    CONSTRAINT knowledge_file_tree_nodes_descendant_file_count_check CHECK ((descendant_file_count >= 0)),
    CONSTRAINT knowledge_file_tree_nodes_direct_file_count_check CHECK ((direct_file_count >= 0)),
    CONSTRAINT knowledge_file_tree_nodes_node_type_check CHECK ((node_type = ANY (ARRAY['directory'::text, 'file'::text])))
);


--
-- Name: knowledge_graph_edges; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_graph_edges (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    release_id text NOT NULL,
    from_node_id text NOT NULL,
    to_node_id text NOT NULL,
    from_file_id text NOT NULL,
    to_file_id text NOT NULL,
    relation_type text NOT NULL,
    direction text DEFAULT 'directed'::text NOT NULL,
    confidence numeric NOT NULL,
    weight numeric NOT NULL,
    quality_status text DEFAULT 'accepted'::text NOT NULL,
    reason text NOT NULL,
    evidence_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    signals_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_graph_edges_check CHECK ((from_node_id <> to_node_id)),
    CONSTRAINT knowledge_graph_edges_check1 CHECK ((from_file_id <> to_file_id)),
    CONSTRAINT knowledge_graph_edges_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT knowledge_graph_edges_direction_check CHECK ((direction = ANY (ARRAY['directed'::text, 'bidirectional'::text]))),
    CONSTRAINT knowledge_graph_edges_evidence_json_check CHECK ((jsonb_typeof(evidence_json) = 'array'::text)),
    CONSTRAINT knowledge_graph_edges_quality_status_check CHECK ((quality_status = ANY (ARRAY['accepted'::text, 'rejected'::text, 'needs_review'::text]))),
    CONSTRAINT knowledge_graph_edges_signals_json_check CHECK ((jsonb_typeof(signals_json) = 'object'::text)),
    CONSTRAINT knowledge_graph_edges_weight_check CHECK (((weight >= (0)::numeric) AND (weight <= (1)::numeric)))
);


--
-- Name: knowledge_graph_insights; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_graph_insights (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    release_id text NOT NULL,
    insight_type text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    payload_json jsonb NOT NULL,
    severity text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_graph_insights_payload_json_check CHECK ((jsonb_typeof(payload_json) = 'object'::text)),
    CONSTRAINT knowledge_graph_insights_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text])))
);


--
-- Name: knowledge_graph_nodes; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_graph_nodes (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    release_id text NOT NULL,
    file_id text NOT NULL,
    source_file_id text,
    path text NOT NULL,
    title text,
    summary text,
    subjects_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    entities_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    keywords_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    headings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    explicit_references_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    profile_text text NOT NULL,
    quality_status text DEFAULT 'ready'::text NOT NULL,
    quality_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_graph_nodes_entities_json_check CHECK ((jsonb_typeof(entities_json) = 'array'::text)),
    CONSTRAINT knowledge_graph_nodes_explicit_references_json_check CHECK ((jsonb_typeof(explicit_references_json) = 'array'::text)),
    CONSTRAINT knowledge_graph_nodes_headings_json_check CHECK ((jsonb_typeof(headings_json) = 'array'::text)),
    CONSTRAINT knowledge_graph_nodes_keywords_json_check CHECK ((jsonb_typeof(keywords_json) = 'array'::text)),
    CONSTRAINT knowledge_graph_nodes_metadata_json_check CHECK ((jsonb_typeof(metadata_json) = 'object'::text)),
    CONSTRAINT knowledge_graph_nodes_quality_status_check CHECK ((quality_status = ANY (ARRAY['ready'::text, 'partial'::text, 'failed'::text]))),
    CONSTRAINT knowledge_graph_nodes_subjects_json_check CHECK ((jsonb_typeof(subjects_json) = 'array'::text))
);


--
-- Name: knowledge_graph_search_documents; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_graph_search_documents (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    release_id text NOT NULL,
    node_id text,
    edge_id text,
    file_id text,
    path text,
    anchor_type text NOT NULL,
    title text,
    summary text,
    search_text text NOT NULL,
    matched_field_text text,
    relationship_count integer DEFAULT 0 NOT NULL,
    top_neighbors_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_graph_search_documents_anchor_type_check CHECK ((anchor_type = ANY (ARRAY['file'::text, 'node'::text, 'edge'::text, 'community'::text, 'insight'::text]))),
    CONSTRAINT knowledge_graph_search_documents_relationship_count_check CHECK ((relationship_count >= 0)),
    CONSTRAINT knowledge_graph_search_documents_top_neighbors_json_check CHECK ((jsonb_typeof(top_neighbors_json) = 'array'::text))
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
-- Name: publication_jobs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.publication_jobs (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    mode text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    dirty_source_count integer DEFAULT 0 NOT NULL,
    release_id text,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_jobs_check CHECK (((ended_at IS NULL) OR (started_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT publication_jobs_dirty_source_count_check CHECK ((dirty_source_count >= 0)),
    CONSTRAINT publication_jobs_mode_check CHECK ((mode = ANY (ARRAY['batch'::text, 'manual'::text, 'per_file'::text]))),
    CONSTRAINT publication_jobs_reason_check CHECK ((reason = ANY (ARRAY['bootstrap'::text, 'batch_threshold'::text, 'batch_interval'::text, 'manual'::text, 'per_file'::text, 'metadata'::text, 'deletion'::text]))),
    CONSTRAINT publication_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: releases; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.releases (
    id text NOT NULL,
    knowledge_base_id text NOT NULL,
    bundle_root_key text NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    file_count integer DEFAULT 0 NOT NULL,
    manifest_checksum_sha256 text NOT NULL,
    catalog_generation bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT releases_catalog_generation_check CHECK ((catalog_generation >= 0)),
    CONSTRAINT releases_file_count_check CHECK ((file_count >= 0))
);


--
-- Name: release_markdown_links; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.release_markdown_links (
    release_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text,
    from_path text NOT NULL,
    to_path text NOT NULL,
    label text NOT NULL,
    navigation_only boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT release_markdown_links_from_path_check CHECK ((from_path <> ''::text)),
    CONSTRAINT release_markdown_links_to_path_check CHECK ((to_path <> ''::text)),
    CONSTRAINT release_markdown_links_label_check CHECK ((label <> ''::text))
);


--
-- Name: release_source_directories; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.release_source_directories (
    release_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_directory_id text NOT NULL,
    parent_source_directory_id text,
    name text NOT NULL,
    relative_path text NOT NULL,
    path_key text NOT NULL,
    depth integer NOT NULL,
    resource_revision integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT release_source_directories_depth_check CHECK ((depth >= 1)),
    CONSTRAINT release_source_directories_resource_revision_check CHECK ((resource_revision >= 1))
);


--
-- Name: release_source_files; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.release_source_files (
    release_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    source_revision_id text NOT NULL,
    source_directory_id text,
    name text NOT NULL,
    relative_path text NOT NULL,
    path_key text NOT NULL,
    generated_path text NOT NULL,
    object_key text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_suggestions_json jsonb,
    publication_required boolean DEFAULT false NOT NULL,
    resource_revision integer NOT NULL,
    content_revision integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT release_source_files_content_revision_check CHECK ((content_revision >= 1)),
    CONSTRAINT release_source_files_resource_revision_check CHECK ((resource_revision >= 1)),
    CONSTRAINT release_source_files_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: release_resource_operations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.release_resource_operations (
    release_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_id text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
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
    CONSTRAINT runtime_settings_key_check CHECK ((key = ANY (ARRAY['rate_limits'::text, 'worker'::text, 'publication'::text, 'upload_generation'::text, 'graph'::text]))),
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
    CONSTRAINT source_file_events_stage_key_check CHECK ((stage_key = ANY (ARRAY['upload_storage'::text, 'source_deletion'::text, 'metadata_resolution'::text, 'llm_suggestion'::text, 'graph_generation'::text, 'okf_validation'::text, 'bundle_generation'::text, 'index_publication'::text, 'release_activation'::text])))
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
    processing_error_code text,
    processing_error_message text,
    generated_output_status text DEFAULT 'pending'::text NOT NULL,
    generated_bundle_file_id text,
    generated_bundle_file_path text,
    graph_relationship_count integer DEFAULT 0 NOT NULL,
    graph_top_relationships_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    model_invocation_status text,
    model_invocation_model_name text,
    model_invocation_started_at timestamp with time zone,
    model_invocation_ended_at timestamp with time zone,
    model_invocation_warning_count integer,
    model_invocation_error_code text,
    publication_dirty_at timestamp with time zone,
    publication_visible_at timestamp with time zone,
    publication_error_code text,
    publication_error_message text,
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
    CONSTRAINT source_files_processing_stage_check CHECK ((processing_stage = ANY (ARRAY['upload_storage'::text, 'metadata_resolution'::text, 'llm_suggestion'::text, 'graph_generation'::text, 'okf_validation'::text, 'bundle_generation'::text, 'index_publication'::text, 'release_activation'::text]))),
    CONSTRAINT source_files_processing_status_check CHECK ((processing_status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT source_files_processing_time_check CHECK (((processing_ended_at IS NULL) OR (processing_started_at IS NULL) OR (processing_ended_at >= processing_started_at))),
    CONSTRAINT source_files_retry_count_check CHECK ((retry_count >= 0)),
    CONSTRAINT source_files_size_bytes_check CHECK ((size_bytes >= 0))
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
    checksum_sha256 text NOT NULL,
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
-- Name: worker_heartbeats; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.worker_heartbeats (
    worker_id text NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    active_job_count integer DEFAULT 0 NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_heartbeats_active_job_count_check CHECK ((active_job_count >= 0))
);


--
-- Name: worker_jobs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.worker_jobs (
    id text NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_id text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    locked_by text,
    locked_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    hard_delete_stage text,
    hard_delete_cursor_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    hard_delete_progress_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT worker_jobs_check CHECK (((completed_at IS NULL) OR (started_at IS NULL) OR (completed_at >= started_at))),
    CONSTRAINT worker_jobs_check1 CHECK (((failed_at IS NULL) OR (started_at IS NULL) OR (failed_at >= started_at))),
    CONSTRAINT worker_jobs_kind_check CHECK ((kind = ANY (ARRAY['upload_session_finalization'::text, 'source_file_processing'::text, 'resource_operation'::text, 'publication'::text, 'hard_delete'::text]))),
    CONSTRAINT worker_jobs_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT worker_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'dead_letter'::text, 'cancelled'::text])))
);


--
-- Name: worker_queue_summaries; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.worker_queue_summaries (
    knowledge_base_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    job_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_queue_summaries_job_count_check CHECK ((job_count >= 0)),
    CONSTRAINT worker_queue_summaries_kind_check CHECK ((kind = ANY (ARRAY['upload_session_finalization'::text, 'source_file_processing'::text, 'resource_operation'::text, 'publication'::text, 'hard_delete'::text]))),
    CONSTRAINT worker_queue_summaries_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'dead_letter'::text, 'cancelled'::text])))
);


--
-- Name: admin_audit_events admin_audit_events_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.admin_audit_events
    ADD CONSTRAINT admin_audit_events_pkey PRIMARY KEY (id);


--
-- Name: bundle_files bundle_files_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.bundle_files
    ADD CONSTRAINT bundle_files_pkey PRIMARY KEY (id);


--
-- Name: bundle_files bundle_files_release_id_logical_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.bundle_files
    ADD CONSTRAINT bundle_files_release_id_logical_path_key UNIQUE (release_id, logical_path);


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
-- Name: hard_delete_object_deletions hard_delete_object_deletions_job_id_object_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.hard_delete_object_deletions
    ADD CONSTRAINT hard_delete_object_deletions_job_id_object_key_key UNIQUE (job_id, object_key);


--
-- Name: hard_delete_object_deletions hard_delete_object_deletions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.hard_delete_object_deletions
    ADD CONSTRAINT hard_delete_object_deletions_pkey PRIMARY KEY (id);


--
-- Name: knowledge_bases knowledge_bases_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_bases
    ADD CONSTRAINT knowledge_bases_pkey PRIMARY KEY (id);


--
-- Name: knowledge_file_tree_nodes knowledge_file_tree_nodes_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_file_tree_nodes
    ADD CONSTRAINT knowledge_file_tree_nodes_pkey PRIMARY KEY (id);


--
-- Name: knowledge_file_tree_nodes knowledge_file_tree_nodes_release_id_parent_id_name_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_file_tree_nodes
    ADD CONSTRAINT knowledge_file_tree_nodes_release_id_parent_id_name_key UNIQUE (release_id, parent_id, name);


--
-- Name: knowledge_file_tree_nodes knowledge_file_tree_nodes_release_id_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_file_tree_nodes
    ADD CONSTRAINT knowledge_file_tree_nodes_release_id_path_key UNIQUE (release_id, path);


--
-- Name: knowledge_graph_edges knowledge_graph_edges_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_pkey PRIMARY KEY (id);


--
-- Name: knowledge_graph_edges knowledge_graph_edges_release_id_from_node_id_to_node_id_re_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_release_id_from_node_id_to_node_id_re_key UNIQUE (release_id, from_node_id, to_node_id, relation_type);


--
-- Name: knowledge_graph_insights knowledge_graph_insights_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_insights
    ADD CONSTRAINT knowledge_graph_insights_pkey PRIMARY KEY (id);


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_pkey PRIMARY KEY (id);


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_release_id_file_id_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_release_id_file_id_key UNIQUE (release_id, file_id);


--
-- Name: knowledge_graph_search_documents knowledge_graph_search_documents_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_search_documents
    ADD CONSTRAINT knowledge_graph_search_documents_pkey PRIMARY KEY (id);


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
-- Name: publication_jobs publication_jobs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_jobs
    ADD CONSTRAINT publication_jobs_pkey PRIMARY KEY (id);


--
-- Name: releases releases_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.releases
    ADD CONSTRAINT releases_pkey PRIMARY KEY (id);


--
-- Name: release_markdown_links release_markdown_links_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_markdown_links
    ADD CONSTRAINT release_markdown_links_pkey PRIMARY KEY (release_id, from_path, to_path, label);


--
-- Name: release_source_directories release_source_directories_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_directories
    ADD CONSTRAINT release_source_directories_pkey PRIMARY KEY (release_id, source_directory_id);


--
-- Name: release_source_directories release_source_directories_release_id_path_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_directories
    ADD CONSTRAINT release_source_directories_release_id_path_key_key UNIQUE (release_id, path_key);


--
-- Name: release_source_files release_source_files_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_pkey PRIMARY KEY (release_id, source_file_id);


--
-- Name: release_source_files release_source_files_release_id_path_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_release_id_path_key_key UNIQUE (release_id, path_key);


--
-- Name: release_source_files release_source_files_release_id_generated_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_release_id_generated_path_key UNIQUE (release_id, generated_path);


--
-- Name: release_resource_operations release_resource_operations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_resource_operations
    ADD CONSTRAINT release_resource_operations_pkey PRIMARY KEY (release_id, operation_id);


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
-- Name: worker_heartbeats worker_heartbeats_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.worker_heartbeats
    ADD CONSTRAINT worker_heartbeats_pkey PRIMARY KEY (worker_id);


--
-- Name: worker_jobs worker_jobs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.worker_jobs
    ADD CONSTRAINT worker_jobs_pkey PRIMARY KEY (id);


--
-- Name: worker_queue_summaries worker_queue_summaries_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.worker_queue_summaries
    ADD CONSTRAINT worker_queue_summaries_pkey PRIMARY KEY (knowledge_base_id, kind, status);


--
-- Name: admin_audit_events_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX admin_audit_events_created_idx ON focowiki.admin_audit_events USING btree (created_at DESC, id);


--
-- Name: admin_audit_events_type_result_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX admin_audit_events_type_result_idx ON focowiki.admin_audit_events USING btree (event_type, result, created_at DESC);


--
-- Name: bundle_files_kb_release_logical_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX bundle_files_kb_release_logical_cursor_idx ON focowiki.bundle_files USING btree (knowledge_base_id, release_id, logical_path, id);


--
-- Name: bundle_files_kb_release_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX bundle_files_kb_release_source_idx ON focowiki.bundle_files USING btree (knowledge_base_id, release_id, source_file_id, id);


--
-- Name: bundle_files_object_key_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX bundle_files_object_key_idx ON focowiki.bundle_files USING btree (object_key);


--
-- Name: bundle_files_release_logical_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX bundle_files_release_logical_cursor_idx ON focowiki.bundle_files USING btree (release_id, logical_path, id);


--
-- Name: bundle_files_search_text_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX bundle_files_search_text_trgm_idx ON focowiki.bundle_files USING gin (lower(((((((((logical_path || ' '::text) || COALESCE(title, ''::text)) || ' '::text) || COALESCE(description, ''::text)) || ' '::text) || (frontmatter_json)::text) || ' '::text) || (tags_json)::text)) focowiki.gin_trgm_ops) WHERE (navigation_only = false);


--
-- Name: bundle_files_metadata_search_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX bundle_files_metadata_search_trgm_idx ON focowiki.bundle_files USING gin (lower(((((((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)) || ' '::text) || (frontmatter_json)::text) || ' '::text) || (tags_json)::text)) focowiki.gin_trgm_ops) WHERE (navigation_only = false);


--
-- Name: bundle_files_logical_path_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX bundle_files_logical_path_trgm_idx ON focowiki.bundle_files USING gin (lower(logical_path) focowiki.gin_trgm_ops) WHERE (navigation_only = false);


--
-- Name: deletion_intents_owner_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX deletion_intents_owner_idx ON focowiki.deletion_intents USING btree (knowledge_base_id, target_kind, target_id, state);


--
-- Name: deletion_intents_work_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX deletion_intents_work_idx ON focowiki.deletion_intents USING btree (state, updated_at, id);


--
-- Name: hard_delete_object_deletions_job_pending_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX hard_delete_object_deletions_job_pending_idx ON focowiki.hard_delete_object_deletions USING btree (job_id, created_at, id) WHERE (deleted_at IS NULL);


--
-- Name: hard_delete_object_deletions_kb_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX hard_delete_object_deletions_kb_idx ON focowiki.hard_delete_object_deletions USING btree (knowledge_base_id, job_id, id);


--
-- Name: hard_delete_object_deletions_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX hard_delete_object_deletions_source_idx ON focowiki.hard_delete_object_deletions USING btree (knowledge_base_id, source_file_id, job_id, id) WHERE (source_file_id IS NOT NULL);


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
-- Name: knowledge_file_tree_nodes_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_file_tree_nodes_file_idx ON focowiki.knowledge_file_tree_nodes USING btree (knowledge_base_id, file_id) WHERE (file_id IS NOT NULL);


--
-- Name: knowledge_file_tree_nodes_kb_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_file_tree_nodes_kb_path_idx ON focowiki.knowledge_file_tree_nodes USING btree (knowledge_base_id, path);


--
-- Name: knowledge_file_tree_nodes_name_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_file_tree_nodes_name_trgm_idx ON focowiki.knowledge_file_tree_nodes USING gin (name focowiki.gin_trgm_ops);


--
-- Name: knowledge_file_tree_nodes_parent_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_file_tree_nodes_parent_cursor_idx ON focowiki.knowledge_file_tree_nodes USING btree (knowledge_base_id, parent_id, sort_key, id);


--
-- Name: knowledge_file_tree_nodes_path_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_file_tree_nodes_path_trgm_idx ON focowiki.knowledge_file_tree_nodes USING gin (path focowiki.gin_trgm_ops);


--
-- Name: knowledge_file_tree_nodes_search_text_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_file_tree_nodes_search_text_trgm_idx ON focowiki.knowledge_file_tree_nodes USING gin (lower(((name || ' '::text) || path)) focowiki.gin_trgm_ops);


--
-- Name: knowledge_file_tree_nodes_source_directory_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_file_tree_nodes_source_directory_idx ON focowiki.knowledge_file_tree_nodes USING btree (release_id, source_directory_id) WHERE (source_directory_id IS NOT NULL);


--
-- Name: knowledge_graph_edges_from_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_edges_from_file_idx ON focowiki.knowledge_graph_edges USING btree (knowledge_base_id, from_file_id, weight DESC, to_file_id) WHERE (quality_status = 'accepted'::text);


--
-- Name: knowledge_graph_edges_from_weight_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_edges_from_weight_idx ON focowiki.knowledge_graph_edges USING btree (knowledge_base_id, from_node_id, weight DESC, to_node_id) WHERE (quality_status = 'accepted'::text);


--
-- Name: knowledge_graph_edges_quality_weight_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_edges_quality_weight_idx ON focowiki.knowledge_graph_edges USING btree (knowledge_base_id, quality_status, weight DESC, id);


--
-- Name: knowledge_graph_edges_reason_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_edges_reason_trgm_idx ON focowiki.knowledge_graph_edges USING gin (reason focowiki.gin_trgm_ops);


--
-- Name: knowledge_graph_edges_relation_weight_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_edges_relation_weight_idx ON focowiki.knowledge_graph_edges USING btree (knowledge_base_id, relation_type, weight DESC, id) WHERE (quality_status = 'accepted'::text);


--
-- Name: knowledge_graph_edges_to_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_edges_to_file_idx ON focowiki.knowledge_graph_edges USING btree (knowledge_base_id, to_file_id, weight DESC, from_file_id) WHERE (quality_status = 'accepted'::text);


--
-- Name: knowledge_graph_edges_to_weight_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_edges_to_weight_idx ON focowiki.knowledge_graph_edges USING btree (knowledge_base_id, to_node_id, weight DESC, from_node_id) WHERE (quality_status = 'accepted'::text);


--
-- Name: knowledge_graph_insights_kb_severity_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_insights_kb_severity_created_idx ON focowiki.knowledge_graph_insights USING btree (knowledge_base_id, severity, created_at DESC, id);


--
-- Name: knowledge_graph_insights_kb_type_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_insights_kb_type_created_idx ON focowiki.knowledge_graph_insights USING btree (knowledge_base_id, insight_type, created_at DESC, id);


--
-- Name: knowledge_graph_nodes_kb_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_nodes_kb_file_idx ON focowiki.knowledge_graph_nodes USING btree (knowledge_base_id, file_id);


--
-- Name: knowledge_graph_nodes_kb_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_nodes_kb_source_idx ON focowiki.knowledge_graph_nodes USING btree (knowledge_base_id, source_file_id) WHERE (source_file_id IS NOT NULL);


--
-- Name: knowledge_graph_nodes_profile_text_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_nodes_profile_text_trgm_idx ON focowiki.knowledge_graph_nodes USING gin (profile_text focowiki.gin_trgm_ops);


--
-- Name: knowledge_graph_search_documents_anchor_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_search_documents_anchor_cursor_idx ON focowiki.knowledge_graph_search_documents USING btree (knowledge_base_id, anchor_type, id);


--
-- Name: knowledge_graph_search_documents_kb_edge_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_search_documents_kb_edge_idx ON focowiki.knowledge_graph_search_documents USING btree (knowledge_base_id, edge_id) WHERE (edge_id IS NOT NULL);


--
-- Name: knowledge_graph_search_documents_kb_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_search_documents_kb_file_idx ON focowiki.knowledge_graph_search_documents USING btree (knowledge_base_id, file_id) WHERE (file_id IS NOT NULL);


--
-- Name: knowledge_graph_search_documents_kb_node_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_search_documents_kb_node_idx ON focowiki.knowledge_graph_search_documents USING btree (knowledge_base_id, node_id) WHERE (node_id IS NOT NULL);


--
-- Name: knowledge_graph_search_documents_search_text_trgm_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX knowledge_graph_search_documents_search_text_trgm_idx ON focowiki.knowledge_graph_search_documents USING gin (search_text focowiki.gin_trgm_ops);


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
-- Name: publication_jobs_kb_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_jobs_kb_created_idx ON focowiki.publication_jobs USING btree (knowledge_base_id, created_at DESC, id);


--
-- Name: publication_jobs_kb_status_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX publication_jobs_kb_status_created_idx ON focowiki.publication_jobs USING btree (knowledge_base_id, status, created_at, id);


--
-- Name: releases_kb_published_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX releases_kb_published_cursor_idx ON focowiki.releases USING btree (knowledge_base_id, published_at DESC, id);


--
-- Name: release_markdown_links_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX release_markdown_links_cursor_idx ON focowiki.release_markdown_links USING btree (release_id, from_path COLLATE "C", to_path COLLATE "C", label COLLATE "C");


--
-- Name: release_markdown_links_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX release_markdown_links_source_idx ON focowiki.release_markdown_links USING btree (release_id, source_file_id, from_path COLLATE "C");


--
-- Name: release_source_directories_navigation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX release_source_directories_navigation_idx ON focowiki.release_source_directories USING btree (release_id, parent_source_directory_id, lower(name), source_directory_id);


--
-- Name: release_source_directories_path_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX release_source_directories_path_cursor_idx ON focowiki.release_source_directories USING btree (release_id, path_key COLLATE "C", source_directory_id);


--
-- Name: release_source_files_directory_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX release_source_files_directory_cursor_idx ON focowiki.release_source_files USING btree (release_id, source_directory_id, lower(name), source_file_id);


--
-- Name: release_source_files_path_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX release_source_files_path_cursor_idx ON focowiki.release_source_files USING btree (release_id, path_key COLLATE "C", source_file_id);


--
-- Name: release_resource_operations_operation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX release_resource_operations_operation_idx ON focowiki.release_resource_operations USING btree (operation_id, release_id);


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

CREATE INDEX source_files_kb_error_state_created_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND ((processing_error_code IS NOT NULL) OR (publication_error_code IS NOT NULL)));


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

CREATE INDEX source_files_kb_no_error_created_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (processing_error_code IS NULL) AND (publication_error_code IS NULL));


--
-- Name: source_files_kb_openable_action_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_openable_action_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (generated_output_status = 'visible'::text) AND (generated_bundle_file_path IS NOT NULL));


--
-- Name: source_files_kb_processing_error_code_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_processing_error_code_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_error_code, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (processing_error_code IS NOT NULL));


--
-- Name: source_files_kb_processing_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_processing_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_status, processing_stage, created_at DESC, id);


--
-- Name: source_files_kb_publication_dirty_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_publication_dirty_idx ON focowiki.source_files USING btree (knowledge_base_id, publication_dirty_at, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (processing_status = 'completed'::text) AND (publication_dirty_at IS NOT NULL));


--
-- Name: source_files_kb_publication_error_code_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_publication_error_code_idx ON focowiki.source_files USING btree (knowledge_base_id, publication_error_code, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (publication_error_code IS NOT NULL));


--
-- Name: source_files_kb_retryable_action_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_kb_retryable_action_idx ON focowiki.source_files USING btree (knowledge_base_id, created_at DESC, id) WHERE ((deleted_at IS NULL) AND (task_deleted_at IS NULL) AND (processing_status = 'failed'::text));


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


-- Name: source_files_resource_cursor_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_resource_cursor_idx ON focowiki.source_files USING btree (knowledge_base_id, id) WHERE ((deleted_at IS NULL) AND (deletion_intent_id IS NULL));


-- Name: source_files_resource_processing_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_resource_processing_idx ON focowiki.source_files USING btree (knowledge_base_id, processing_status, processing_stage, generated_output_status, id) WHERE ((deleted_at IS NULL) AND (deletion_intent_id IS NULL));


-- Name: source_files_resource_id_prefix_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_resource_id_prefix_idx ON focowiki.source_files USING btree (knowledge_base_id, id text_pattern_ops) WHERE ((deleted_at IS NULL) AND (deletion_intent_id IS NULL));


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
-- Name: upload_session_entries_path_disposition_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_session_entries_path_disposition_idx ON focowiki.upload_session_entries USING btree (knowledge_base_id, path_key COLLATE "C", disposition, id);


--
-- Name: upload_session_entries_resume_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_session_entries_resume_idx ON focowiki.upload_session_entries USING btree (session_id, transfer_state, sequence_number, id);


--
-- Name: upload_session_entries_finalization_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_session_entries_finalization_idx ON focowiki.upload_session_entries USING btree (session_id, sequence_number, id) WHERE ((disposition = 'upload_required'::text) AND (transfer_state = 'uploaded'::text) AND (finalized_at IS NULL));


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
-- Name: worker_heartbeats_seen_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_heartbeats_seen_idx ON focowiki.worker_heartbeats USING btree (last_seen_at DESC, worker_id);


--
-- Name: worker_jobs_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_claim_idx ON focowiki.worker_jobs USING btree (status, run_after, created_at, id);


--
-- Name: worker_jobs_hard_delete_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_hard_delete_active_idx ON focowiki.worker_jobs USING btree (knowledge_base_id, kind, status, run_after, id) WHERE ((kind = 'hard_delete'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: worker_jobs_kb_created_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_kb_created_idx ON focowiki.worker_jobs USING btree (knowledge_base_id, created_at DESC, id);


--
-- Name: worker_jobs_kind_status_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_kind_status_idx ON focowiki.worker_jobs USING btree (kind, status, run_after, id);


--
-- Name: worker_jobs_upload_finalization_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_upload_finalization_active_idx ON focowiki.worker_jobs USING btree (knowledge_base_id, (payload_json ->> 'sessionId'::text), status, run_after, id) WHERE ((kind = 'upload_session_finalization'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: worker_jobs_publication_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_publication_active_idx ON focowiki.worker_jobs USING btree (kind, knowledge_base_id, status, run_after) WHERE ((kind = 'publication'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: worker_jobs_queued_oldest_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_queued_oldest_idx ON focowiki.worker_jobs USING btree (kind, knowledge_base_id, run_after, id) WHERE (status = 'queued'::text);


--
-- Name: worker_jobs_retention_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_retention_idx ON focowiki.worker_jobs USING btree (status, completed_at, failed_at, id) WHERE (status = ANY (ARRAY['completed'::text, 'failed'::text, 'dead_letter'::text, 'cancelled'::text]));


--
-- Name: worker_jobs_running_heartbeat_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_running_heartbeat_idx ON focowiki.worker_jobs USING btree (status, heartbeat_at, locked_at, id) WHERE (status = 'running'::text);


--
-- Name: worker_jobs_source_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_source_active_idx ON focowiki.worker_jobs USING btree (kind, source_file_id, status) WHERE ((source_file_id IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: worker_jobs_source_cancel_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_jobs_source_cancel_idx ON focowiki.worker_jobs USING btree (knowledge_base_id, kind, status, source_file_id, run_after, created_at, id) WHERE ((kind = 'source_file_processing'::text) AND (source_file_id IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: worker_queue_summaries_kind_status_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX worker_queue_summaries_kind_status_idx ON focowiki.worker_queue_summaries USING btree (kind, status, knowledge_base_id);


--
-- Name: worker_jobs worker_jobs_summary_sync_trigger; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER worker_jobs_summary_sync_trigger AFTER INSERT OR DELETE OR UPDATE OF knowledge_base_id, kind, status ON focowiki.worker_jobs FOR EACH ROW EXECUTE FUNCTION focowiki.sync_worker_queue_summary();


--
-- Name: bundle_files bundle_files_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.bundle_files
    ADD CONSTRAINT bundle_files_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: bundle_files bundle_files_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.bundle_files
    ADD CONSTRAINT bundle_files_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id);


--
-- Name: bundle_files bundle_files_source_directory_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.bundle_files
    ADD CONSTRAINT bundle_files_source_directory_id_fkey FOREIGN KEY (source_directory_id) REFERENCES focowiki.source_directories(id) ON DELETE SET NULL;


--
-- Name: bundle_files bundle_files_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.bundle_files
    ADD CONSTRAINT bundle_files_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: deletion_intents deletion_intents_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.deletion_intents
    ADD CONSTRAINT deletion_intents_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: hard_delete_object_deletions hard_delete_object_deletions_job_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.hard_delete_object_deletions
    ADD CONSTRAINT hard_delete_object_deletions_job_id_fkey FOREIGN KEY (job_id) REFERENCES focowiki.worker_jobs(id) ON DELETE CASCADE;


--
-- Name: hard_delete_object_deletions hard_delete_object_deletions_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.hard_delete_object_deletions
    ADD CONSTRAINT hard_delete_object_deletions_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: hard_delete_object_deletions hard_delete_object_deletions_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.hard_delete_object_deletions
    ADD CONSTRAINT hard_delete_object_deletions_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: knowledge_bases knowledge_bases_active_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_bases
    ADD CONSTRAINT knowledge_bases_active_release_id_fkey FOREIGN KEY (active_release_id) REFERENCES focowiki.releases(id);


--
-- Name: knowledge_file_tree_nodes knowledge_file_tree_nodes_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_file_tree_nodes
    ADD CONSTRAINT knowledge_file_tree_nodes_file_id_fkey FOREIGN KEY (file_id) REFERENCES focowiki.bundle_files(id) ON DELETE CASCADE;


--
-- Name: knowledge_file_tree_nodes knowledge_file_tree_nodes_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_file_tree_nodes
    ADD CONSTRAINT knowledge_file_tree_nodes_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: knowledge_file_tree_nodes knowledge_file_tree_nodes_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_file_tree_nodes
    ADD CONSTRAINT knowledge_file_tree_nodes_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: knowledge_file_tree_nodes knowledge_file_tree_nodes_source_directory_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_file_tree_nodes
    ADD CONSTRAINT knowledge_file_tree_nodes_source_directory_id_fkey FOREIGN KEY (source_directory_id) REFERENCES focowiki.source_directories(id) ON DELETE SET NULL;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_from_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_from_file_id_fkey FOREIGN KEY (from_file_id) REFERENCES focowiki.bundle_files(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_from_node_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_from_node_id_fkey FOREIGN KEY (from_node_id) REFERENCES focowiki.knowledge_graph_nodes(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: knowledge_graph_edges knowledge_graph_edges_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_to_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_to_file_id_fkey FOREIGN KEY (to_file_id) REFERENCES focowiki.bundle_files(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_to_node_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_to_node_id_fkey FOREIGN KEY (to_node_id) REFERENCES focowiki.knowledge_graph_nodes(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_insights knowledge_graph_insights_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_insights
    ADD CONSTRAINT knowledge_graph_insights_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: knowledge_graph_insights knowledge_graph_insights_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_insights
    ADD CONSTRAINT knowledge_graph_insights_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_file_id_fkey FOREIGN KEY (file_id) REFERENCES focowiki.bundle_files(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: knowledge_graph_search_documents knowledge_graph_search_documents_edge_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_search_documents
    ADD CONSTRAINT knowledge_graph_search_documents_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES focowiki.knowledge_graph_edges(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_search_documents knowledge_graph_search_documents_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_search_documents
    ADD CONSTRAINT knowledge_graph_search_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES focowiki.bundle_files(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_search_documents knowledge_graph_search_documents_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_search_documents
    ADD CONSTRAINT knowledge_graph_search_documents_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: knowledge_graph_search_documents knowledge_graph_search_documents_node_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_search_documents
    ADD CONSTRAINT knowledge_graph_search_documents_node_id_fkey FOREIGN KEY (node_id) REFERENCES focowiki.knowledge_graph_nodes(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_search_documents knowledge_graph_search_documents_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_graph_search_documents
    ADD CONSTRAINT knowledge_graph_search_documents_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: model_invocations model_invocations_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_invocations
    ADD CONSTRAINT model_invocations_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: model_invocations model_invocations_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_invocations
    ADD CONSTRAINT model_invocations_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: publication_jobs publication_jobs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_jobs
    ADD CONSTRAINT publication_jobs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: publication_jobs publication_jobs_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.publication_jobs
    ADD CONSTRAINT publication_jobs_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id);


--
-- Name: releases releases_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.releases
    ADD CONSTRAINT releases_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: release_source_directories release_source_directories_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_directories
    ADD CONSTRAINT release_source_directories_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: release_markdown_links release_markdown_links_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_markdown_links
    ADD CONSTRAINT release_markdown_links_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: release_markdown_links release_markdown_links_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_markdown_links
    ADD CONSTRAINT release_markdown_links_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: release_source_directories release_source_directories_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_directories
    ADD CONSTRAINT release_source_directories_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: release_source_directories release_source_directories_source_directory_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_directories
    ADD CONSTRAINT release_source_directories_source_directory_id_fkey FOREIGN KEY (source_directory_id) REFERENCES focowiki.source_directories(id);


--
-- Name: release_source_directories release_source_directories_parent_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_directories
    ADD CONSTRAINT release_source_directories_parent_fkey FOREIGN KEY (release_id, parent_source_directory_id) REFERENCES focowiki.release_source_directories(release_id, source_directory_id);


--
-- Name: release_source_files release_source_files_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: release_source_files release_source_files_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: release_source_files release_source_files_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: release_source_files release_source_files_source_revision_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_source_revision_id_fkey FOREIGN KEY (source_revision_id) REFERENCES focowiki.source_revisions(id);


--
-- Name: release_source_files release_source_files_source_directory_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_source_files
    ADD CONSTRAINT release_source_files_source_directory_fkey FOREIGN KEY (release_id, source_directory_id) REFERENCES focowiki.release_source_directories(release_id, source_directory_id);


--
-- Name: release_resource_operations release_resource_operations_release_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_resource_operations
    ADD CONSTRAINT release_resource_operations_release_id_fkey FOREIGN KEY (release_id) REFERENCES focowiki.releases(id) ON DELETE CASCADE;


--
-- Name: release_resource_operations release_resource_operations_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_resource_operations
    ADD CONSTRAINT release_resource_operations_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE;


--
-- Name: release_resource_operations release_resource_operations_operation_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.release_resource_operations
    ADD CONSTRAINT release_resource_operations_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES focowiki.resource_operations(id) ON DELETE CASCADE;


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
-- Name: source_file_events source_file_events_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_events
    ADD CONSTRAINT source_file_events_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


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
    ADD CONSTRAINT source_file_graph_edges_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: source_file_graph_edges source_file_graph_edges_to_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_edges
    ADD CONSTRAINT source_file_graph_edges_to_source_file_id_fkey FOREIGN KEY (to_source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_graph_jobs source_file_graph_jobs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_jobs
    ADD CONSTRAINT source_file_graph_jobs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: source_file_graph_jobs source_file_graph_jobs_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_jobs
    ADD CONSTRAINT source_file_graph_jobs_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_graph_nodes source_file_graph_nodes_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_nodes
    ADD CONSTRAINT source_file_graph_nodes_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: source_file_graph_nodes source_file_graph_nodes_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_graph_nodes
    ADD CONSTRAINT source_file_graph_nodes_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: source_file_retry_attempts source_file_retry_attempts_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_retry_attempts
    ADD CONSTRAINT source_file_retry_attempts_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


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
    ADD CONSTRAINT source_files_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


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
    ADD CONSTRAINT upload_session_entries_source_directory_id_fkey FOREIGN KEY (source_directory_id) REFERENCES focowiki.source_directories(id);


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
-- Name: worker_jobs worker_jobs_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.worker_jobs
    ADD CONSTRAINT worker_jobs_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);


--
-- Name: worker_jobs worker_jobs_source_file_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.worker_jobs
    ADD CONSTRAINT worker_jobs_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id);


--
-- Name: worker_queue_summaries worker_queue_summaries_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.worker_queue_summaries
    ADD CONSTRAINT worker_queue_summaries_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id);



INSERT INTO focowiki.runtime_generation (singleton, generation)
VALUES (true, 'admin-resource-editing-v3');
