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
-- Name: capture_model_config_revision(); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.capture_model_config_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO focowiki.model_config_revisions (
    configuration_public_id, revision_number, provider, model,
    secret_reference, config, created_at
  ) VALUES (
    NEW.public_id, NEW.revision, NEW.provider, NEW.model,
    NEW.secret_reference, NEW.config, NEW.updated_at
  );
  RETURN NEW;
END;
$$;


--
-- Name: public_generated_directory_id(text, text); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.public_generated_directory_id(knowledge_base_public_id text, generated_logical_path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT 'generated-directory-' || md5(
    knowledge_base_public_id || ':' || generated_logical_path
  )
$$;


--
-- Name: public_generated_file_id(text, text); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.public_generated_file_id(knowledge_base_public_id text, generated_logical_path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT 'generated-' || md5(
    knowledge_base_public_id || ':' || generated_logical_path
  )
$$;


--
-- Name: reject_document_job_contract_mutation(); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.reject_document_job_contract_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(
    NEW.knowledge_base_id,
    NEW.operation_public_id,
    NEW.source_file_public_id,
    NEW.source_revision_public_id,
    NEW.runtime_settings_revision_public_id,
    NEW.generation_model_configuration_public_id,
    NEW.generation_model_configuration_revision,
    NEW.embedding_configuration_revision_public_id,
    NEW.semantic_generation_public_id,
    NEW.semantic_contract_version,
    NEW.maximum_attempts,
    NEW.accepted_at
  ) IS DISTINCT FROM ROW(
    OLD.knowledge_base_id,
    OLD.operation_public_id,
    OLD.source_file_public_id,
    OLD.source_revision_public_id,
    OLD.runtime_settings_revision_public_id,
    OLD.generation_model_configuration_public_id,
    OLD.generation_model_configuration_revision,
    OLD.embedding_configuration_revision_public_id,
    OLD.semantic_generation_public_id,
    OLD.semantic_contract_version,
    OLD.maximum_attempts,
    OLD.accepted_at
  ) THEN
    RAISE EXCEPTION 'document job ownership and contracts are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: reject_model_config_revision_mutation(); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.reject_model_config_revision_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'model configuration revisions are immutable'
    USING ERRCODE = '23514';
END;
$$;


--
-- Name: reject_runtime_setting_revision_update(); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.reject_runtime_setting_revision_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'runtime setting revisions are immutable'
    USING ERRCODE = '23514';
END;
$$;


--
-- Name: reject_source_revision_content_mutation(); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.reject_source_revision_content_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(
    NEW.knowledge_base_id,
    NEW.source_file_public_id,
    NEW.object_id,
    NEW.checksum_sha256,
    NEW.byte_count,
    NEW.content_type,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.knowledge_base_id,
    OLD.source_file_public_id,
    OLD.object_id,
    OLD.checksum_sha256,
    OLD.byte_count,
    OLD.content_type,
    OLD.created_at
  ) OR OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL
    OR OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'source revision content is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: validate_source_file_active_revision(); Type: FUNCTION; Schema: focowiki; Owner: -
--

CREATE FUNCTION focowiki.validate_source_file_active_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_valid boolean;
  active_valid boolean;
  knowledge_base_sequence bigint;
BEGIN
  SELECT revision.deleted_at IS NULL
  INTO current_valid
  FROM focowiki.source_revisions revision
  WHERE revision.knowledge_base_id = NEW.knowledge_base_id
    AND revision.source_file_public_id = NEW.source_file_public_id
    AND revision.public_id = NEW.current_source_revision_public_id;
  IF current_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'current source revision pointer is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.active_source_revision_public_id IS NOT NULL THEN
    SELECT revision.retired_at IS NULL AND revision.deleted_at IS NULL
    INTO active_valid
    FROM focowiki.source_revisions revision
    WHERE revision.knowledge_base_id = NEW.knowledge_base_id
      AND revision.source_file_public_id = NEW.source_file_public_id
      AND revision.public_id = NEW.active_source_revision_public_id;
    IF active_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'active source revision pointer is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT current_sequence
  INTO knowledge_base_sequence
  FROM focowiki.knowledge_base_sequences
  WHERE knowledge_base_id = NEW.knowledge_base_id;
  IF knowledge_base_sequence IS NULL
    OR NEW.activation_sequence > knowledge_base_sequence THEN
    RAISE EXCEPTION 'source activation sequence is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cleanup_actions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.cleanup_actions (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_public_id text,
    document_job_public_id text,
    source_revision_public_id text,
    action_kind text NOT NULL,
    cleanup_plane text NOT NULL,
    search_provider_kind text,
    resource_kind text NOT NULL,
    resource_public_id text NOT NULL,
    required boolean NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    sequence_number integer NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    maximum_attempts integer NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    safe_error_code text,
    not_before timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: diagnostic_events; Type: TABLE; Schema: focowiki; Owner: -
--

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
    CONSTRAINT diagnostic_events_duration_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT diagnostic_events_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT diagnostic_events_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (stage <> ''::text) AND (octet_length(stage) <= 128) AND (event_code <> ''::text) AND (octet_length(event_code) <= 128))),
    CONSTRAINT diagnostic_events_message_check CHECK (((safe_message IS NULL) OR (octet_length(safe_message) <= 2048))),
    CONSTRAINT diagnostic_events_severity_check CHECK ((severity = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text])))
)
PARTITION BY RANGE (created_at);


--
-- Name: diagnostic_events_2026_08; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.diagnostic_events_2026_08 (
    public_id text CONSTRAINT diagnostic_events_public_id_not_null NOT NULL,
    knowledge_base_id text,
    operation_public_id text,
    stage text CONSTRAINT diagnostic_events_stage_not_null NOT NULL,
    severity text CONSTRAINT diagnostic_events_severity_not_null NOT NULL,
    event_code text CONSTRAINT diagnostic_events_event_code_not_null NOT NULL,
    safe_message text,
    duration_ms bigint,
    correlation_public_id text,
    created_at timestamp with time zone CONSTRAINT diagnostic_events_created_at_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT diagnostic_events_expires_at_not_null NOT NULL,
    CONSTRAINT diagnostic_events_duration_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT diagnostic_events_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT diagnostic_events_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (stage <> ''::text) AND (octet_length(stage) <= 128) AND (event_code <> ''::text) AND (octet_length(event_code) <= 128))),
    CONSTRAINT diagnostic_events_message_check CHECK (((safe_message IS NULL) OR (octet_length(safe_message) <= 2048))),
    CONSTRAINT diagnostic_events_severity_check CHECK ((severity = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text])))
);


--
-- Name: diagnostic_events_2026_09; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.diagnostic_events_2026_09 (
    public_id text CONSTRAINT diagnostic_events_public_id_not_null NOT NULL,
    knowledge_base_id text,
    operation_public_id text,
    stage text CONSTRAINT diagnostic_events_stage_not_null NOT NULL,
    severity text CONSTRAINT diagnostic_events_severity_not_null NOT NULL,
    event_code text CONSTRAINT diagnostic_events_event_code_not_null NOT NULL,
    safe_message text,
    duration_ms bigint,
    correlation_public_id text,
    created_at timestamp with time zone CONSTRAINT diagnostic_events_created_at_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT diagnostic_events_expires_at_not_null NOT NULL,
    CONSTRAINT diagnostic_events_duration_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT diagnostic_events_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT diagnostic_events_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (stage <> ''::text) AND (octet_length(stage) <= 128) AND (event_code <> ''::text) AND (octet_length(event_code) <= 128))),
    CONSTRAINT diagnostic_events_message_check CHECK (((safe_message IS NULL) OR (octet_length(safe_message) <= 2048))),
    CONSTRAINT diagnostic_events_severity_check CHECK ((severity = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text])))
);


--
-- Name: document_model_analysis_results; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.document_model_analysis_results (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_revision_public_id text CONSTRAINT document_model_analysis_resu_source_revision_public_id_not_null NOT NULL,
    model_configuration_public_id text CONSTRAINT document_model_analysis_res_model_configuration_public_not_null NOT NULL,
    model_configuration_revision bigint CONSTRAINT document_model_analysis_res_model_configuration_revisi_not_null NOT NULL,
    prompt_contract_sha256 text NOT NULL,
    model_input_sha256 text NOT NULL,
    result jsonb NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_model_analysis_results_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (source_revision_public_id <> ''::text) AND (octet_length(source_revision_public_id) <= 255) AND (model_configuration_public_id <> ''::text) AND (octet_length(model_configuration_public_id) <= 255) AND (model_configuration_revision > 0) AND (prompt_contract_sha256 ~ '^[0-9a-f]{64}$'::text) AND (model_input_sha256 ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 131072) AND (jsonb_typeof(warnings) = 'array'::text) AND (jsonb_array_length(warnings) <= 1000) AND (octet_length((warnings)::text) <= 262144)))
);


--
-- Name: document_model_layer_executions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.document_model_layer_executions (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    document_job_public_id text NOT NULL,
    source_revision_public_id text CONSTRAINT document_model_layer_executi_source_revision_public_id_not_null NOT NULL,
    layer text NOT NULL,
    execution_identity_sha256 text CONSTRAINT document_model_layer_executi_execution_identity_sha256_not_null NOT NULL,
    status text NOT NULL,
    model_name text NOT NULL,
    selected boolean,
    reused boolean NOT NULL,
    provider_request_count integer NOT NULL,
    provider_observations jsonb DEFAULT '[]'::jsonb NOT NULL,
    wait_time_milliseconds bigint NOT NULL,
    service_time_milliseconds bigint CONSTRAINT document_model_layer_executi_service_time_milliseconds_not_null NOT NULL,
    warning_count integer NOT NULL,
    error_code text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_model_layer_executions_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (layer = ANY (ARRAY['first_layer'::text, 'candidate_delta'::text, 'graphrag'::text])) AND (execution_identity_sha256 ~ '^[0-9a-f]{64}$'::text) AND (status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])) AND (model_name <> ''::text) AND (octet_length(model_name) <= 255) AND (provider_request_count >= 0) AND (jsonb_typeof(provider_observations) = 'array'::text) AND (jsonb_array_length(provider_observations) <= 8) AND (octet_length(provider_observations::text) <= 32768) AND (wait_time_milliseconds >= 0) AND (service_time_milliseconds >= 0) AND (warning_count >= 0) AND ((error_code IS NULL) OR ((error_code ~ '^[A-Za-z0-9_]+$'::text) AND (octet_length(error_code) <= 128))) AND (((status = 'running'::text) AND (ended_at IS NULL) AND (error_code IS NULL)) OR ((status = 'completed'::text) AND (ended_at IS NOT NULL) AND (error_code IS NULL)) OR ((status = 'failed'::text) AND (ended_at IS NOT NULL) AND (error_code IS NOT NULL)))))
);


--
-- Name: document_processing_jobs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.document_processing_jobs (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    runtime_settings_revision_public_id text CONSTRAINT document_processing_jobs_runtime_settings_revision_pub_not_null NOT NULL,
    generation_model_configuration_public_id text NOT NULL,
    generation_model_configuration_revision bigint NOT NULL,
    embedding_configuration_revision_public_id text NOT NULL,
    semantic_generation_public_id text NOT NULL,
    semantic_contract_version text NOT NULL,
    readiness_sequence bigint GENERATED BY DEFAULT AS IDENTITY,
    state text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    total_attempt_count bigint DEFAULT 0 NOT NULL,
    manual_retry_count integer DEFAULT 0 NOT NULL,
    maximum_attempts integer NOT NULL,
    next_attempt_at timestamp with time zone,
    required_work_count integer DEFAULT 8 NOT NULL,
    completed_work_count integer DEFAULT 0 NOT NULL,
    active_work_kinds text[] DEFAULT '{}'::text[] NOT NULL,
    blocking_work_kind text,
    retrying_work_kind text,
    cancellation_requested_at timestamp with time zone,
    safe_error_code text,
    safe_error_message text,
    retryable boolean DEFAULT false NOT NULL,
    model_status text,
    model_name text,
    model_started_at timestamp with time zone,
    model_ended_at timestamp with time zone,
    model_warning_count integer,
    model_error_code text,
    accepted_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    terminal_at timestamp with time zone,
    service_time_milliseconds bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_processing_jobs_attempt_check CHECK ((((maximum_attempts >= 1) AND (maximum_attempts <= 100)) AND ((attempt_count >= 0) AND (attempt_count <= maximum_attempts)) AND (failure_count >= 0) AND (failure_count <= total_attempt_count) AND (total_attempt_count >= attempt_count) AND (manual_retry_count >= 0))),
    CONSTRAINT document_processing_jobs_contract_check CHECK (((semantic_contract_version <> ''::text) AND (octet_length(semantic_contract_version) <= 255) AND (generation_model_configuration_public_id <> ''::text) AND (octet_length(generation_model_configuration_public_id) <= 255) AND (generation_model_configuration_revision >= 1) AND (embedding_configuration_revision_public_id <> ''::text) AND (octet_length(embedding_configuration_revision_public_id) <= 255) AND (semantic_generation_public_id <> ''::text) AND (octet_length(semantic_generation_public_id) <= 255))),
    CONSTRAINT document_processing_jobs_error_check CHECK ((((state = 'error'::text) AND (safe_error_code IS NOT NULL) AND (safe_error_code <> ''::text) AND (octet_length(safe_error_code) <= 128)) OR ((state <> 'error'::text) AND (safe_error_code IS NULL) AND (safe_error_message IS NULL) AND (NOT retryable)))),
    CONSTRAINT document_processing_jobs_error_message_check CHECK (((safe_error_message IS NULL) OR (octet_length(safe_error_message) <= 2048))),
    CONSTRAINT document_processing_jobs_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (knowledge_base_id <> ''::text) AND (octet_length(knowledge_base_id) <= 255) AND (operation_public_id <> ''::text) AND (octet_length(operation_public_id) <= 255) AND (source_file_public_id <> ''::text) AND (octet_length(source_file_public_id) <= 255) AND (source_revision_public_id <> ''::text) AND (octet_length(source_revision_public_id) <= 255) AND (runtime_settings_revision_public_id <> ''::text) AND (octet_length(runtime_settings_revision_public_id) <= 255))),
    CONSTRAINT document_processing_jobs_work_summary_check CHECK (((readiness_sequence > 0) AND (required_work_count >= 1) AND (required_work_count <= 8) AND (completed_work_count >= 0) AND (completed_work_count <= required_work_count) AND (active_work_kinds <@ ARRAY['prepare'::text, 'first_layer'::text, 'content_projection'::text, 'graphrag'::text, 'relation_reconcile'::text, 'knowledge_projection'::text, 'activate'::text, 'cleanup'::text]) AND ((blocking_work_kind IS NULL) OR (blocking_work_kind = ANY (ARRAY['prepare'::text, 'first_layer'::text, 'content_projection'::text, 'graphrag'::text, 'relation_reconcile'::text, 'knowledge_projection'::text, 'activate'::text, 'cleanup'::text]))) AND ((retrying_work_kind IS NULL) OR (retrying_work_kind = ANY (ARRAY['prepare'::text, 'first_layer'::text, 'content_projection'::text, 'graphrag'::text, 'relation_reconcile'::text, 'knowledge_projection'::text, 'activate'::text, 'cleanup'::text]))))),
    CONSTRAINT document_processing_jobs_model_check CHECK ((((model_status IS NULL) AND (model_name IS NULL) AND (model_started_at IS NULL) AND (model_ended_at IS NULL) AND (model_warning_count IS NULL) AND (model_error_code IS NULL)) OR ((model_status = 'not_required'::text) AND (model_name IS NULL) AND (model_started_at IS NULL) AND (model_ended_at IS NOT NULL) AND (model_warning_count = 0) AND (model_error_code IS NULL)) OR ((model_status = 'running'::text) AND (model_name IS NOT NULL) AND (model_started_at IS NOT NULL) AND (model_ended_at IS NULL) AND (model_warning_count >= 0) AND (model_error_code IS NULL)) OR ((model_status = 'completed'::text) AND (model_name IS NOT NULL) AND (model_started_at IS NOT NULL) AND (model_ended_at >= model_started_at) AND (model_warning_count >= 0) AND (model_error_code IS NULL)) OR ((model_status = 'failed'::text) AND (model_name IS NOT NULL) AND (model_started_at IS NOT NULL) AND (model_ended_at >= model_started_at) AND (model_warning_count >= 0) AND (model_error_code IS NOT NULL)))),
    CONSTRAINT document_processing_jobs_model_payload_check CHECK ((((model_name IS NULL) OR ((model_name <> ''::text) AND (octet_length(model_name) <= 255))) AND ((model_warning_count IS NULL) OR ((model_warning_count >= 0) AND (model_warning_count <= 1000))) AND ((model_error_code IS NULL) OR ((model_error_code <> ''::text) AND (octet_length(model_error_code) <= 128))))),
    CONSTRAINT document_processing_jobs_state_check CHECK ((state = ANY (ARRAY['waiting'::text, 'processing'::text, 'available'::text, 'error'::text, 'deleting'::text, 'cancelled'::text, 'superseded'::text]))),
    CONSTRAINT document_processing_jobs_terminal_check CHECK ((((state = ANY (ARRAY['available'::text, 'error'::text, 'cancelled'::text, 'superseded'::text])) AND (started_at IS NOT NULL) AND (terminal_at IS NOT NULL) AND (terminal_at >= started_at)) OR ((state = ANY (ARRAY['waiting'::text, 'processing'::text, 'deleting'::text])) AND (terminal_at IS NULL)))),
    CONSTRAINT document_processing_jobs_time_check CHECK (((accepted_at >= created_at) AND ((started_at IS NULL) OR (started_at >= accepted_at)) AND (updated_at >= created_at) AND (service_time_milliseconds >= 0) AND (revision >= 0) AND ((cancellation_requested_at IS NULL) OR (cancellation_requested_at >= accepted_at))))
);


--
-- Name: embedding_artifact_owners; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.embedding_artifact_owners (
    knowledge_base_id text NOT NULL,
    artifact_public_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT embedding_artifact_owners_semantic_generation_public_i_not_null NOT NULL,
    operation_public_id text,
    source_revision_public_id text,
    owner_kind text NOT NULL,
    owner_public_id text NOT NULL,
    retention_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embedding_artifact_owners_value_check CHECK (((owner_kind = ANY (ARRAY['content'::text, 'entity'::text, 'relationship'::text, 'community'::text])) AND (owner_public_id <> ''::text) AND (octet_length(owner_public_id) <= 255) AND (retention_kind = ANY (ARRAY['candidate'::text, 'active'::text, 'retry'::text, 'cleanup'::text]))))
);


--
-- Name: embedding_artifacts; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.embedding_artifacts (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    object_id text NOT NULL,
    owner_kind text NOT NULL,
    owner_public_id text NOT NULL,
    source_revision_public_id text,
    canonical_input_sha256 text NOT NULL,
    input_kind text NOT NULL,
    embedding_configuration_revision_public_id text CONSTRAINT embedding_artifacts_embedding_configuration_revision_p_not_null NOT NULL,
    normalization text NOT NULL,
    dimension integer NOT NULL,
    artifact_schema_version text NOT NULL,
    vector_checksum_sha256 text NOT NULL,
    byte_count bigint NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT embedding_artifacts_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (owner_kind = ANY (ARRAY['content'::text, 'entity'::text, 'relationship'::text, 'community'::text])) AND (owner_public_id <> ''::text) AND (octet_length(owner_public_id) <= 255) AND (canonical_input_sha256 ~ '^[0-9a-f]{64}$'::text) AND (input_kind = ANY (ARRAY['content'::text, 'entity'::text, 'relationship'::text, 'community'::text])) AND (normalization = ANY (ARRAY['none'::text, 'l2'::text])) AND ((dimension >= 1) AND (dimension <= 65536)) AND (artifact_schema_version <> ''::text) AND (octet_length(artifact_schema_version) <= 128) AND (vector_checksum_sha256 ~ '^[0-9a-f]{64}$'::text) AND (byte_count > 0) AND (byte_count <= 268435456) AND (state = ANY (ARRAY['registered'::text, 'verified'::text, 'failed'::text, 'orphaned'::text]))))
);


--
-- Name: embedding_configuration_revisions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.embedding_configuration_revisions (
    public_id text NOT NULL,
    configuration_public_id text CONSTRAINT embedding_configuration_revisi_configuration_public_id_not_null NOT NULL,
    revision_number bigint NOT NULL,
    authentication_mode text NOT NULL,
    base_url text NOT NULL,
    encrypted_api_key bytea,
    model_name text NOT NULL,
    requested_dimension integer,
    resolved_dimension integer,
    normalization text NOT NULL,
    maximum_input_tokens integer NOT NULL,
    batch_size integer NOT NULL,
    timeout_ms integer NOT NULL,
    retry_count integer NOT NULL,
    minimum_interval_ms integer NOT NULL,
    concurrency integer NOT NULL,
    maximum_response_bytes integer CONSTRAINT embedding_configuration_revisio_maximum_response_bytes_not_null NOT NULL,
    minimum_vector_relevance double precision CONSTRAINT embedding_configuration_revis_minimum_vector_relevance_not_null NOT NULL,
    vector_producing_revision_public_id text CONSTRAINT embedding_configuration_rev_vector_producing_revision__not_null NOT NULL,
    validation_status text NOT NULL,
    validation_fingerprint_sha256 text,
    safe_validation_error_code text,
    validated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embedding_configuration_revisions_authentication_check CHECK ((((authentication_mode = 'api_key'::text) AND (encrypted_api_key IS NOT NULL)) OR ((authentication_mode = 'none'::text) AND (encrypted_api_key IS NULL)))),
    CONSTRAINT embedding_configuration_revisions_bounds_check CHECK (((revision_number >= 1) AND ((maximum_input_tokens >= 1) AND (maximum_input_tokens <= 1048576)) AND ((batch_size >= 1) AND (batch_size <= 2048)) AND ((timeout_ms >= 100) AND (timeout_ms <= 300000)) AND ((retry_count >= 0) AND (retry_count <= 10)) AND ((minimum_interval_ms >= 0) AND (minimum_interval_ms <= 60000)) AND ((concurrency >= 1) AND (concurrency <= 64)) AND ((maximum_response_bytes >= 1024) AND (maximum_response_bytes <= 67108864)) AND (minimum_vector_relevance >= (0)::double precision) AND (minimum_vector_relevance <= (1)::double precision))),
    CONSTRAINT embedding_configuration_revisions_dimension_check CHECK ((((requested_dimension IS NULL) OR ((requested_dimension >= 1) AND (requested_dimension <= 65536))) AND ((resolved_dimension IS NULL) OR ((resolved_dimension >= 1) AND (resolved_dimension <= 65536))))),
    CONSTRAINT embedding_configuration_revisions_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (vector_producing_revision_public_id <> ''::text) AND (octet_length(vector_producing_revision_public_id) <= 255) AND (base_url <> ''::text) AND (octet_length(base_url) <= 2048) AND (model_name <> ''::text) AND (octet_length(model_name) <= 255))),
    CONSTRAINT embedding_configuration_revisions_normalization_check CHECK ((normalization = ANY (ARRAY['none'::text, 'l2'::text]))),
    CONSTRAINT embedding_configuration_revisions_validation_check CHECK (((validation_status = ANY (ARRAY['not_tested'::text, 'valid'::text, 'invalid'::text])) AND ((validation_fingerprint_sha256 IS NULL) OR (validation_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((safe_validation_error_code IS NULL) OR (octet_length(safe_validation_error_code) <= 128)) AND ((validation_status <> 'valid'::text) OR ((resolved_dimension IS NOT NULL) AND (validation_fingerprint_sha256 IS NOT NULL) AND (validated_at IS NOT NULL) AND (safe_validation_error_code IS NULL)))))
);


--
-- Name: embedding_configurations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.embedding_configurations (
    public_id text NOT NULL,
    display_name text NOT NULL,
    lifecycle_status text NOT NULL,
    active_revision_public_id text,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT embedding_configurations_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (display_name <> ''::text) AND (octet_length(display_name) <= 255))),
    CONSTRAINT embedding_configurations_lifecycle_check CHECK ((lifecycle_status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text]))),
    CONSTRAINT embedding_configurations_revision_check CHECK ((revision >= 0))
);


--
-- Name: generated_directory_leaf_entries; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.generated_directory_leaf_entries (
    knowledge_base_id text NOT NULL,
    directory_path text NOT NULL,
    leaf_public_id text NOT NULL,
    entry_public_id text NOT NULL,
    ordinal integer NOT NULL,
    sort_key text NOT NULL,
    name text NOT NULL,
    target_path text NOT NULL,
    evidence_path text,
    entry_kind text NOT NULL,
    CONSTRAINT generated_directory_leaf_entries_value_check CHECK (((entry_public_id <> ''::text) AND (octet_length(entry_public_id) <= 255) AND (ordinal >= 0) AND (sort_key <> ''::text) AND (octet_length(sort_key) <= 4096) AND (name <> ''::text) AND (octet_length(name) <= 1024) AND (target_path <> ''::text) AND (octet_length(target_path) <= 4096) AND ((evidence_path IS NULL) OR (octet_length(evidence_path) <= 4096)) AND (entry_kind = ANY (ARRAY['file'::text, 'directory'::text]))))
);


--
-- Name: generated_directory_leaves; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.generated_directory_leaves (
    knowledge_base_id text NOT NULL,
    directory_path text NOT NULL,
    leaf_public_id text NOT NULL,
    previous_leaf_public_id text,
    next_leaf_public_id text,
    first_sort_key text NOT NULL,
    last_sort_key text NOT NULL,
    entry_count integer NOT NULL,
    revision bigint NOT NULL,
    activation_revision bigint NOT NULL,
    changed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_directory_leaves_value_check CHECK (((directory_path <> ''::text) AND (octet_length(directory_path) <= 4096) AND (leaf_public_id <> ''::text) AND (octet_length(leaf_public_id) <= 255) AND ((previous_leaf_public_id IS NULL) OR ((octet_length(previous_leaf_public_id) >= 1) AND (octet_length(previous_leaf_public_id) <= 255))) AND ((next_leaf_public_id IS NULL) OR ((octet_length(next_leaf_public_id) >= 1) AND (octet_length(next_leaf_public_id) <= 255))) AND (first_sort_key <> ''::text) AND (octet_length(first_sort_key) <= 4096) AND (last_sort_key <> ''::text) AND (octet_length(last_sort_key) <= 4096) AND (entry_count > 0) AND (revision > 0) AND (activation_revision > 0)))
);


--
-- Name: generated_page_candidates; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.generated_page_candidates (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_work_public_id text,
    source_revision_public_id text,
    owner_operation_public_id text,
    logical_path text NOT NULL,
    normalized_path text NOT NULL,
    entry_kind text NOT NULL,
    source_file_public_id text,
    page_source_file_public_id text,
    page_source_revision_public_id text,
    object_id text NOT NULL,
    checksum_sha256 text NOT NULL,
    byte_count bigint NOT NULL,
    base_activation_revision bigint NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_page_candidates_owner_check CHECK ((((source_work_public_id IS NOT NULL) AND (source_revision_public_id IS NOT NULL) AND (source_file_public_id IS NOT NULL) AND (owner_operation_public_id IS NULL)) OR ((source_work_public_id IS NULL) AND (source_revision_public_id IS NULL) AND (source_file_public_id IS NULL) AND (owner_operation_public_id IS NOT NULL)))),
    CONSTRAINT generated_page_candidates_page_owner_check CHECK ((((page_source_file_public_id IS NULL) AND (page_source_revision_public_id IS NULL)) OR ((page_source_file_public_id IS NOT NULL) AND (page_source_revision_public_id IS NOT NULL))))
);


--
-- Name: generated_page_heads; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.generated_page_heads (
    knowledge_base_id text NOT NULL,
    logical_path text NOT NULL,
    normalized_path text NOT NULL,
    entry_kind text NOT NULL,
    source_file_public_id text,
    source_revision_public_id text,
    page_candidate_public_id text NOT NULL,
    object_id text NOT NULL,
    checksum_sha256 text NOT NULL,
    byte_count bigint NOT NULL,
    activation_revision bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: graph_edges; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.graph_edges (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    from_node_public_id text NOT NULL,
    to_node_public_id text NOT NULL,
    relation text NOT NULL,
    weight double precision NOT NULL,
    reason text,
    edge_source text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT graph_edges_endpoints_check CHECK ((from_node_public_id <> to_node_public_id)),
    CONSTRAINT graph_edges_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (relation <> ''::text) AND (octet_length(relation) <= 128) AND (edge_source <> ''::text) AND (octet_length(edge_source) <= 128))),
    CONSTRAINT graph_edges_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 8192))),
    CONSTRAINT graph_edges_reason_check CHECK (((reason IS NULL) OR (octet_length(reason) <= 2048))),
    CONSTRAINT graph_edges_revision_check CHECK ((revision >= 0)),
    CONSTRAINT graph_edges_weight_check CHECK (((weight >= (0)::double precision) AND (weight <= (1)::double precision)))
);


--
-- Name: graph_evidence_refs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.graph_evidence_refs (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    node_public_id text,
    edge_public_id text,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    logical_path text NOT NULL,
    start_offset bigint NOT NULL,
    end_offset bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    CONSTRAINT graph_evidence_refs_checksum_check CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT graph_evidence_refs_offset_range_check CHECK (((start_offset >= 0) AND (end_offset >= start_offset))),
    CONSTRAINT graph_evidence_refs_path_check CHECK (((logical_path <> ''::text) AND (octet_length(logical_path) <= 4096))),
    CONSTRAINT graph_evidence_refs_target_check CHECK (((((node_public_id IS NOT NULL))::integer + ((edge_public_id IS NOT NULL))::integer) = 1))
);


--
-- Name: graph_nodes; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.graph_nodes (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    logical_path text NOT NULL,
    label text NOT NULL,
    node_kind text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT graph_nodes_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255))),
    CONSTRAINT graph_nodes_label_check CHECK (((label <> ''::text) AND (octet_length(label) <= 1024) AND (node_kind <> ''::text) AND (octet_length(node_kind) <= 128))),
    CONSTRAINT graph_nodes_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 8192))),
    CONSTRAINT graph_nodes_path_check CHECK (((logical_path <> ''::text) AND (octet_length(logical_path) <= 4096))),
    CONSTRAINT graph_nodes_revision_check CHECK ((revision >= 0))
);


--
-- Name: knowledge_bases; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.knowledge_bases (
    public_id text NOT NULL,
    name text NOT NULL,
    description text,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT knowledge_bases_description_check CHECK (((description IS NULL) OR (octet_length(description) <= 4096))),
    CONSTRAINT knowledge_bases_name_check CHECK (((name <> ''::text) AND (octet_length(name) <= 1024))),
    CONSTRAINT knowledge_bases_public_id_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255))),
    CONSTRAINT knowledge_bases_revision_check CHECK ((revision >= 0))
);


--
-- Name: model_config_revisions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.model_config_revisions (
    configuration_public_id text NOT NULL,
    revision_number bigint NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    secret_reference text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_config_revisions_value_check CHECK (((configuration_public_id <> ''::text) AND (octet_length(configuration_public_id) <= 255) AND (revision_number >= 1) AND (provider <> ''::text) AND (octet_length(provider) <= 128) AND (model <> ''::text) AND (octet_length(model) <= 255) AND (secret_reference <> ''::text) AND (octet_length(secret_reference) <= 4096) AND (jsonb_typeof(config) = 'object'::text) AND (octet_length((config)::text) <= 32768)))
);


--
-- Name: model_configs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.model_configs (
    public_id text NOT NULL,
    knowledge_base_id text,
    provider text NOT NULL,
    model text NOT NULL,
    secret_reference text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean NOT NULL,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_configs_config_check CHECK (((jsonb_typeof(config) = 'object'::text) AND (octet_length((config)::text) <= 32768))),
    CONSTRAINT model_configs_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255))),
    CONSTRAINT model_configs_provider_check CHECK (((provider <> ''::text) AND (octet_length(provider) <= 128) AND (model <> ''::text) AND (octet_length(model) <= 255) AND (secret_reference <> ''::text) AND (octet_length(secret_reference) <= 1024))),
    CONSTRAINT model_configs_revision_check CHECK ((revision >= 0))
);


--
-- Name: mutation_path_reservations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.mutation_path_reservations (
    knowledge_base_id text NOT NULL,
    normalized_path text NOT NULL,
    operation_public_id text NOT NULL,
    target_kind text NOT NULL,
    target_public_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mutation_path_reservations_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT mutation_path_reservations_identity_check CHECK (((normalized_path <> ''::text) AND (octet_length(normalized_path) <= 4096) AND (target_kind = ANY (ARRAY['source_file'::text, 'source_directory'::text])) AND (target_public_id <> ''::text) AND (octet_length(target_public_id) <= 255)))
);


--
-- Name: object_owners; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.object_owners (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    object_id text NOT NULL,
    owner_kind text NOT NULL,
    source_revision_public_id text,
    source_receipt_public_id text,
    generated_page_candidate_public_id text,
    operation_public_id text,
    embedding_artifact_public_id text,
    owner_public_id text GENERATED ALWAYS AS (COALESCE(source_revision_public_id, source_receipt_public_id, generated_page_candidate_public_id, operation_public_id, embedding_artifact_public_id)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT object_owners_target_check CHECK (
      (owner_kind = 'source_revision' AND source_revision_public_id IS NOT NULL
        AND source_receipt_public_id IS NULL
        AND generated_page_candidate_public_id IS NULL
        AND operation_public_id IS NULL
        AND embedding_artifact_public_id IS NULL)
      OR (owner_kind = 'source_receipt' AND source_revision_public_id IS NULL
        AND source_receipt_public_id IS NOT NULL
        AND generated_page_candidate_public_id IS NULL
        AND operation_public_id IS NULL
        AND embedding_artifact_public_id IS NULL)
      OR (owner_kind = 'generated_page_candidate'
        AND source_revision_public_id IS NULL
        AND source_receipt_public_id IS NULL
        AND generated_page_candidate_public_id IS NOT NULL
        AND operation_public_id IS NULL
        AND embedding_artifact_public_id IS NULL)
      OR (owner_kind = 'live_reservation' AND source_revision_public_id IS NULL
        AND source_receipt_public_id IS NULL
        AND generated_page_candidate_public_id IS NULL
        AND operation_public_id IS NOT NULL
        AND embedding_artifact_public_id IS NULL)
      OR (owner_kind = 'embedding_artifact'
        AND source_revision_public_id IS NULL
        AND source_receipt_public_id IS NULL
        AND generated_page_candidate_public_id IS NULL
        AND operation_public_id IS NULL
        AND embedding_artifact_public_id IS NOT NULL)
    )
);


--
-- Name: object_registrations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.object_registrations (
    object_id text NOT NULL,
    storage_key text NOT NULL,
    checksum_sha256 text NOT NULL,
    byte_count bigint NOT NULL,
    content_type text NOT NULL,
    object_format text NOT NULL,
    state text NOT NULL,
    write_attempt_public_id text NOT NULL,
    reservation_expires_at timestamp with time zone,
    verified_at timestamp with time zone,
    zero_owner_since timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT object_registrations_byte_count_nonnegative_check CHECK ((byte_count >= 0)),
    CONSTRAINT object_registrations_checksum_check CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT object_registrations_content_check CHECK (((content_type <> ''::text) AND (octet_length(content_type) <= 255) AND (object_format <> ''::text) AND (octet_length(object_format) <= 128))),
    CONSTRAINT object_registrations_identity_check CHECK (((object_id <> ''::text) AND (octet_length(object_id) <= 255) AND (storage_key <> ''::text) AND (octet_length(storage_key) <= 2048) AND (write_attempt_public_id <> ''::text) AND (octet_length(write_attempt_public_id) <= 255))),
    CONSTRAINT object_registrations_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'verified'::text, 'deleting'::text, 'deleted'::text]))),
    CONSTRAINT object_registrations_reservation_lease_check CHECK (
      ((state = 'reserved'::text) AND (verified_at IS NULL)
        AND (reservation_expires_at IS NOT NULL)
        AND (reservation_expires_at > created_at))
      OR ((state = 'verified'::text) AND (verified_at IS NOT NULL)
        AND ((reservation_expires_at IS NULL)
          OR (reservation_expires_at > verified_at)))
      OR ((state = ANY (ARRAY['deleting'::text, 'deleted'::text]))
        AND (verified_at IS NOT NULL) AND (reservation_expires_at IS NULL))
    )
);


--
-- Name: operation_idempotency; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.operation_idempotency (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    operation_public_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operation_idempotency_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT operation_idempotency_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (idempotency_key <> ''::text) AND (octet_length(idempotency_key) <= 255) AND (request_hash ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: operation_results; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.operation_results (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_kind text NOT NULL,
    terminal_state text NOT NULL,
    result_code text NOT NULL,
    safe_message text,
    result_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    correlation_public_id text,
    completed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT operation_results_code_check CHECK (((result_code <> ''::text) AND (octet_length(result_code) <= 128))),
    CONSTRAINT operation_results_expiry_check CHECK ((expires_at > completed_at)),
    CONSTRAINT operation_results_kind_check CHECK (((operation_kind <> ''::text) AND (octet_length(operation_kind) <= 128))),
    CONSTRAINT operation_results_message_check CHECK (((safe_message IS NULL) OR (octet_length(safe_message) <= 2048))),
    CONSTRAINT operation_results_state_check CHECK ((terminal_state = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'timed_out'::text, 'deleted'::text]))),
    CONSTRAINT operation_results_summary_check CHECK (((jsonb_typeof(result_summary) = 'object'::text) AND (octet_length((result_summary)::text) <= 32768)))
);


--
-- Name: operation_tombstones; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.operation_tombstones (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_kind text NOT NULL,
    state text NOT NULL,
    expected_resource_revision bigint,
    target_kind text,
    target_public_id text,
    candidate_relative_path text,
    result_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    result_code text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT operation_tombstones_expiry_check CHECK ((expires_at > completed_at)),
    CONSTRAINT operation_tombstones_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (knowledge_base_id <> ''::text) AND (octet_length(knowledge_base_id) <= 255))),
    CONSTRAINT operation_tombstones_kind_check CHECK ((operation_kind = 'deletion'::text)),
    CONSTRAINT operation_tombstones_result_check CHECK (((jsonb_typeof(result_summary) = 'object'::text) AND (octet_length((result_summary)::text) <= 32768))),
    CONSTRAINT operation_tombstones_state_check CHECK ((state = ANY (ARRAY['completed'::text, 'failed'::text])))
);


--
-- Name: operation_work_items; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.operation_work_items (
    operation_public_id text NOT NULL,
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
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operation_work_items_attempt_check CHECK ((attempt_count >= 0)),
    CONSTRAINT operation_work_items_checkpoint_check CHECK (((jsonb_typeof(checkpoint) = 'object'::text) AND (octet_length((checkpoint)::text) <= 32768))),
    CONSTRAINT operation_work_items_error_check CHECK (((safe_error_code IS NULL) OR (octet_length(safe_error_code) <= 128))),
    CONSTRAINT operation_work_items_kind_check CHECK ((work_kind = ANY (ARRAY['upload'::text, 'search'::text, 'mutation'::text, 'deletion'::text, 'maintenance'::text, 'reconciliation'::text, 'webhook'::text]))),
    CONSTRAINT operation_work_items_lease_check CHECK ((((state = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((state <> 'running'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT operation_work_items_revision_check CHECK ((operation_revision >= 0)),
    CONSTRAINT operation_work_items_search_provider_check CHECK ((((work_kind = ANY (ARRAY['search'::text, 'maintenance'::text])) AND (search_provider_kind = ANY (ARRAY['meilisearch'::text, 'opensearch'::text]))) OR ((work_kind <> ALL (ARRAY['search'::text, 'maintenance'::text])) AND (search_provider_kind IS NULL)))),
    CONSTRAINT operation_work_items_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'retry'::text])))
);


--
-- Name: operations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.operations (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_kind text NOT NULL,
    state text NOT NULL,
    expected_resource_revision bigint,
    target_kind text,
    target_public_id text,
    candidate_relative_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT operations_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (operation_kind <> ''::text) AND (octet_length(operation_kind) <= 128))),
    CONSTRAINT operations_path_check CHECK (((candidate_relative_path IS NULL) OR (octet_length(candidate_relative_path) <= 4096))),
    CONSTRAINT operations_revision_check CHECK (((expected_resource_revision IS NULL) OR (expected_resource_revision >= 0))),
    CONSTRAINT operations_state_check CHECK ((state = ANY (ARRAY['accepted'::text, 'validating'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'timed_out'::text, 'deleted'::text]))),
    CONSTRAINT operations_target_check CHECK ((((target_kind IS NULL) AND (target_public_id IS NULL)) OR ((target_kind = ANY (ARRAY['source_file'::text, 'source_directory'::text, 'knowledge_base'::text])) AND (target_public_id IS NOT NULL) AND (octet_length(target_public_id) <= 255)))),
    CONSTRAINT operations_terminal_time_check CHECK (((state = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'timed_out'::text, 'deleted'::text])) = (completed_at IS NOT NULL)))
);


--
-- Name: public_api_keys; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.public_api_keys (
    public_id text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    key_suffix text NOT NULL,
    label text NOT NULL,
    enabled boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT public_api_keys_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (key_hash <> ''::text) AND (octet_length(key_hash) <= 255) AND (key_prefix <> ''::text) AND (octet_length(key_prefix) <= 32) AND (key_suffix <> ''::text) AND (octet_length(key_suffix) <= 32) AND (label <> ''::text) AND (octet_length(label) <= 255))),
    CONSTRAINT public_api_keys_revocation_check CHECK (((enabled AND (revoked_at IS NULL)) OR ((NOT enabled) AND (revoked_at IS NOT NULL))))
);


--
-- Name: relationship_evaluations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.relationship_evaluations (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    target_revision_public_id text NOT NULL,
    evidence_fingerprint_sha256 text NOT NULL,
    model_configuration_public_id text NOT NULL,
    model_configuration_revision bigint NOT NULL,
    prompt_contract_sha256 text NOT NULL,
    decision text NOT NULL,
    confidence double precision NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT relationship_evaluations_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (source_revision_public_id <> ''::text) AND (octet_length(source_revision_public_id) <= 255) AND (target_revision_public_id <> ''::text) AND (octet_length(target_revision_public_id) <= 255) AND (source_revision_public_id <> target_revision_public_id) AND (evidence_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (model_configuration_public_id <> ''::text) AND (octet_length(model_configuration_public_id) <= 255) AND (model_configuration_revision > 0) AND (prompt_contract_sha256 ~ '^[0-9a-f]{64}$'::text) AND (decision = ANY (ARRAY['accepted'::text, 'rejected'::text])) AND (confidence >= (0)::double precision) AND (confidence <= (1)::double precision) AND (jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 16384)))
);


--
-- Name: reranker_configuration_revisions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.reranker_configuration_revisions (
    public_id text NOT NULL,
    configuration_public_id text CONSTRAINT reranker_configuration_revisio_configuration_public_id_not_null NOT NULL,
    revision_number bigint NOT NULL,
    authentication_mode text NOT NULL,
    base_url text NOT NULL,
    encrypted_api_key bytea,
    model_name text NOT NULL,
    timeout_ms integer NOT NULL,
    retry_count integer NOT NULL,
    minimum_interval_ms integer NOT NULL,
    concurrency integer NOT NULL,
    validation_status text NOT NULL,
    validation_fingerprint_sha256 text,
    safe_validation_error_code text,
    validated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reranker_configuration_revisions_authentication_check CHECK ((((authentication_mode = 'api_key'::text) AND (encrypted_api_key IS NOT NULL)) OR ((authentication_mode = 'none'::text) AND (encrypted_api_key IS NULL)))),
    CONSTRAINT reranker_configuration_revisions_bounds_check CHECK (((revision_number >= 1) AND ((timeout_ms >= 100) AND (timeout_ms <= 300000)) AND ((retry_count >= 0) AND (retry_count <= 10)) AND ((minimum_interval_ms >= 0) AND (minimum_interval_ms <= 60000)) AND ((concurrency >= 1) AND (concurrency <= 64)))),
    CONSTRAINT reranker_configuration_revisions_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (base_url <> ''::text) AND (octet_length(base_url) <= 2048) AND (model_name <> ''::text) AND (octet_length(model_name) <= 255))),
    CONSTRAINT reranker_configuration_revisions_validation_check CHECK (((validation_status = ANY (ARRAY['not_tested'::text, 'valid'::text, 'invalid'::text])) AND ((validation_fingerprint_sha256 IS NULL) OR (validation_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((safe_validation_error_code IS NULL) OR (octet_length(safe_validation_error_code) <= 128)) AND ((validation_status <> 'valid'::text) OR ((validation_fingerprint_sha256 IS NOT NULL) AND (validated_at IS NOT NULL) AND (safe_validation_error_code IS NULL)))))
);


--
-- Name: reranker_configurations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.reranker_configurations (
    public_id text NOT NULL,
    display_name text NOT NULL,
    lifecycle_status text NOT NULL,
    active_revision_public_id text,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reranker_configurations_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (display_name <> ''::text) AND (octet_length(display_name) <= 255))),
    CONSTRAINT reranker_configurations_lifecycle_check CHECK ((lifecycle_status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text]))),
    CONSTRAINT reranker_configurations_revision_check CHECK ((revision >= 1))
);


--
-- Name: runtime_generation; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.runtime_generation (
    singleton boolean NOT NULL,
    generation text NOT NULL,
    initialized_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_generation_singleton_check CHECK (singleton),
    CONSTRAINT runtime_generation_value_check CHECK ((generation = 'storage-vnext-v9-document-indexing-hybrid'::text))
);


--
-- Name: runtime_setting_current; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.runtime_setting_current (
    singleton boolean NOT NULL,
    revision_public_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_setting_current_singleton_check CHECK (singleton)
);


--
-- Name: runtime_setting_revisions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.runtime_setting_revisions (
    public_id text NOT NULL,
    checksum_sha256 text NOT NULL,
    settings_values jsonb NOT NULL,
    created_by_public_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_setting_revisions_checksum_check CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_setting_revisions_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND ((created_by_public_id IS NULL) OR (octet_length(created_by_public_id) <= 255)))),
    CONSTRAINT runtime_setting_revisions_values_check CHECK (((jsonb_typeof(settings_values) = 'object'::text) AND (octet_length((settings_values)::text) <= 65536)))
);


--
-- Name: search_document_owners; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.search_document_owners (
    knowledge_base_id text NOT NULL,
    search_projection_public_id text NOT NULL,
    provider_kind text NOT NULL,
    provider_document_id text NOT NULL,
    document_kind text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    document_checksum_sha256 text NOT NULL,
    state text NOT NULL,
    acknowledged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_document_owners_value_check CHECK (((provider_kind = ANY (ARRAY['meilisearch'::text, 'opensearch'::text])) AND (provider_document_id <> ''::text) AND (octet_length(provider_document_id) <= 1024) AND (document_kind = ANY (ARRAY['file'::text, 'segment'::text, 'graph_seed'::text, 'file_relationship'::text])) AND (document_checksum_sha256 ~ '^[0-9a-f]{64}$'::text) AND (state = ANY (ARRAY['staged'::text, 'active'::text, 'obsolete'::text])) AND (acknowledged_at IS NOT NULL)))
);


--
-- Name: search_projections; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.search_projections (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    provider_kind text NOT NULL,
    provider_index_uid text NOT NULL,
    schema_checksum_sha256 text NOT NULL,
    settings_checksum_sha256 text NOT NULL,
    active_contract_revision bigint DEFAULT 0 NOT NULL,
    document_count bigint DEFAULT 0 NOT NULL,
    state text NOT NULL,
    provider_operation_ref text,
    safe_error_code text,
    revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_projections_value_check CHECK (((provider_kind = ANY (ARRAY['meilisearch'::text, 'opensearch'::text])) AND (provider_index_uid <> ''::text) AND (octet_length(provider_index_uid) <= 1024) AND (schema_checksum_sha256 ~ '^[0-9a-f]{64}$'::text) AND (settings_checksum_sha256 ~ '^[0-9a-f]{64}$'::text) AND (active_contract_revision >= 0) AND (document_count >= 0) AND (state = ANY (ARRAY['preparing'::text, 'active'::text, 'failed'::text, 'retired'::text])) AND ((safe_error_code IS NULL) OR (octet_length(safe_error_code) <= 128)) AND (revision >= 0)))
);


--
-- Name: security_audit_events; Type: TABLE; Schema: focowiki; Owner: -
--

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
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT security_audit_events_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT security_audit_events_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND ((actor_public_id IS NULL) OR (octet_length(actor_public_id) <= 255)) AND (event_type <> ''::text) AND (octet_length(event_type) <= 128))),
    CONSTRAINT security_audit_events_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 16384))),
    CONSTRAINT security_audit_events_payload_check CHECK ((((reason_code IS NULL) OR (octet_length(reason_code) <= 128)) AND ((user_agent IS NULL) OR (octet_length(user_agent) <= 1024)))),
    CONSTRAINT security_audit_events_result_check CHECK ((result = ANY (ARRAY['success'::text, 'failure'::text, 'blocked'::text]))),
    CONSTRAINT security_audit_events_target_check CHECK ((((target_kind IS NULL) AND (target_public_id IS NULL)) OR ((target_kind IS NOT NULL) AND (target_public_id IS NOT NULL) AND (octet_length(target_kind) <= 128) AND (octet_length(target_public_id) <= 255))))
)
PARTITION BY RANGE (created_at);


--
-- Name: security_audit_events_2026_08; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.security_audit_events_2026_08 (
    public_id text CONSTRAINT security_audit_events_public_id_not_null NOT NULL,
    knowledge_base_id text,
    actor_public_id text,
    event_type text CONSTRAINT security_audit_events_event_type_not_null NOT NULL,
    target_kind text,
    target_public_id text,
    result text CONSTRAINT security_audit_events_result_not_null NOT NULL,
    reason_code text,
    source_ip inet,
    user_agent text,
    metadata jsonb DEFAULT '{}'::jsonb CONSTRAINT security_audit_events_metadata_not_null NOT NULL,
    created_at timestamp with time zone CONSTRAINT security_audit_events_created_at_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT security_audit_events_expires_at_not_null NOT NULL,
    CONSTRAINT security_audit_events_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT security_audit_events_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND ((actor_public_id IS NULL) OR (octet_length(actor_public_id) <= 255)) AND (event_type <> ''::text) AND (octet_length(event_type) <= 128))),
    CONSTRAINT security_audit_events_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 16384))),
    CONSTRAINT security_audit_events_payload_check CHECK ((((reason_code IS NULL) OR (octet_length(reason_code) <= 128)) AND ((user_agent IS NULL) OR (octet_length(user_agent) <= 1024)))),
    CONSTRAINT security_audit_events_result_check CHECK ((result = ANY (ARRAY['success'::text, 'failure'::text, 'blocked'::text]))),
    CONSTRAINT security_audit_events_target_check CHECK ((((target_kind IS NULL) AND (target_public_id IS NULL)) OR ((target_kind IS NOT NULL) AND (target_public_id IS NOT NULL) AND (octet_length(target_kind) <= 128) AND (octet_length(target_public_id) <= 255))))
);


--
-- Name: security_audit_events_2026_09; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.security_audit_events_2026_09 (
    public_id text CONSTRAINT security_audit_events_public_id_not_null NOT NULL,
    knowledge_base_id text,
    actor_public_id text,
    event_type text CONSTRAINT security_audit_events_event_type_not_null NOT NULL,
    target_kind text,
    target_public_id text,
    result text CONSTRAINT security_audit_events_result_not_null NOT NULL,
    reason_code text,
    source_ip inet,
    user_agent text,
    metadata jsonb DEFAULT '{}'::jsonb CONSTRAINT security_audit_events_metadata_not_null NOT NULL,
    created_at timestamp with time zone CONSTRAINT security_audit_events_created_at_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT security_audit_events_expires_at_not_null NOT NULL,
    CONSTRAINT security_audit_events_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT security_audit_events_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND ((actor_public_id IS NULL) OR (octet_length(actor_public_id) <= 255)) AND (event_type <> ''::text) AND (octet_length(event_type) <= 128))),
    CONSTRAINT security_audit_events_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 16384))),
    CONSTRAINT security_audit_events_payload_check CHECK ((((reason_code IS NULL) OR (octet_length(reason_code) <= 128)) AND ((user_agent IS NULL) OR (octet_length(user_agent) <= 1024)))),
    CONSTRAINT security_audit_events_result_check CHECK ((result = ANY (ARRAY['success'::text, 'failure'::text, 'blocked'::text]))),
    CONSTRAINT security_audit_events_target_check CHECK ((((target_kind IS NULL) AND (target_public_id IS NULL)) OR ((target_kind IS NOT NULL) AND (target_public_id IS NOT NULL) AND (octet_length(target_kind) <= 128) AND (octet_length(target_public_id) <= 255))))
);


--
-- Name: semantic_communities; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_communities (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text NOT NULL,
    public_id text NOT NULL,
    source_partition_key text NOT NULL,
    partition_key text NOT NULL,
    level integer NOT NULL,
    title text,
    revision bigint NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT semantic_communities_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (source_partition_key <> ''::text) AND (octet_length(source_partition_key) <= 1024) AND (partition_key <> ''::text) AND (octet_length(partition_key) <= 1024) AND ((level >= 0) AND (level <= 64)) AND ((title IS NULL) OR (octet_length(title) <= 1024)) AND (revision >= 0)))
);


--
-- Name: semantic_community_memberships; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_community_memberships (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_community_membersh_semantic_generation_public_not_null NOT NULL,
    community_public_id text NOT NULL,
    entity_public_id text NOT NULL,
    membership_weight double precision NOT NULL,
    CONSTRAINT semantic_community_memberships_weight_check CHECK (((membership_weight > (0)::double precision) AND (membership_weight <= (1)::double precision)))
);


--
-- Name: semantic_community_reports; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_community_reports (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_community_reports_semantic_generation_public__not_null NOT NULL,
    public_id text NOT NULL,
    community_public_id text NOT NULL,
    input_graph_version text NOT NULL,
    boundary_version text NOT NULL,
    summary text NOT NULL,
    report_checksum_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semantic_community_reports_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (input_graph_version <> ''::text) AND (octet_length(input_graph_version) <= 255) AND (boundary_version <> ''::text) AND (octet_length(boundary_version) <= 255) AND (summary <> ''::text) AND (octet_length(summary) <= 65536) AND (report_checksum_sha256 ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: semantic_dirty_partitions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_dirty_partitions (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_dirty_partitions_semantic_generation_public_i_not_null NOT NULL,
    public_id text NOT NULL,
    partition_key text NOT NULL,
    reason_kind text NOT NULL,
    input_version text NOT NULL,
    state text NOT NULL,
    attempt_count integer NOT NULL,
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    safe_error_code text,
    revision bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semantic_dirty_partitions_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (partition_key <> ''::text) AND (octet_length(partition_key) <= 1024) AND (reason_kind = ANY (ARRAY['entity_changed'::text, 'relationship_changed'::text, 'membership_changed'::text, 'deleted'::text, 'merge'::text, 'split'::text])) AND (input_version <> ''::text) AND (octet_length(input_version) <= 255) AND (state = ANY (ARRAY['dirty'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text])) AND ((attempt_count >= 0) AND (attempt_count <= 100)) AND (jsonb_typeof(checkpoint) = 'object'::text) AND (octet_length((checkpoint)::text) <= 32768) AND ((safe_error_code IS NULL) OR (octet_length(safe_error_code) <= 128)) AND (revision >= 0) AND (((state = 'processing'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((state <> 'processing'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))))
);


--
-- Name: semantic_embedding_artifact_refs; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_embedding_artifact_refs (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_embedding_artifact_semantic_generation_public_not_null NOT NULL,
    artifact_public_id text NOT NULL,
    semantic_owner_kind text NOT NULL,
    semantic_owner_public_id text CONSTRAINT semantic_embedding_artifact_r_semantic_owner_public_id_not_null NOT NULL,
    source_file_public_id text NOT NULL,
    source_excerpt text NOT NULL,
    CONSTRAINT semantic_embedding_artifact_refs_excerpt_check CHECK (((source_excerpt <> ''::text) AND (octet_length(source_excerpt) <= 4096))),
    CONSTRAINT semantic_embedding_artifact_refs_kind_check CHECK ((semantic_owner_kind = ANY (ARRAY['content'::text, 'entity'::text, 'relationship'::text, 'community'::text])))
);


--
-- Name: semantic_entities; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_entities (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text NOT NULL,
    public_id text NOT NULL,
    canonical_key text NOT NULL,
    entity_kind text NOT NULL,
    label text NOT NULL,
    description text,
    extraction_contract_version text NOT NULL,
    confidence double precision NOT NULL,
    provenance_kind text NOT NULL,
    revision bigint NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT semantic_entities_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (canonical_key <> ''::text) AND (octet_length(canonical_key) <= 1024) AND (entity_kind <> ''::text) AND (octet_length(entity_kind) <= 128) AND (label <> ''::text) AND (octet_length(label) <= 1024) AND ((description IS NULL) OR (octet_length(description) <= 8192)) AND (extraction_contract_version <> ''::text) AND (octet_length(extraction_contract_version) <= 128) AND ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)) AND (provenance_kind = ANY (ARRAY['deterministic'::text, 'model'::text])) AND (revision >= 0)))
);


--
-- Name: semantic_entity_aliases; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_entity_aliases (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text NOT NULL,
    entity_public_id text NOT NULL,
    normalized_alias text NOT NULL,
    display_alias text NOT NULL,
    CONSTRAINT semantic_entity_aliases_value_check CHECK (((normalized_alias <> ''::text) AND (octet_length(normalized_alias) <= 1024) AND (display_alias <> ''::text) AND (octet_length(display_alias) <= 1024)))
);


--
-- Name: semantic_entity_observations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_entity_observations (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_entity_observation_semantic_generation_public_not_null NOT NULL,
    entity_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    label text NOT NULL,
    description text,
    aliases jsonb NOT NULL,
    extraction_contract_version text CONSTRAINT semantic_entity_observation_extraction_contract_versio_not_null NOT NULL,
    confidence double precision NOT NULL,
    provenance_kind text NOT NULL,
    CONSTRAINT semantic_entity_observations_value_check CHECK (((label <> ''::text) AND (octet_length(label) <= 1024) AND ((description IS NULL) OR (octet_length(description) <= 8192)) AND (jsonb_typeof(aliases) = 'array'::text) AND (jsonb_array_length(aliases) <= 128) AND (octet_length((aliases)::text) <= 131072) AND (extraction_contract_version <> ''::text) AND (octet_length(extraction_contract_version) <= 128) AND ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)) AND (provenance_kind = ANY (ARRAY['deterministic'::text, 'model'::text]))))
);


--
-- Name: semantic_entity_partitions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_entity_partitions (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_entity_partitions_semantic_generation_public__not_null NOT NULL,
    entity_public_id text NOT NULL,
    partition_key text NOT NULL,
    input_version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semantic_entity_partitions_value_check CHECK (((partition_key <> ''::text) AND (octet_length(partition_key) <= 1024) AND (input_version <> ''::text) AND (octet_length(input_version) <= 255)))
);


--
-- Name: semantic_evidence; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_evidence (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text NOT NULL,
    public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    logical_path text NOT NULL,
    start_offset bigint NOT NULL,
    end_offset bigint NOT NULL,
    excerpt_checksum_sha256 text NOT NULL,
    extraction_contract_version text NOT NULL,
    CONSTRAINT semantic_evidence_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (logical_path <> ''::text) AND (octet_length(logical_path) <= 4096) AND (start_offset >= 0) AND (end_offset >= start_offset) AND (excerpt_checksum_sha256 ~ '^[0-9a-f]{64}$'::text) AND (extraction_contract_version <> ''::text) AND (octet_length(extraction_contract_version) <= 128)))
);


--
-- Name: semantic_generations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_generations (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_public_id text NOT NULL,
    expected_predecessor_public_id text,
    generation_role text NOT NULL,
    state text NOT NULL,
    generation_model_configuration_public_id text CONSTRAINT semantic_generations_generation_model_configuration_pu_not_null NOT NULL,
    generation_model_configuration_revision bigint CONSTRAINT semantic_generations_generation_model_configuration_re_not_null NOT NULL,
    extraction_contract_version text NOT NULL,
    graph_schema_version text NOT NULL,
    prompt_contract_version text NOT NULL,
    contract_fingerprint_sha256 text NOT NULL,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT semantic_generations_active_check CHECK ((((generation_role = 'active'::text) AND (state = 'active'::text) AND (activated_at IS NOT NULL)) OR ((generation_role = 'candidate'::text) AND (state <> 'active'::text) AND (activated_at IS NULL)) OR ((generation_role = 'historical'::text) AND (state = 'superseded'::text) AND (activated_at IS NOT NULL)))),
    CONSTRAINT semantic_generations_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (generation_model_configuration_public_id <> ''::text) AND (octet_length(generation_model_configuration_public_id) <= 255) AND (generation_model_configuration_revision >= 1) AND (extraction_contract_version <> ''::text) AND (octet_length(extraction_contract_version) <= 128) AND (graph_schema_version <> ''::text) AND (octet_length(graph_schema_version) <= 128) AND (prompt_contract_version <> ''::text) AND (octet_length(prompt_contract_version) <= 128) AND (contract_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT semantic_generations_revision_check CHECK ((revision >= 0)),
    CONSTRAINT semantic_generations_role_check CHECK ((generation_role = ANY (ARRAY['candidate'::text, 'active'::text, 'historical'::text]))),
    CONSTRAINT semantic_generations_state_check CHECK ((state = ANY (ARRAY['building'::text, 'validating'::text, 'ready'::text, 'active'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'cleanup_failed'::text])))
);


--
-- Name: semantic_mentions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_mentions (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text NOT NULL,
    public_id text NOT NULL,
    entity_public_id text NOT NULL,
    evidence_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    mention_text text NOT NULL,
    confidence double precision NOT NULL,
    CONSTRAINT semantic_mentions_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (mention_text <> ''::text) AND (octet_length(mention_text) <= 2048) AND ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))))
);


--
-- Name: semantic_projection_contracts; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_projection_contracts (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_projection_contrac_semantic_generation_public_not_null NOT NULL,
    embedding_configuration_revision_public_id text CONSTRAINT semantic_projection_contrac_embedding_configuration_re_not_null NOT NULL,
    embedding_query_policy_revision_public_id text CONSTRAINT semantic_projection_contrac_embedding_query_policy_rev_not_null NOT NULL,
    minimum_vector_relevance double precision NOT NULL,
    search_provider_kind text NOT NULL,
    resolved_dimension integer NOT NULL,
    normalization text NOT NULL,
    artifact_schema_version text NOT NULL,
    vector_schema_version text NOT NULL,
    mapping_fingerprint_sha256 text CONSTRAINT semantic_projection_contrac_mapping_fingerprint_sha256_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semantic_projection_contracts_contract_check CHECK (((search_provider_kind = ANY (ARRAY['meilisearch'::text, 'opensearch'::text])) AND ((resolved_dimension >= 1) AND (resolved_dimension <= 65536)) AND (minimum_vector_relevance >= (0)::double precision) AND (minimum_vector_relevance <= (1)::double precision) AND (normalization = ANY (ARRAY['none'::text, 'l2'::text])) AND (artifact_schema_version <> ''::text) AND (octet_length(artifact_schema_version) <= 128) AND (vector_schema_version <> ''::text) AND (octet_length(vector_schema_version) <= 128) AND (mapping_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: semantic_relationship_evidence; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_relationship_evidence (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_relationship_evide_semantic_generation_public_not_null NOT NULL,
    relationship_public_id text NOT NULL,
    evidence_public_id text NOT NULL
);


--
-- Name: semantic_relationship_observations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_relationship_observations (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_relationship_obser_semantic_generation_public_not_null NOT NULL,
    relationship_public_id text CONSTRAINT semantic_relationship_observati_relationship_public_id_not_null NOT NULL,
    source_file_public_id text CONSTRAINT semantic_relationship_observatio_source_file_public_id_not_null NOT NULL,
    source_revision_public_id text CONSTRAINT semantic_relationship_observ_source_revision_public_id_not_null NOT NULL,
    description text,
    confidence double precision NOT NULL,
    provenance_kind text NOT NULL,
    CONSTRAINT semantic_relationship_observations_value_check CHECK ((((description IS NULL) OR (octet_length(description) <= 8192)) AND ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)) AND (provenance_kind = ANY (ARRAY['deterministic'::text, 'model'::text]))))
);


--
-- Name: semantic_relationships; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_relationships (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text NOT NULL,
    public_id text NOT NULL,
    from_entity_public_id text NOT NULL,
    to_entity_public_id text NOT NULL,
    relationship_kind text NOT NULL,
    description text,
    confidence double precision NOT NULL,
    provenance_kind text NOT NULL,
    revision bigint NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT semantic_relationships_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (from_entity_public_id <> to_entity_public_id) AND (relationship_kind <> ''::text) AND (octet_length(relationship_kind) <= 128) AND ((description IS NULL) OR (octet_length(description) <= 8192)) AND ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)) AND (provenance_kind = ANY (ARRAY['deterministic'::text, 'model'::text])) AND (revision >= 0)))
);


--
-- Name: semantic_reverse_references; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_reverse_references (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_reverse_references_semantic_generation_public_not_null NOT NULL,
    target_kind text NOT NULL,
    target_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    evidence_public_id text NOT NULL,
    CONSTRAINT semantic_reverse_references_kind_check CHECK ((target_kind = ANY (ARRAY['entity'::text, 'relationship'::text, 'file'::text])))
);


--
-- Name: semantic_source_reconciliations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_source_reconciliations (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_source_reconciliat_semantic_generation_public_not_null NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text CONSTRAINT semantic_source_reconciliati_source_revision_public_id_not_null NOT NULL,
    extraction_contract_version text CONSTRAINT semantic_source_reconciliat_extraction_contract_versio_not_null NOT NULL,
    canonical_input_sha256 text NOT NULL,
    skeleton_policy_version text CONSTRAINT semantic_source_reconciliation_skeleton_policy_version_not_null NOT NULL,
    skeleton_selected boolean NOT NULL,
    source_chunk_count integer NOT NULL,
    selected_chunk_count integer NOT NULL,
    selection_reasons jsonb NOT NULL,
    selection_decision_sha256 text CONSTRAINT semantic_source_reconciliati_selection_decision_sha256_not_null NOT NULL,
    entity_count integer NOT NULL,
    relationship_count integer NOT NULL,
    evidence_count integer NOT NULL,
    affected_closure jsonb NOT NULL,
    reconciled_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semantic_source_reconciliations_counts_check CHECK (((extraction_contract_version <> ''::text) AND (octet_length(extraction_contract_version) <= 255) AND (canonical_input_sha256 ~ '^[0-9a-f]{64}$'::text) AND (skeleton_policy_version <> ''::text) AND (octet_length(skeleton_policy_version) <= 255) AND ((source_chunk_count >= 1) AND (source_chunk_count <= 32)) AND ((selected_chunk_count >= 0) AND (selected_chunk_count <= LEAST(8, source_chunk_count))) AND (skeleton_selected = (selected_chunk_count > 0)) AND (jsonb_typeof(selection_reasons) = 'array'::text) AND (jsonb_array_length(selection_reasons) <= 8) AND (octet_length((selection_reasons)::text) <= 1024) AND (selection_decision_sha256 ~ '^[0-9a-f]{64}$'::text) AND ((entity_count >= 0) AND (entity_count <= 2000)) AND ((relationship_count >= 0) AND (relationship_count <= 4000)) AND ((evidence_count >= 0) AND (evidence_count <= 4000)) AND (jsonb_typeof(affected_closure) = 'object'::text) AND (octet_length((affected_closure)::text) <= 4194304)))
);


--
-- Name: semantic_vector_documents; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.semantic_vector_documents (
    knowledge_base_id text NOT NULL,
    semantic_generation_public_id text CONSTRAINT semantic_vector_documents_semantic_generation_public_i_not_null NOT NULL,
    public_id text NOT NULL,
    projection_contract_public_id text CONSTRAINT semantic_vector_documents_projection_contract_public_i_not_null NOT NULL,
    embedding_configuration_revision_public_id text CONSTRAINT semantic_vector_documents_embedding_configuration_revi_not_null NOT NULL,
    artifact_public_id text NOT NULL,
    vector_family text NOT NULL,
    owner_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    evidence_target_path text NOT NULL,
    dimension integer NOT NULL,
    provider_document_id text NOT NULL,
    state text NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT semantic_vector_documents_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (vector_family = ANY (ARRAY['content'::text, 'entity'::text, 'relationship'::text, 'community'::text])) AND (owner_public_id <> ''::text) AND (octet_length(owner_public_id) <= 255) AND ((dimension >= 1) AND (dimension <= 65536)) AND (provider_document_id <> ''::text) AND (octet_length(provider_document_id) <= 1024) AND (evidence_target_path <> ''::text) AND (octet_length(evidence_target_path) <= 4096) AND (state = ANY (ARRAY['candidate'::text, 'active'::text, 'failed'::text, 'deleted'::text]))))
);


--
-- Name: source_directories; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_directories (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    parent_public_id text,
    logical_path text NOT NULL,
    normalized_path text NOT NULL,
    title text NOT NULL,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT source_directories_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (knowledge_base_id <> ''::text) AND (octet_length(knowledge_base_id) <= 255))),
    CONSTRAINT source_directories_parent_check CHECK ((parent_public_id IS DISTINCT FROM public_id)),
    CONSTRAINT source_directories_path_check CHECK (((logical_path <> ''::text) AND (octet_length(logical_path) <= 4096) AND (normalized_path <> ''::text) AND (octet_length(normalized_path) <= 4096))),
    CONSTRAINT source_directories_revision_check CHECK ((revision >= 0)),
    CONSTRAINT source_directories_title_check CHECK (((title <> ''::text) AND (octet_length(title) <= 1024)))
);


--
-- Name: source_file_active_revisions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_file_active_revisions (
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    current_source_revision_public_id text CONSTRAINT source_file_active_revision_current_source_revision_pu_not_null NOT NULL,
    active_source_revision_public_id text,
    activation_sequence bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_active_revisions_value_check CHECK (((activation_sequence >= 0) AND (current_source_revision_public_id <> ''::text) AND (octet_length(current_source_revision_public_id) <= 255) AND ((active_source_revision_public_id IS NULL) OR ((active_source_revision_public_id <> ''::text) AND (octet_length(active_source_revision_public_id) <= 255)))))
);


--
-- Name: source_file_identity_keys; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_file_identity_keys (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    identity_kind text NOT NULL,
    normalized_identity_key text NOT NULL,
    state text NOT NULL,
    activation_revision bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_identity_keys_value_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (identity_kind = ANY (ARRAY['path'::text, 'title'::text, 'alias'::text])) AND (normalized_identity_key <> ''::text) AND (octet_length(normalized_identity_key) <= 2048) AND (state = ANY (ARRAY['staged'::text, 'active'::text, 'obsolete'::text])) AND (((state = 'staged'::text) AND (activation_revision IS NULL)) OR ((state = ANY (ARRAY['active'::text, 'obsolete'::text])) AND (activation_revision >= 0)))))
);


--
-- Name: source_files; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_files (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    directory_public_id text,
    logical_path text NOT NULL,
    normalized_path text NOT NULL,
    title text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT source_files_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (knowledge_base_id <> ''::text) AND (octet_length(knowledge_base_id) <= 255))),
    CONSTRAINT source_files_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 8192))),
    CONSTRAINT source_files_path_check CHECK (((logical_path <> ''::text) AND (octet_length(logical_path) <= 4096) AND (normalized_path <> ''::text) AND (octet_length(normalized_path) <= 4096))),
    CONSTRAINT source_files_revision_check CHECK ((revision >= 0)),
    CONSTRAINT source_files_title_check CHECK (((title <> ''::text) AND (octet_length(title) <= 1024)))
);


--
-- Name: source_revision_presentations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_revision_presentations (
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text CONSTRAINT source_revision_presentation_source_revision_public_id_not_null NOT NULL,
    directory_public_id text,
    logical_path text NOT NULL,
    normalized_path text NOT NULL,
    title text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_suggestions jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_revision_presentations_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 8192))),
    CONSTRAINT source_revision_presentations_model_suggestions_check CHECK (((model_suggestions IS NULL) OR ((jsonb_typeof(model_suggestions) = 'object'::text) AND (octet_length((model_suggestions)::text) <= 65536)))),
    CONSTRAINT source_revision_presentations_path_check CHECK (((logical_path <> ''::text) AND (octet_length(logical_path) <= 4096) AND (normalized_path <> ''::text) AND (octet_length(normalized_path) <= 4096))),
    CONSTRAINT source_revision_presentations_title_check CHECK (((title <> ''::text) AND (octet_length(title) <= 1024)))
);


--
-- Name: source_revisions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.source_revisions (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    object_id text NOT NULL,
    checksum_sha256 text NOT NULL,
    byte_count bigint NOT NULL,
    content_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT source_revisions_byte_count_nonnegative_check CHECK ((byte_count >= 0)),
    CONSTRAINT source_revisions_checksum_check CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_revisions_content_type_check CHECK (((content_type <> ''::text) AND (octet_length(content_type) <= 255))),
    CONSTRAINT source_revisions_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (object_id <> ''::text) AND (octet_length(object_id) <= 255)))
);


--
-- Name: unresolved_file_references; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.unresolved_file_references (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    reference_kind text NOT NULL,
    raw_target text NOT NULL,
    normalized_target_key text NOT NULL,
    evidence_checksum_sha256 text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolution_state text NOT NULL,
    resolved_target_source_file_public_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: upload_entries; Type: TABLE; Schema: focowiki; Owner: -
--

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
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_entries_byte_count_nonnegative_check CHECK ((byte_count >= 0)),
    CONSTRAINT upload_entries_checksum_check CHECK (((checksum_sha256 IS NULL) OR (checksum_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT upload_entries_content_type_check CHECK ((content_type = 'text/markdown; charset=utf-8'::text)),
    CONSTRAINT upload_entries_identity_check CHECK (((entry_public_id <> ''::text) AND (octet_length(entry_public_id) <= 255) AND (source_file_public_id <> ''::text) AND (octet_length(source_file_public_id) <= 255) AND (knowledge_base_id <> ''::text) AND (octet_length(knowledge_base_id) <= 255))),
    CONSTRAINT upload_entries_object_state_check CHECK ((((state = 'pending'::text) AND (object_id IS NULL)) OR ((state <> 'pending'::text) AND (object_id IS NOT NULL) AND (checksum_sha256 IS NOT NULL)))),
    CONSTRAINT upload_entries_path_check CHECK (((logical_path <> ''::text) AND (octet_length(logical_path) <= 4096) AND (normalized_path <> ''::text) AND (octet_length(normalized_path) <= 4096))),
    CONSTRAINT upload_entries_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'uploaded'::text, 'verified'::text])))
);


--
-- Name: upload_path_reservations; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.upload_path_reservations (
    knowledge_base_id text NOT NULL,
    normalized_path text NOT NULL,
    upload_session_public_id text NOT NULL,
    upload_entry_public_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_path_reservations_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT upload_path_reservations_path_check CHECK (((normalized_path <> ''::text) AND (octet_length(normalized_path) <= 4096)))
);


--
-- Name: upload_sessions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.upload_sessions (
    public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    operation_public_id text NOT NULL,
    manifest_fingerprint text,
    state text NOT NULL,
    expected_entry_count bigint NOT NULL,
    expected_byte_count bigint NOT NULL,
    received_entry_count bigint NOT NULL,
    received_byte_count bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_sessions_byte_count_nonnegative_check CHECK (((expected_byte_count >= 0) AND (received_byte_count >= 0) AND (received_byte_count <= expected_byte_count))),
    CONSTRAINT upload_sessions_count_nonnegative_check CHECK (((expected_entry_count >= 0) AND (received_entry_count >= 0) AND (received_entry_count <= expected_entry_count))),
    CONSTRAINT upload_sessions_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT upload_sessions_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255))),
    CONSTRAINT upload_sessions_manifest_check CHECK ((((state = 'draft'::text) AND (manifest_fingerprint IS NULL)) OR ((state <> 'draft'::text) AND (manifest_fingerprint ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT upload_sessions_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'uploading'::text, 'finalizing'::text])))
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.webhook_deliveries (
    public_id text NOT NULL,
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_deliveries_attempt_check CHECK ((attempt_count >= 0)),
    CONSTRAINT webhook_deliveries_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT webhook_deliveries_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (event_public_id <> ''::text) AND (octet_length(event_public_id) <= 255) AND (event_type <> ''::text) AND (octet_length(event_type) <= 128))),
    CONSTRAINT webhook_deliveries_lease_check CHECK ((((state = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((state <> 'running'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT webhook_deliveries_payload_check CHECK (((jsonb_typeof(event_payload) = 'object'::text) AND (octet_length((event_payload)::text) <= 32768) AND ((provider_correlation_id IS NULL) OR (octet_length(provider_correlation_id) <= 255)) AND ((safe_error_code IS NULL) OR (octet_length(safe_error_code) <= 128)) AND ((http_status IS NULL) OR ((http_status >= 100) AND (http_status <= 599))))),
    CONSTRAINT webhook_deliveries_redelivery_check CHECK ((redelivery_of_public_id IS DISTINCT FROM public_id)),
    CONSTRAINT webhook_deliveries_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'retry'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT webhook_deliveries_terminal_check CHECK ((((state = ANY (ARRAY['completed'::text, 'failed'::text])) AND (completed_at IS NOT NULL) AND (next_attempt_at IS NULL)) OR ((state = ANY (ARRAY['queued'::text, 'retry'::text])) AND (completed_at IS NULL) AND (next_attempt_at IS NOT NULL)) OR ((state = 'running'::text) AND (completed_at IS NULL))))
);


--
-- Name: webhook_subscriptions; Type: TABLE; Schema: focowiki; Owner: -
--

CREATE TABLE focowiki.webhook_subscriptions (
    public_id text NOT NULL,
    knowledge_base_id text,
    label text NOT NULL,
    endpoint_url text NOT NULL,
    secret_reference text NOT NULL,
    idempotency_key text,
    request_hash text,
    event_types jsonb NOT NULL,
    enabled boolean NOT NULL,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_subscriptions_event_types_check CHECK (((jsonb_typeof(event_types) = 'array'::text) AND (octet_length((event_types)::text) <= 8192))),
    CONSTRAINT webhook_subscriptions_idempotency_check CHECK (((idempotency_key IS NULL AND request_hash IS NULL) OR (idempotency_key IS NOT NULL AND idempotency_key <> ''::text AND octet_length(idempotency_key) <= 255 AND request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT webhook_subscriptions_identity_check CHECK (((public_id <> ''::text) AND (octet_length(public_id) <= 255) AND (label <> ''::text) AND (octet_length(label) <= 255) AND (endpoint_url <> ''::text) AND (octet_length(endpoint_url) <= 4096) AND (secret_reference <> ''::text) AND (octet_length(secret_reference) <= 1024))),
    CONSTRAINT webhook_subscriptions_revision_check CHECK ((revision >= 0))
);


--
-- Name: diagnostic_events_2026_08; Type: TABLE ATTACH; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.diagnostic_events ATTACH PARTITION focowiki.diagnostic_events_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: diagnostic_events_2026_09; Type: TABLE ATTACH; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.diagnostic_events ATTACH PARTITION focowiki.diagnostic_events_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: security_audit_events_2026_08; Type: TABLE ATTACH; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.security_audit_events ATTACH PARTITION focowiki.security_audit_events_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: security_audit_events_2026_09; Type: TABLE ATTACH; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.security_audit_events ATTACH PARTITION focowiki.security_audit_events_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: cleanup_actions cleanup_actions_idempotency_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.cleanup_actions
    ADD CONSTRAINT cleanup_actions_idempotency_key UNIQUE NULLS NOT DISTINCT (knowledge_base_id, operation_public_id, document_job_public_id, action_kind, cleanup_plane, search_provider_kind, resource_kind, resource_public_id, idempotency_key);


--
-- Name: cleanup_actions cleanup_actions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.cleanup_actions
    ADD CONSTRAINT cleanup_actions_pkey PRIMARY KEY (public_id);


--
-- Name: diagnostic_events diagnostic_events_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.diagnostic_events
    ADD CONSTRAINT diagnostic_events_pkey PRIMARY KEY (created_at, public_id);


--
-- Name: diagnostic_events_2026_08 diagnostic_events_2026_08_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.diagnostic_events_2026_08
    ADD CONSTRAINT diagnostic_events_2026_08_pkey PRIMARY KEY (created_at, public_id);


--
-- Name: diagnostic_events_2026_09 diagnostic_events_2026_09_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.diagnostic_events_2026_09
    ADD CONSTRAINT diagnostic_events_2026_09_pkey PRIMARY KEY (created_at, public_id);


--
-- Name: document_model_analysis_results document_model_analysis_results_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_analysis_results
    ADD CONSTRAINT document_model_analysis_results_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, model_configuration_public_id, model_configuration_revision, prompt_contract_sha256, model_input_sha256);


--
-- Name: document_model_analysis_results document_model_analysis_results_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_analysis_results
    ADD CONSTRAINT document_model_analysis_results_pkey PRIMARY KEY (public_id);


--
-- Name: document_model_layer_executions document_model_layer_executions_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_layer_executions
    ADD CONSTRAINT document_model_layer_executions_identity_key UNIQUE (knowledge_base_id, document_job_public_id, layer, execution_identity_sha256);


--
-- Name: document_model_layer_executions document_model_layer_executions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_layer_executions
    ADD CONSTRAINT document_model_layer_executions_pkey PRIMARY KEY (public_id);


--
-- Name: document_processing_jobs document_processing_jobs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_pkey PRIMARY KEY (public_id);


--
-- Name: document_processing_jobs document_processing_jobs_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: document_processing_jobs document_processing_jobs_source_revision_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_source_revision_key UNIQUE (knowledge_base_id, source_revision_public_id);


--
-- Name: embedding_artifact_owners embedding_artifact_owners_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifact_owners
    ADD CONSTRAINT embedding_artifact_owners_pkey PRIMARY KEY (artifact_public_id, semantic_generation_public_id, owner_kind, owner_public_id);


--
-- Name: embedding_artifacts embedding_artifacts_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifacts
    ADD CONSTRAINT embedding_artifacts_identity_key UNIQUE NULLS NOT DISTINCT (knowledge_base_id, owner_kind, owner_public_id, source_revision_public_id, canonical_input_sha256, input_kind, embedding_configuration_revision_public_id, normalization, dimension, artifact_schema_version);


--
-- Name: embedding_artifacts embedding_artifacts_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifacts
    ADD CONSTRAINT embedding_artifacts_pkey PRIMARY KEY (public_id);


--
-- Name: embedding_configuration_revisions embedding_configuration_revisions_configuration_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_configuration_revisions
    ADD CONSTRAINT embedding_configuration_revisions_configuration_key UNIQUE (configuration_public_id, revision_number);


--
-- Name: embedding_configuration_revisions embedding_configuration_revisions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_configuration_revisions
    ADD CONSTRAINT embedding_configuration_revisions_pkey PRIMARY KEY (public_id);


--
-- Name: embedding_configuration_revisions embedding_configuration_revisions_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_configuration_revisions
    ADD CONSTRAINT embedding_configuration_revisions_scope_key UNIQUE (configuration_public_id, public_id);


--
-- Name: embedding_configurations embedding_configurations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_configurations
    ADD CONSTRAINT embedding_configurations_pkey PRIMARY KEY (public_id);


--
-- Name: generated_directory_leaf_entries generated_directory_leaf_entries_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_directory_leaf_entries
    ADD CONSTRAINT generated_directory_leaf_entries_identity_key UNIQUE (knowledge_base_id, directory_path, entry_public_id);


--
-- Name: generated_directory_leaf_entries generated_directory_leaf_entries_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_directory_leaf_entries
    ADD CONSTRAINT generated_directory_leaf_entries_pkey PRIMARY KEY (knowledge_base_id, directory_path, leaf_public_id, entry_public_id);


--
-- Name: generated_directory_leaves generated_directory_leaves_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_directory_leaves
    ADD CONSTRAINT generated_directory_leaves_identity_key PRIMARY KEY (knowledge_base_id, directory_path, leaf_public_id);


--
-- Name: generated_page_candidates generated_page_candidates_operation_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_operation_path_key UNIQUE (knowledge_base_id, owner_operation_public_id, base_activation_revision, normalized_path, checksum_sha256);


--
-- Name: generated_page_candidates generated_page_candidates_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_pkey PRIMARY KEY (public_id);


--
-- Name: generated_page_candidates generated_page_candidates_revision_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_revision_path_key UNIQUE (knowledge_base_id, source_revision_public_id, base_activation_revision, normalized_path, checksum_sha256);


--
-- Name: generated_page_candidates generated_page_candidates_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: generated_page_heads generated_page_heads_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_heads
    ADD CONSTRAINT generated_page_heads_path_key UNIQUE (knowledge_base_id, logical_path);


--
-- Name: generated_page_heads generated_page_heads_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_heads
    ADD CONSTRAINT generated_page_heads_pkey PRIMARY KEY (knowledge_base_id, normalized_path);


--
-- Name: graph_edges graph_edges_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_edges
    ADD CONSTRAINT graph_edges_pkey PRIMARY KEY (public_id);


--
-- Name: graph_edges graph_edges_relationship_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_edges
    ADD CONSTRAINT graph_edges_relationship_key UNIQUE (knowledge_base_id, from_node_public_id, to_node_public_id, relation);


--
-- Name: graph_edges graph_edges_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_edges
    ADD CONSTRAINT graph_edges_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: graph_evidence_refs graph_evidence_refs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_evidence_refs
    ADD CONSTRAINT graph_evidence_refs_pkey PRIMARY KEY (public_id);


--
-- Name: graph_nodes graph_nodes_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_nodes
    ADD CONSTRAINT graph_nodes_pkey PRIMARY KEY (public_id);


--
-- Name: graph_nodes graph_nodes_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_nodes
    ADD CONSTRAINT graph_nodes_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: graph_nodes graph_nodes_source_file_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_nodes
    ADD CONSTRAINT graph_nodes_source_file_key UNIQUE (knowledge_base_id, source_file_public_id);


--
-- Name: knowledge_bases knowledge_bases_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.knowledge_bases
    ADD CONSTRAINT knowledge_bases_pkey PRIMARY KEY (public_id);


--
-- Name: model_config_revisions model_config_revisions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_config_revisions
    ADD CONSTRAINT model_config_revisions_pkey PRIMARY KEY (configuration_public_id, revision_number);


--
-- Name: model_configs model_configs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_configs
    ADD CONSTRAINT model_configs_pkey PRIMARY KEY (public_id);


--
-- Name: mutation_path_reservations mutation_path_reservations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.mutation_path_reservations
    ADD CONSTRAINT mutation_path_reservations_pkey PRIMARY KEY (knowledge_base_id, normalized_path);


--
-- Name: object_owners object_owners_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_identity_key UNIQUE (object_id, owner_kind, owner_public_id);


--
-- Name: object_owners object_owners_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_pkey PRIMARY KEY (public_id);


--
-- Name: object_registrations object_registrations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_registrations
    ADD CONSTRAINT object_registrations_pkey PRIMARY KEY (object_id);


--
-- Name: object_registrations object_registrations_storage_key_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_registrations
    ADD CONSTRAINT object_registrations_storage_key_key UNIQUE (storage_key);


--
-- Name: object_registrations object_registrations_write_attempt_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_registrations
    ADD CONSTRAINT object_registrations_write_attempt_key UNIQUE (write_attempt_public_id);


--
-- Name: operation_idempotency operation_idempotency_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_idempotency
    ADD CONSTRAINT operation_idempotency_key UNIQUE (knowledge_base_id, idempotency_key);


--
-- Name: operation_idempotency operation_idempotency_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_idempotency
    ADD CONSTRAINT operation_idempotency_pkey PRIMARY KEY (public_id);


--
-- Name: operation_results operation_results_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_results
    ADD CONSTRAINT operation_results_pkey PRIMARY KEY (public_id);


--
-- Name: operation_tombstones operation_tombstones_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_tombstones
    ADD CONSTRAINT operation_tombstones_pkey PRIMARY KEY (public_id);


--
-- Name: operation_work_items operation_work_items_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_work_items
    ADD CONSTRAINT operation_work_items_pkey PRIMARY KEY (operation_public_id);


--
-- Name: operations operations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operations
    ADD CONSTRAINT operations_pkey PRIMARY KEY (public_id);


--
-- Name: operations operations_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operations
    ADD CONSTRAINT operations_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: public_api_keys public_api_keys_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.public_api_keys
    ADD CONSTRAINT public_api_keys_pkey PRIMARY KEY (public_id);


--
-- Name: relationship_evaluations relationship_evaluations_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.relationship_evaluations
    ADD CONSTRAINT relationship_evaluations_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, target_revision_public_id, evidence_fingerprint_sha256, model_configuration_public_id, model_configuration_revision, prompt_contract_sha256);


--
-- Name: relationship_evaluations relationship_evaluations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.relationship_evaluations
    ADD CONSTRAINT relationship_evaluations_pkey PRIMARY KEY (public_id);


--
-- Name: reranker_configuration_revisions reranker_configuration_revisions_configuration_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.reranker_configuration_revisions
    ADD CONSTRAINT reranker_configuration_revisions_configuration_key UNIQUE (configuration_public_id, revision_number);


--
-- Name: reranker_configuration_revisions reranker_configuration_revisions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.reranker_configuration_revisions
    ADD CONSTRAINT reranker_configuration_revisions_pkey PRIMARY KEY (public_id);


--
-- Name: reranker_configuration_revisions reranker_configuration_revisions_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.reranker_configuration_revisions
    ADD CONSTRAINT reranker_configuration_revisions_scope_key UNIQUE (configuration_public_id, public_id);


--
-- Name: reranker_configurations reranker_configurations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.reranker_configurations
    ADD CONSTRAINT reranker_configurations_pkey PRIMARY KEY (public_id);


--
-- Name: runtime_generation runtime_generation_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_pkey PRIMARY KEY (singleton);


--
-- Name: runtime_setting_current runtime_setting_current_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.runtime_setting_current
    ADD CONSTRAINT runtime_setting_current_pkey PRIMARY KEY (singleton);


--
-- Name: runtime_setting_revisions runtime_setting_revisions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.runtime_setting_revisions
    ADD CONSTRAINT runtime_setting_revisions_pkey PRIMARY KEY (public_id);


--
-- Name: search_document_owners search_document_owners_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_document_owners
    ADD CONSTRAINT search_document_owners_pkey PRIMARY KEY (knowledge_base_id, provider_kind, provider_document_id, source_revision_public_id);


--
-- Name: search_projections search_projections_knowledge_base_provider_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_projections
    ADD CONSTRAINT search_projections_knowledge_base_provider_key UNIQUE (knowledge_base_id, provider_kind);


--
-- Name: search_projections search_projections_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_projections
    ADD CONSTRAINT search_projections_pkey PRIMARY KEY (public_id);


--
-- Name: search_projections search_projections_provider_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_projections
    ADD CONSTRAINT search_projections_provider_key UNIQUE (provider_kind, provider_index_uid);


--
-- Name: search_projections search_projections_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_projections
    ADD CONSTRAINT search_projections_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: security_audit_events security_audit_events_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.security_audit_events
    ADD CONSTRAINT security_audit_events_pkey PRIMARY KEY (created_at, public_id);


--
-- Name: security_audit_events_2026_08 security_audit_events_2026_08_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.security_audit_events_2026_08
    ADD CONSTRAINT security_audit_events_2026_08_pkey PRIMARY KEY (created_at, public_id);


--
-- Name: security_audit_events_2026_09 security_audit_events_2026_09_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.security_audit_events_2026_09
    ADD CONSTRAINT security_audit_events_2026_09_pkey PRIMARY KEY (created_at, public_id);


--
-- Name: semantic_communities semantic_communities_partition_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_communities
    ADD CONSTRAINT semantic_communities_partition_key UNIQUE (semantic_generation_public_id, partition_key);


--
-- Name: semantic_communities semantic_communities_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_communities
    ADD CONSTRAINT semantic_communities_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: semantic_communities semantic_communities_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_communities
    ADD CONSTRAINT semantic_communities_scope_key UNIQUE (knowledge_base_id, semantic_generation_public_id, public_id);


--
-- Name: semantic_community_memberships semantic_community_memberships_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_community_memberships
    ADD CONSTRAINT semantic_community_memberships_pkey PRIMARY KEY (semantic_generation_public_id, community_public_id, entity_public_id);


--
-- Name: semantic_community_reports semantic_community_reports_community_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_community_reports
    ADD CONSTRAINT semantic_community_reports_community_key UNIQUE (semantic_generation_public_id, community_public_id);


--
-- Name: semantic_community_reports semantic_community_reports_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_community_reports
    ADD CONSTRAINT semantic_community_reports_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: semantic_dirty_partitions semantic_dirty_partitions_partition_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_dirty_partitions
    ADD CONSTRAINT semantic_dirty_partitions_partition_key UNIQUE (semantic_generation_public_id, partition_key);


--
-- Name: semantic_dirty_partitions semantic_dirty_partitions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_dirty_partitions
    ADD CONSTRAINT semantic_dirty_partitions_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: semantic_embedding_artifact_refs semantic_embedding_artifact_refs_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_embedding_artifact_refs
    ADD CONSTRAINT semantic_embedding_artifact_refs_pkey PRIMARY KEY (semantic_generation_public_id, semantic_owner_kind, semantic_owner_public_id, artifact_public_id);


--
-- Name: semantic_entities semantic_entities_canonical_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entities
    ADD CONSTRAINT semantic_entities_canonical_key UNIQUE (semantic_generation_public_id, canonical_key);


--
-- Name: semantic_entities semantic_entities_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entities
    ADD CONSTRAINT semantic_entities_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: semantic_entities semantic_entities_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entities
    ADD CONSTRAINT semantic_entities_scope_key UNIQUE (knowledge_base_id, semantic_generation_public_id, public_id);


--
-- Name: semantic_entity_aliases semantic_entity_aliases_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entity_aliases
    ADD CONSTRAINT semantic_entity_aliases_pkey PRIMARY KEY (semantic_generation_public_id, entity_public_id, normalized_alias);


--
-- Name: semantic_entity_observations semantic_entity_observations_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entity_observations
    ADD CONSTRAINT semantic_entity_observations_identity_key PRIMARY KEY (semantic_generation_public_id, entity_public_id, source_revision_public_id);


--
-- Name: semantic_entity_partitions semantic_entity_partitions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entity_partitions
    ADD CONSTRAINT semantic_entity_partitions_pkey PRIMARY KEY (semantic_generation_public_id, entity_public_id);


--
-- Name: semantic_evidence semantic_evidence_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_evidence
    ADD CONSTRAINT semantic_evidence_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: semantic_evidence semantic_evidence_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_evidence
    ADD CONSTRAINT semantic_evidence_scope_key UNIQUE (knowledge_base_id, semantic_generation_public_id, public_id);


--
-- Name: semantic_generations semantic_generations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_generations
    ADD CONSTRAINT semantic_generations_pkey PRIMARY KEY (public_id);


--
-- Name: semantic_generations semantic_generations_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_generations
    ADD CONSTRAINT semantic_generations_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: semantic_mentions semantic_mentions_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_mentions
    ADD CONSTRAINT semantic_mentions_identity_key UNIQUE (semantic_generation_public_id, entity_public_id, evidence_public_id);


--
-- Name: semantic_mentions semantic_mentions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_mentions
    ADD CONSTRAINT semantic_mentions_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: semantic_projection_contracts semantic_projection_contracts_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_projection_contracts
    ADD CONSTRAINT semantic_projection_contracts_pkey PRIMARY KEY (public_id);


--
-- Name: semantic_projection_contracts semantic_projection_contracts_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_projection_contracts
    ADD CONSTRAINT semantic_projection_contracts_scope_key UNIQUE (knowledge_base_id, semantic_generation_public_id);


--
-- Name: semantic_relationship_evidence semantic_relationship_evidence_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationship_evidence
    ADD CONSTRAINT semantic_relationship_evidence_pkey PRIMARY KEY (semantic_generation_public_id, relationship_public_id, evidence_public_id);


--
-- Name: semantic_relationship_observations semantic_relationship_observations_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationship_observations
    ADD CONSTRAINT semantic_relationship_observations_identity_key PRIMARY KEY (semantic_generation_public_id, relationship_public_id, source_revision_public_id);


--
-- Name: semantic_relationships semantic_relationships_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationships
    ADD CONSTRAINT semantic_relationships_identity_key UNIQUE (semantic_generation_public_id, from_entity_public_id, to_entity_public_id, relationship_kind);


--
-- Name: semantic_relationships semantic_relationships_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationships
    ADD CONSTRAINT semantic_relationships_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: semantic_relationships semantic_relationships_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationships
    ADD CONSTRAINT semantic_relationships_scope_key UNIQUE (knowledge_base_id, semantic_generation_public_id, public_id);


--
-- Name: semantic_reverse_references semantic_reverse_references_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_reverse_references
    ADD CONSTRAINT semantic_reverse_references_pkey PRIMARY KEY (semantic_generation_public_id, target_kind, target_public_id, source_file_public_id, evidence_public_id);


--
-- Name: semantic_source_reconciliations semantic_source_reconciliations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_source_reconciliations
    ADD CONSTRAINT semantic_source_reconciliations_pkey PRIMARY KEY (semantic_generation_public_id, source_file_public_id, source_revision_public_id);


--
-- Name: semantic_vector_documents semantic_vector_documents_owner_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_vector_documents
    ADD CONSTRAINT semantic_vector_documents_owner_key UNIQUE (semantic_generation_public_id, vector_family, owner_public_id, source_revision_public_id);


--
-- Name: semantic_vector_documents semantic_vector_documents_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_vector_documents
    ADD CONSTRAINT semantic_vector_documents_pkey PRIMARY KEY (semantic_generation_public_id, public_id);


--
-- Name: source_directories source_directories_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_path_key UNIQUE (knowledge_base_id, normalized_path);


--
-- Name: source_directories source_directories_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_pkey PRIMARY KEY (public_id);


--
-- Name: source_directories source_directories_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: source_file_active_revisions source_file_active_revisions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_active_revisions
    ADD CONSTRAINT source_file_active_revisions_pkey PRIMARY KEY (knowledge_base_id, source_file_public_id);


--
-- Name: source_file_identity_keys source_file_identity_keys_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_identity_keys
    ADD CONSTRAINT source_file_identity_keys_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, identity_kind, normalized_identity_key);


--
-- Name: source_file_identity_keys source_file_identity_keys_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_identity_keys
    ADD CONSTRAINT source_file_identity_keys_pkey PRIMARY KEY (public_id);


--
-- Name: source_files source_files_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_path_key UNIQUE (knowledge_base_id, normalized_path);


--
-- Name: source_files source_files_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_pkey PRIMARY KEY (public_id);


--
-- Name: source_files source_files_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: source_revision_presentations source_revision_presentations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revision_presentations
    ADD CONSTRAINT source_revision_presentations_pkey PRIMARY KEY (knowledge_base_id, source_revision_public_id);


--
-- Name: source_revisions source_revisions_file_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_file_scope_key UNIQUE (knowledge_base_id, source_file_public_id, public_id);


--
-- Name: source_revisions source_revisions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_pkey PRIMARY KEY (public_id);


--
-- Name: source_revisions source_revisions_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: unresolved_file_references unresolved_file_references_identity_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.unresolved_file_references
    ADD CONSTRAINT unresolved_file_references_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, reference_kind, normalized_target_key, evidence_checksum_sha256);


--
-- Name: unresolved_file_references unresolved_file_references_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.unresolved_file_references
    ADD CONSTRAINT unresolved_file_references_pkey PRIMARY KEY (public_id);


--
-- Name: upload_entries upload_entries_path_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_entries
    ADD CONSTRAINT upload_entries_path_key UNIQUE (upload_session_public_id, normalized_path);


--
-- Name: upload_entries upload_entries_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_entries
    ADD CONSTRAINT upload_entries_pkey PRIMARY KEY (upload_session_public_id, entry_public_id);


--
-- Name: upload_entries upload_entries_source_file_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_entries
    ADD CONSTRAINT upload_entries_source_file_key UNIQUE (upload_session_public_id, source_file_public_id);


--
-- Name: upload_path_reservations upload_path_reservations_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_path_reservations
    ADD CONSTRAINT upload_path_reservations_pkey PRIMARY KEY (knowledge_base_id, normalized_path);


--
-- Name: upload_sessions upload_sessions_operation_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_sessions
    ADD CONSTRAINT upload_sessions_operation_key UNIQUE (operation_public_id);


--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (public_id);


--
-- Name: upload_sessions upload_sessions_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_sessions
    ADD CONSTRAINT upload_sessions_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (public_id);


--
-- Name: webhook_subscriptions webhook_subscriptions_pkey; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_pkey PRIMARY KEY (public_id);


--
-- Name: webhook_subscriptions webhook_subscriptions_scope_key; Type: CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_scope_key UNIQUE (knowledge_base_id, public_id);


--
-- Name: webhook_subscriptions_public_idempotency_key; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX webhook_subscriptions_public_idempotency_key ON focowiki.webhook_subscriptions USING btree (idempotency_key) WHERE ((knowledge_base_id IS NULL) AND (idempotency_key IS NOT NULL));


--
-- Name: cleanup_actions_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX cleanup_actions_claim_idx ON focowiki.cleanup_actions USING btree (priority, not_before, sequence_number, updated_at, public_id) WHERE (state = ANY (ARRAY['queued'::text, 'retry'::text]));


--
-- Name: cleanup_actions_lease_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX cleanup_actions_lease_idx ON focowiki.cleanup_actions USING btree (lease_expires_at, public_id) WHERE (state = 'running'::text);


--
-- Name: cleanup_actions_obsolete_artifact_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX cleanup_actions_obsolete_artifact_idx ON focowiki.cleanup_actions USING btree (cleanup_plane, resource_kind, state, not_before, priority, public_id) WHERE (state = ANY (ARRAY['queued'::text, 'retry'::text]));


--
-- Name: cleanup_actions_owner_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX cleanup_actions_owner_idx ON focowiki.cleanup_actions USING btree (knowledge_base_id, source_revision_public_id, document_job_public_id, state);


--
-- Name: document_model_analysis_results_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_model_analysis_results_source_idx ON focowiki.document_model_analysis_results USING btree (knowledge_base_id, source_revision_public_id, created_at) INCLUDE (model_configuration_public_id, model_configuration_revision, prompt_contract_sha256, model_input_sha256);


--
-- Name: document_model_analysis_results_reuse_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_model_analysis_results_reuse_idx ON focowiki.document_model_analysis_results USING btree (knowledge_base_id, model_configuration_public_id, model_configuration_revision, prompt_contract_sha256, model_input_sha256, created_at DESC);


--
-- Name: document_model_layer_executions_job_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_model_layer_executions_job_idx ON focowiki.document_model_layer_executions USING btree (knowledge_base_id, document_job_public_id, layer, created_at);


-- Name: document_processing_jobs_current_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX document_processing_jobs_current_idx ON focowiki.document_processing_jobs USING btree (knowledge_base_id, source_file_public_id) WHERE (state = ANY (ARRAY['waiting'::text, 'processing'::text, 'error'::text, 'deleting'::text]));


--
-- Name: document_processing_jobs_knowledge_base_list_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_processing_jobs_knowledge_base_list_idx ON focowiki.document_processing_jobs USING btree (knowledge_base_id, state, accepted_at DESC, public_id COLLATE "C") INCLUDE (source_file_public_id, source_revision_public_id, operation_public_id, blocking_work_kind, terminal_at, revision);


--
-- Name: document_processing_jobs_operation_list_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_processing_jobs_operation_list_idx ON focowiki.document_processing_jobs USING btree (knowledge_base_id, operation_public_id, accepted_at, public_id) INCLUDE (source_file_public_id, source_revision_public_id, state, blocking_work_kind, terminal_at, safe_error_code, revision);


--
-- Name: document_processing_jobs_retention_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_processing_jobs_retention_idx ON focowiki.document_processing_jobs USING btree (terminal_at, public_id) WHERE (state = ANY (ARRAY['available'::text, 'error'::text, 'cancelled'::text, 'superseded'::text]));


--
-- Name: document_processing_jobs_retry_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_processing_jobs_retry_idx ON focowiki.document_processing_jobs USING btree (next_attempt_at, failure_count, accepted_at, public_id) WHERE ((state = 'waiting'::text) AND (failure_count > 0));


--
-- Name: document_processing_jobs_source_list_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX document_processing_jobs_source_list_idx ON focowiki.document_processing_jobs USING btree (knowledge_base_id, source_file_public_id, accepted_at DESC, public_id COLLATE "C") INCLUDE (source_revision_public_id, operation_public_id, state, blocking_work_kind, model_status, terminal_at, safe_error_code, revision);


--
-- Name: embedding_artifact_owners_generation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX embedding_artifact_owners_generation_idx ON focowiki.embedding_artifact_owners USING btree (knowledge_base_id, semantic_generation_public_id, artifact_public_id);


--
-- Name: embedding_artifacts_reuse_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX embedding_artifacts_reuse_idx ON focowiki.embedding_artifacts USING btree (knowledge_base_id, embedding_configuration_revision_public_id, input_kind, canonical_input_sha256, public_id) WHERE ((deleted_at IS NULL) AND (state = 'verified'::text));


--
-- Name: embedding_configurations_one_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX embedding_configurations_one_active_idx ON focowiki.embedding_configurations USING btree (lifecycle_status) WHERE ((lifecycle_status = 'active'::text) AND (deleted_at IS NULL));


--
-- Name: generated_directory_leaf_entries_leaf_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generated_directory_leaf_entries_leaf_idx ON focowiki.generated_directory_leaf_entries USING btree (knowledge_base_id, directory_path, leaf_public_id, ordinal) INCLUDE (entry_public_id, sort_key, name, target_path, evidence_path, entry_kind);


--
-- Name: generated_directory_leaves_order_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generated_directory_leaves_order_idx ON focowiki.generated_directory_leaves USING btree (knowledge_base_id, directory_path, first_sort_key COLLATE "C", leaf_public_id COLLATE "C") INCLUDE (previous_leaf_public_id, next_leaf_public_id, last_sort_key, entry_count, revision, activation_revision);


--
-- Name: generated_page_candidates_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generated_page_candidates_revision_idx ON focowiki.generated_page_candidates USING btree (knowledge_base_id, source_revision_public_id, state, normalized_path);

CREATE INDEX generated_page_candidates_work_state_idx ON focowiki.generated_page_candidates USING btree (knowledge_base_id, source_work_public_id, state, public_id);

CREATE INDEX generated_page_candidates_active_idx ON focowiki.generated_page_candidates USING btree (knowledge_base_id, public_id) WHERE (state = 'active'::text);


--
-- Name: generated_page_heads_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generated_page_heads_path_idx ON focowiki.generated_page_heads USING btree (knowledge_base_id, normalized_path, logical_path);


--
-- Name: generated_page_heads_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX generated_page_heads_source_idx ON focowiki.generated_page_heads USING btree (knowledge_base_id, source_file_public_id, normalized_path) WHERE (source_file_public_id IS NOT NULL);


--
-- Name: graph_edges_from_node_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX graph_edges_from_node_idx ON focowiki.graph_edges USING btree (knowledge_base_id, from_node_public_id, weight DESC, public_id);


--
-- Name: graph_edges_to_node_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX graph_edges_to_node_idx ON focowiki.graph_edges USING btree (knowledge_base_id, to_node_public_id, weight DESC, public_id);


--
-- Name: graph_evidence_refs_edge_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX graph_evidence_refs_edge_idx ON focowiki.graph_evidence_refs USING btree (knowledge_base_id, edge_public_id, public_id) WHERE (edge_public_id IS NOT NULL);


--
-- Name: graph_evidence_refs_node_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX graph_evidence_refs_node_idx ON focowiki.graph_evidence_refs USING btree (knowledge_base_id, node_public_id, public_id) WHERE (node_public_id IS NOT NULL);


--
-- Name: graph_evidence_refs_source_file_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX graph_evidence_refs_source_file_idx ON focowiki.graph_evidence_refs USING btree (knowledge_base_id, source_file_public_id, public_id);


--
-- Name: graph_nodes_source_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX graph_nodes_source_revision_idx ON focowiki.graph_nodes USING btree (knowledge_base_id, source_file_public_id, source_revision_public_id, public_id);


--
-- Name: object_owners_bundle_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX object_owners_receipt_idx ON focowiki.object_owners USING btree (knowledge_base_id, source_receipt_public_id, object_id) WHERE (source_receipt_public_id IS NOT NULL);


--
-- Name: object_owners_operation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX object_owners_operation_idx ON focowiki.object_owners USING btree (knowledge_base_id, operation_public_id, object_id) WHERE (operation_public_id IS NOT NULL);


--
-- Name: object_owners_page_candidate_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX object_owners_page_candidate_idx ON focowiki.object_owners USING btree (knowledge_base_id, generated_page_candidate_public_id, object_id) WHERE (generated_page_candidate_public_id IS NOT NULL);


--
-- Name: object_owners_source_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX object_owners_source_revision_idx ON focowiki.object_owners USING btree (knowledge_base_id, source_revision_public_id, object_id) WHERE (source_revision_public_id IS NOT NULL);


--
-- Name: object_registrations_stale_reservation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX object_registrations_stale_reservation_idx ON focowiki.object_registrations USING btree (created_at, object_id) WHERE (state = 'reserved'::text);


--
-- Name: object_registrations_zero_owner_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX object_registrations_zero_owner_idx ON focowiki.object_registrations USING btree (zero_owner_since, object_id) WHERE ((state = 'verified'::text) AND (zero_owner_since IS NOT NULL));


--
-- Name: operation_idempotency_operation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operation_idempotency_operation_idx ON focowiki.operation_idempotency USING btree (knowledge_base_id, operation_public_id);


--
-- Name: operation_results_scope_time_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operation_results_scope_time_idx ON focowiki.operation_results USING btree (knowledge_base_id, completed_at DESC, public_id DESC);


--
-- Name: operation_tombstones_expiry_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operation_tombstones_expiry_idx ON focowiki.operation_tombstones USING btree (expires_at, public_id);


--
-- Name: operation_tombstones_scope_time_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operation_tombstones_scope_time_idx ON focowiki.operation_tombstones USING btree (knowledge_base_id, created_at DESC, public_id DESC);


--
-- Name: operation_work_items_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operation_work_items_claim_idx ON focowiki.operation_work_items USING btree (work_kind, next_attempt_at, updated_at, operation_public_id) WHERE (state = ANY (ARRAY['queued'::text, 'retry'::text]));


--
-- Name: operation_work_items_lease_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operation_work_items_lease_idx ON focowiki.operation_work_items USING btree (lease_expires_at, operation_public_id) WHERE (state = 'running'::text);


--
-- Name: operation_work_items_settings_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operation_work_items_settings_idx ON focowiki.operation_work_items USING btree (settings_revision_public_id, operation_public_id);


--
-- Name: operations_live_maintenance_owner_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX operations_live_maintenance_owner_idx ON focowiki.operations USING btree (knowledge_base_id) WHERE ((operation_kind = 'maintenance'::text) AND (state = ANY (ARRAY['accepted'::text, 'validating'::text, 'processing'::text])));


--
-- Name: operations_source_target_latest_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX operations_source_target_latest_idx ON focowiki.operations USING btree (knowledge_base_id, target_kind, target_public_id, operation_kind, created_at DESC, public_id DESC) INCLUDE (state, updated_at);


--
-- Name: relationship_evaluations_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX relationship_evaluations_source_idx ON focowiki.relationship_evaluations USING btree (knowledge_base_id, source_revision_public_id, target_revision_public_id, created_at) INCLUDE (evidence_fingerprint_sha256, model_configuration_public_id, model_configuration_revision, prompt_contract_sha256, decision, confidence);


--
-- Name: relationship_evaluations_target_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX relationship_evaluations_target_idx ON focowiki.relationship_evaluations USING btree (knowledge_base_id, target_revision_public_id, source_revision_public_id, created_at);


--
-- Name: relationship_evaluations_reuse_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX relationship_evaluations_reuse_idx ON focowiki.relationship_evaluations USING btree (knowledge_base_id, model_configuration_public_id, model_configuration_revision, prompt_contract_sha256, evidence_fingerprint_sha256, target_revision_public_id, created_at DESC);


--
-- Name: reranker_configurations_one_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX reranker_configurations_one_active_idx ON focowiki.reranker_configurations USING btree (lifecycle_status) WHERE (lifecycle_status = 'active'::text);


--
-- Name: search_document_owners_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX search_document_owners_active_idx ON focowiki.search_document_owners USING btree (knowledge_base_id, provider_kind, source_file_public_id, provider_document_id) WHERE (state = 'active'::text);


--
-- Name: search_document_owners_source_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX search_document_owners_source_revision_idx ON focowiki.search_document_owners USING btree (knowledge_base_id, source_revision_public_id, state, provider_document_id);


--
-- Name: search_projections_one_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX search_projections_one_active_idx ON focowiki.search_projections USING btree (knowledge_base_id) WHERE (state = 'active'::text);


--
-- Name: security_audit_events_type_time_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX security_audit_events_type_time_idx ON ONLY focowiki.security_audit_events USING btree (event_type, result, created_at DESC, public_id);


--
-- Name: security_audit_events_2026_08_event_type_result_created_at__idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX security_audit_events_2026_08_event_type_result_created_at__idx ON focowiki.security_audit_events_2026_08 USING btree (event_type, result, created_at DESC, public_id);


--
-- Name: security_audit_events_scope_time_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX security_audit_events_scope_time_idx ON ONLY focowiki.security_audit_events USING btree (knowledge_base_id, created_at DESC, public_id);


--
-- Name: security_audit_events_2026_08_knowledge_base_id_created_at__idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX security_audit_events_2026_08_knowledge_base_id_created_at__idx ON focowiki.security_audit_events_2026_08 USING btree (knowledge_base_id, created_at DESC, public_id);


--
-- Name: security_audit_events_2026_09_event_type_result_created_at__idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX security_audit_events_2026_09_event_type_result_created_at__idx ON focowiki.security_audit_events_2026_09 USING btree (event_type, result, created_at DESC, public_id);


--
-- Name: security_audit_events_2026_09_knowledge_base_id_created_at__idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX security_audit_events_2026_09_knowledge_base_id_created_at__idx ON focowiki.security_audit_events_2026_09 USING btree (knowledge_base_id, created_at DESC, public_id);


--
-- Name: semantic_communities_source_partition_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_communities_source_partition_idx ON focowiki.semantic_communities USING btree (knowledge_base_id, semantic_generation_public_id, source_partition_key, public_id) WHERE (deleted_at IS NULL);


--
-- Name: semantic_dirty_partitions_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_dirty_partitions_claim_idx ON focowiki.semantic_dirty_partitions USING btree (state, next_attempt_at, updated_at, public_id) WHERE (state = ANY (ARRAY['dirty'::text, 'failed'::text]));


--
-- Name: semantic_entities_active_kind_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_entities_active_kind_idx ON focowiki.semantic_entities USING btree (knowledge_base_id, semantic_generation_public_id, entity_kind, canonical_key) WHERE (deleted_at IS NULL);


--
-- Name: semantic_entity_observations_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_entity_observations_source_idx ON focowiki.semantic_entity_observations USING btree (knowledge_base_id, source_file_public_id, source_revision_public_id, entity_public_id);


--
-- Name: semantic_entity_partitions_partition_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_entity_partitions_partition_idx ON focowiki.semantic_entity_partitions USING btree (knowledge_base_id, semantic_generation_public_id, partition_key, entity_public_id);


--
-- Name: semantic_generations_candidate_operation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_generations_candidate_operation_idx ON focowiki.semantic_generations USING btree (knowledge_base_id, operation_public_id, public_id) WHERE ((generation_role = 'candidate'::text) AND (deleted_at IS NULL));


--
-- Name: semantic_generations_one_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX semantic_generations_one_active_idx ON focowiki.semantic_generations USING btree (knowledge_base_id) WHERE ((generation_role = 'active'::text) AND (state = 'active'::text) AND (deleted_at IS NULL));


--
-- Name: semantic_mentions_source_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_mentions_source_revision_idx ON focowiki.semantic_mentions USING btree (knowledge_base_id, source_file_public_id, source_revision_public_id, public_id);


--
-- Name: semantic_relationship_observations_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_relationship_observations_source_idx ON focowiki.semantic_relationship_observations USING btree (knowledge_base_id, source_file_public_id, source_revision_public_id, relationship_public_id);


--
-- Name: semantic_relationships_from_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_relationships_from_idx ON focowiki.semantic_relationships USING btree (knowledge_base_id, semantic_generation_public_id, from_entity_public_id, public_id) WHERE (deleted_at IS NULL);


--
-- Name: semantic_relationships_to_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_relationships_to_idx ON focowiki.semantic_relationships USING btree (knowledge_base_id, semantic_generation_public_id, to_entity_public_id, public_id) WHERE (deleted_at IS NULL);


--
-- Name: semantic_reverse_references_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_reverse_references_source_idx ON focowiki.semantic_reverse_references USING btree (knowledge_base_id, source_file_public_id, target_kind, target_public_id);


--
-- Name: semantic_vector_documents_active_family_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_vector_documents_active_family_idx ON focowiki.semantic_vector_documents USING btree (knowledge_base_id, semantic_generation_public_id, vector_family, public_id) WHERE ((state = 'active'::text) AND (deleted_at IS NULL));


--
-- Name: semantic_vector_documents_source_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX semantic_vector_documents_source_revision_idx ON focowiki.semantic_vector_documents USING btree (knowledge_base_id, source_revision_public_id, state, vector_family, public_id);


--
-- Name: source_directories_active_parent_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_directories_active_parent_path_idx ON focowiki.source_directories USING btree (knowledge_base_id, parent_public_id, normalized_path, public_id) WHERE (deleted_at IS NULL);


--
-- Name: source_file_active_revisions_active_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_active_revisions_active_idx ON focowiki.source_file_active_revisions USING btree (knowledge_base_id, active_source_revision_public_id, source_file_public_id) WHERE (active_source_revision_public_id IS NOT NULL);


--
-- Name: source_file_active_revisions_current_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_active_revisions_current_idx ON focowiki.source_file_active_revisions USING btree (knowledge_base_id, current_source_revision_public_id, source_file_public_id);


--
-- Name: source_file_identity_keys_active_lookup_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_identity_keys_active_lookup_idx ON focowiki.source_file_identity_keys USING btree (knowledge_base_id, normalized_identity_key, source_file_public_id, identity_kind) WHERE (state = 'active'::text);


--
-- Name: source_file_identity_keys_source_revision_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_file_identity_keys_source_revision_idx ON focowiki.source_file_identity_keys USING btree (knowledge_base_id, source_revision_public_id, state, normalized_identity_key);


--
-- Name: source_files_active_directory_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_files_active_directory_path_idx ON focowiki.source_files USING btree (knowledge_base_id, directory_public_id, normalized_path, public_id) WHERE (deleted_at IS NULL);


--
-- Name: source_revision_presentations_current_path_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX source_revision_presentations_current_path_idx ON focowiki.source_revision_presentations USING btree (knowledge_base_id, normalized_path, source_revision_public_id);


--
-- Name: source_revisions_object_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX source_revisions_object_idx ON focowiki.source_revisions USING btree (object_id, knowledge_base_id, public_id);


--
-- Name: unresolved_file_references_resolved_target_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX unresolved_file_references_resolved_target_idx ON focowiki.unresolved_file_references USING btree (knowledge_base_id, resolved_target_source_file_public_id, source_file_public_id) WHERE (resolved_target_source_file_public_id IS NOT NULL);


--
-- Name: unresolved_file_references_reverse_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX unresolved_file_references_reverse_idx ON focowiki.unresolved_file_references USING btree (knowledge_base_id, normalized_target_key, resolution_state, source_file_public_id);


--
-- Name: unresolved_file_references_source_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX unresolved_file_references_source_idx ON focowiki.unresolved_file_references USING btree (knowledge_base_id, source_file_public_id, source_revision_public_id, resolution_state);


--
-- Name: upload_entries_object_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_entries_object_idx ON focowiki.upload_entries USING btree (object_id, upload_session_public_id) WHERE (object_id IS NOT NULL);


--
-- Name: upload_path_reservations_expiry_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_path_reservations_expiry_idx ON focowiki.upload_path_reservations USING btree (expires_at, knowledge_base_id, normalized_path);


--
-- Name: upload_sessions_expiry_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX upload_sessions_expiry_idx ON focowiki.upload_sessions USING btree (expires_at, public_id);


--
-- Name: webhook_deliveries_claim_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_deliveries_claim_idx ON focowiki.webhook_deliveries USING btree (next_attempt_at, updated_at, public_id) WHERE (state = ANY (ARRAY['queued'::text, 'retry'::text]));


--
-- Name: webhook_deliveries_expiry_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_deliveries_expiry_idx ON focowiki.webhook_deliveries USING btree (expires_at, public_id) WHERE (state = ANY (ARRAY['completed'::text, 'failed'::text]));


--
-- Name: webhook_deliveries_lease_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_deliveries_lease_idx ON focowiki.webhook_deliveries USING btree (lease_expires_at, public_id) WHERE (state = 'running'::text);


--
-- Name: webhook_deliveries_operation_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_deliveries_operation_idx ON focowiki.webhook_deliveries USING btree (knowledge_base_id, operation_public_id, public_id);


--
-- Name: webhook_deliveries_original_event_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE UNIQUE INDEX webhook_deliveries_original_event_idx ON focowiki.webhook_deliveries USING btree (subscription_public_id, event_public_id) WHERE (redelivery_of_public_id IS NULL);


--
-- Name: webhook_deliveries_subscription_idx; Type: INDEX; Schema: focowiki; Owner: -
--

CREATE INDEX webhook_deliveries_subscription_idx ON focowiki.webhook_deliveries USING btree (knowledge_base_id, subscription_public_id, public_id);


--
-- Name: diagnostic_events_2026_08_pkey; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.diagnostic_events_pkey ATTACH PARTITION focowiki.diagnostic_events_2026_08_pkey;


--
-- Name: diagnostic_events_2026_09_pkey; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.diagnostic_events_pkey ATTACH PARTITION focowiki.diagnostic_events_2026_09_pkey;


--
-- Name: security_audit_events_2026_08_event_type_result_created_at__idx; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.security_audit_events_type_time_idx ATTACH PARTITION focowiki.security_audit_events_2026_08_event_type_result_created_at__idx;


--
-- Name: security_audit_events_2026_08_knowledge_base_id_created_at__idx; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.security_audit_events_scope_time_idx ATTACH PARTITION focowiki.security_audit_events_2026_08_knowledge_base_id_created_at__idx;


--
-- Name: security_audit_events_2026_08_pkey; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.security_audit_events_pkey ATTACH PARTITION focowiki.security_audit_events_2026_08_pkey;


--
-- Name: security_audit_events_2026_09_event_type_result_created_at__idx; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.security_audit_events_type_time_idx ATTACH PARTITION focowiki.security_audit_events_2026_09_event_type_result_created_at__idx;


--
-- Name: security_audit_events_2026_09_knowledge_base_id_created_at__idx; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.security_audit_events_scope_time_idx ATTACH PARTITION focowiki.security_audit_events_2026_09_knowledge_base_id_created_at__idx;


--
-- Name: security_audit_events_2026_09_pkey; Type: INDEX ATTACH; Schema: focowiki; Owner: -
--

ALTER INDEX focowiki.security_audit_events_pkey ATTACH PARTITION focowiki.security_audit_events_2026_09_pkey;


--
-- Name: document_processing_jobs document_processing_jobs_immutable_contract; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER document_processing_jobs_immutable_contract BEFORE UPDATE ON focowiki.document_processing_jobs FOR EACH ROW EXECUTE FUNCTION focowiki.reject_document_job_contract_mutation();


--
-- Name: model_config_revisions model_config_revisions_immutable_update; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER model_config_revisions_immutable_update BEFORE DELETE OR UPDATE ON focowiki.model_config_revisions FOR EACH ROW EXECUTE FUNCTION focowiki.reject_model_config_revision_mutation();


--
-- Name: model_configs model_configs_capture_insert_revision; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER model_configs_capture_insert_revision AFTER INSERT ON focowiki.model_configs FOR EACH ROW EXECUTE FUNCTION focowiki.capture_model_config_revision();


--
-- Name: model_configs model_configs_capture_updated_revision; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER model_configs_capture_updated_revision AFTER UPDATE ON focowiki.model_configs FOR EACH ROW WHEN ((old.revision IS DISTINCT FROM new.revision)) EXECUTE FUNCTION focowiki.capture_model_config_revision();


--
-- Name: runtime_setting_revisions runtime_setting_revisions_immutable_update; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER runtime_setting_revisions_immutable_update BEFORE UPDATE ON focowiki.runtime_setting_revisions FOR EACH ROW EXECUTE FUNCTION focowiki.reject_runtime_setting_revision_update();


--
-- Name: source_file_active_revisions source_file_active_revisions_validate; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER source_file_active_revisions_validate BEFORE INSERT OR UPDATE ON focowiki.source_file_active_revisions FOR EACH ROW EXECUTE FUNCTION focowiki.validate_source_file_active_revision();


--
-- Name: source_revisions source_revisions_immutable_content; Type: TRIGGER; Schema: focowiki; Owner: -
--

CREATE TRIGGER source_revisions_immutable_content BEFORE UPDATE ON focowiki.source_revisions FOR EACH ROW EXECUTE FUNCTION focowiki.reject_source_revision_content_mutation();


--
-- Name: cleanup_actions cleanup_actions_job_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.cleanup_actions
    ADD CONSTRAINT cleanup_actions_job_fkey FOREIGN KEY (knowledge_base_id, document_job_public_id) REFERENCES focowiki.document_processing_jobs(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: cleanup_actions cleanup_actions_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.cleanup_actions
    ADD CONSTRAINT cleanup_actions_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: cleanup_actions cleanup_actions_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.cleanup_actions
    ADD CONSTRAINT cleanup_actions_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: diagnostic_events diagnostic_events_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE focowiki.diagnostic_events
    ADD CONSTRAINT diagnostic_events_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: document_model_analysis_results document_model_analysis_results_model_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_analysis_results
    ADD CONSTRAINT document_model_analysis_results_model_revision_fkey FOREIGN KEY (model_configuration_public_id, model_configuration_revision) REFERENCES focowiki.model_config_revisions(configuration_public_id, revision_number) ON DELETE RESTRICT;


--
-- Name: document_model_analysis_results document_model_analysis_results_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_analysis_results
    ADD CONSTRAINT document_model_analysis_results_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: document_model_layer_executions document_model_layer_executions_job_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_layer_executions
    ADD CONSTRAINT document_model_layer_executions_job_fkey FOREIGN KEY (knowledge_base_id, document_job_public_id) REFERENCES focowiki.document_processing_jobs(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: document_model_layer_executions document_model_layer_executions_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_model_layer_executions
    ADD CONSTRAINT document_model_layer_executions_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: document_processing_jobs document_processing_jobs_embedding_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_embedding_revision_fkey FOREIGN KEY (embedding_configuration_revision_public_id) REFERENCES focowiki.embedding_configuration_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: document_processing_jobs document_processing_jobs_model_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_model_revision_fkey FOREIGN KEY (generation_model_configuration_public_id, generation_model_configuration_revision) REFERENCES focowiki.model_config_revisions(configuration_public_id, revision_number) ON DELETE RESTRICT;


--
-- Name: document_processing_jobs document_processing_jobs_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: document_processing_jobs document_processing_jobs_semantic_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_semantic_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE RESTRICT;


--
-- Name: document_processing_jobs document_processing_jobs_settings_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_settings_revision_fkey FOREIGN KEY (runtime_settings_revision_public_id) REFERENCES focowiki.runtime_setting_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: document_processing_jobs document_processing_jobs_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: embedding_artifact_owners embedding_artifact_owners_artifact_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifact_owners
    ADD CONSTRAINT embedding_artifact_owners_artifact_fkey FOREIGN KEY (artifact_public_id) REFERENCES focowiki.embedding_artifacts(public_id) ON DELETE CASCADE;


--
-- Name: embedding_artifact_owners embedding_artifact_owners_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifact_owners
    ADD CONSTRAINT embedding_artifact_owners_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: embedding_artifact_owners embedding_artifact_owners_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifact_owners
    ADD CONSTRAINT embedding_artifact_owners_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: embedding_artifacts embedding_artifacts_embedding_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifacts
    ADD CONSTRAINT embedding_artifacts_embedding_revision_fkey FOREIGN KEY (embedding_configuration_revision_public_id) REFERENCES focowiki.embedding_configuration_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: embedding_artifacts embedding_artifacts_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifacts
    ADD CONSTRAINT embedding_artifacts_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: embedding_artifacts embedding_artifacts_object_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_artifacts
    ADD CONSTRAINT embedding_artifacts_object_fkey FOREIGN KEY (object_id) REFERENCES focowiki.object_registrations(object_id) ON DELETE RESTRICT;


--
-- Name: embedding_configuration_revisions embedding_configuration_revisions_configuration_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_configuration_revisions
    ADD CONSTRAINT embedding_configuration_revisions_configuration_fkey FOREIGN KEY (configuration_public_id) REFERENCES focowiki.embedding_configurations(public_id) ON DELETE CASCADE;


--
-- Name: embedding_configuration_revisions embedding_configuration_revisions_vector_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_configuration_revisions
    ADD CONSTRAINT embedding_configuration_revisions_vector_revision_fkey FOREIGN KEY (vector_producing_revision_public_id) REFERENCES focowiki.embedding_configuration_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: embedding_configurations embedding_configurations_active_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.embedding_configurations
    ADD CONSTRAINT embedding_configurations_active_revision_fkey FOREIGN KEY (public_id, active_revision_public_id) REFERENCES focowiki.embedding_configuration_revisions(configuration_public_id, public_id) ON DELETE RESTRICT;


--
-- Name: generated_directory_leaf_entries generated_directory_leaf_entries_leaf_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_directory_leaf_entries
    ADD CONSTRAINT generated_directory_leaf_entries_leaf_fkey FOREIGN KEY (knowledge_base_id, directory_path, leaf_public_id) REFERENCES focowiki.generated_directory_leaves(knowledge_base_id, directory_path, leaf_public_id) ON DELETE CASCADE;


--
-- Name: generated_directory_leaves generated_directory_leaves_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_directory_leaves
    ADD CONSTRAINT generated_directory_leaves_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: generated_page_candidates generated_page_candidates_bundle_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

--
-- Name: generated_page_candidates generated_page_candidates_object_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_object_fkey FOREIGN KEY (object_id) REFERENCES focowiki.object_registrations(object_id) ON DELETE RESTRICT;


--
-- Name: generated_page_candidates generated_page_candidates_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_operation_fkey FOREIGN KEY (knowledge_base_id, owner_operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: generated_page_candidates generated_page_candidates_page_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_page_source_revision_fkey FOREIGN KEY (knowledge_base_id, page_source_file_public_id, page_source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: generated_page_candidates generated_page_candidates_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: generated_page_heads generated_page_heads_candidate_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_heads
    ADD CONSTRAINT generated_page_heads_candidate_fkey FOREIGN KEY (knowledge_base_id, page_candidate_public_id) REFERENCES focowiki.generated_page_candidates(knowledge_base_id, public_id) ON DELETE RESTRICT;


--
-- Name: generated_page_heads generated_page_heads_object_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_heads
    ADD CONSTRAINT generated_page_heads_object_fkey FOREIGN KEY (object_id) REFERENCES focowiki.object_registrations(object_id) ON DELETE RESTRICT;


--
-- Name: generated_page_heads generated_page_heads_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.generated_page_heads
    ADD CONSTRAINT generated_page_heads_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE RESTRICT;


--
-- Name: graph_edges graph_edges_from_node_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_edges
    ADD CONSTRAINT graph_edges_from_node_fkey FOREIGN KEY (knowledge_base_id, from_node_public_id) REFERENCES focowiki.graph_nodes(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: graph_edges graph_edges_to_node_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_edges
    ADD CONSTRAINT graph_edges_to_node_fkey FOREIGN KEY (knowledge_base_id, to_node_public_id) REFERENCES focowiki.graph_nodes(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: graph_evidence_refs graph_evidence_refs_edge_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_evidence_refs
    ADD CONSTRAINT graph_evidence_refs_edge_fkey FOREIGN KEY (knowledge_base_id, edge_public_id) REFERENCES focowiki.graph_edges(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: graph_evidence_refs graph_evidence_refs_node_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_evidence_refs
    ADD CONSTRAINT graph_evidence_refs_node_fkey FOREIGN KEY (knowledge_base_id, node_public_id) REFERENCES focowiki.graph_nodes(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: graph_evidence_refs graph_evidence_refs_source_file_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_evidence_refs
    ADD CONSTRAINT graph_evidence_refs_source_file_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id) REFERENCES focowiki.source_files(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: graph_evidence_refs graph_evidence_refs_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_evidence_refs
    ADD CONSTRAINT graph_evidence_refs_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: graph_nodes graph_nodes_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.graph_nodes
    ADD CONSTRAINT graph_nodes_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: model_config_revisions model_config_revisions_configuration_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_config_revisions
    ADD CONSTRAINT model_config_revisions_configuration_fkey FOREIGN KEY (configuration_public_id) REFERENCES focowiki.model_configs(public_id) ON DELETE RESTRICT;


--
-- Name: model_configs model_configs_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.model_configs
    ADD CONSTRAINT model_configs_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: mutation_path_reservations mutation_path_reservations_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.mutation_path_reservations
    ADD CONSTRAINT mutation_path_reservations_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: object_owners object_owners_bundle_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

--
-- Name: object_owners object_owners_embedding_artifact_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_embedding_artifact_fkey FOREIGN KEY (embedding_artifact_public_id) REFERENCES focowiki.embedding_artifacts(public_id) ON DELETE CASCADE;


--
-- Name: object_owners object_owners_object_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_object_fkey FOREIGN KEY (object_id) REFERENCES focowiki.object_registrations(object_id) ON DELETE CASCADE;


--
-- Name: object_owners object_owners_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: object_owners object_owners_page_candidate_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_page_candidate_fkey FOREIGN KEY (knowledge_base_id, generated_page_candidate_public_id) REFERENCES focowiki.generated_page_candidates(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: object_owners object_owners_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: operation_idempotency operation_idempotency_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_idempotency
    ADD CONSTRAINT operation_idempotency_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: operation_results operation_results_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_results
    ADD CONSTRAINT operation_results_operation_fkey FOREIGN KEY (knowledge_base_id, public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: operation_work_items operation_work_items_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_work_items
    ADD CONSTRAINT operation_work_items_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: operation_work_items operation_work_items_settings_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operation_work_items
    ADD CONSTRAINT operation_work_items_settings_fkey FOREIGN KEY (settings_revision_public_id) REFERENCES focowiki.runtime_setting_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: operations operations_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.operations
    ADD CONSTRAINT operations_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: relationship_evaluations relationship_evaluations_model_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.relationship_evaluations
    ADD CONSTRAINT relationship_evaluations_model_revision_fkey FOREIGN KEY (model_configuration_public_id, model_configuration_revision) REFERENCES focowiki.model_config_revisions(configuration_public_id, revision_number) ON DELETE RESTRICT;


--
-- Name: relationship_evaluations relationship_evaluations_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.relationship_evaluations
    ADD CONSTRAINT relationship_evaluations_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: relationship_evaluations relationship_evaluations_target_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.relationship_evaluations
    ADD CONSTRAINT relationship_evaluations_target_revision_fkey FOREIGN KEY (knowledge_base_id, target_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: reranker_configuration_revisions reranker_configuration_revisions_configuration_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.reranker_configuration_revisions
    ADD CONSTRAINT reranker_configuration_revisions_configuration_fkey FOREIGN KEY (configuration_public_id) REFERENCES focowiki.reranker_configurations(public_id) ON DELETE CASCADE;


--
-- Name: reranker_configurations reranker_configurations_active_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.reranker_configurations
    ADD CONSTRAINT reranker_configurations_active_revision_fkey FOREIGN KEY (public_id, active_revision_public_id) REFERENCES focowiki.reranker_configuration_revisions(configuration_public_id, public_id) ON DELETE RESTRICT;


--
-- Name: runtime_setting_current runtime_setting_current_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.runtime_setting_current
    ADD CONSTRAINT runtime_setting_current_revision_fkey FOREIGN KEY (revision_public_id) REFERENCES focowiki.runtime_setting_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: search_document_owners search_document_owners_projection_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_document_owners
    ADD CONSTRAINT search_document_owners_projection_fkey FOREIGN KEY (knowledge_base_id, search_projection_public_id) REFERENCES focowiki.search_projections(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: search_document_owners search_document_owners_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_document_owners
    ADD CONSTRAINT search_document_owners_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: search_projections search_projections_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.search_projections
    ADD CONSTRAINT search_projections_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: security_audit_events security_audit_events_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE focowiki.security_audit_events
    ADD CONSTRAINT security_audit_events_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE SET NULL;


--
-- Name: semantic_communities semantic_communities_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_communities
    ADD CONSTRAINT semantic_communities_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_community_memberships semantic_community_memberships_community_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_community_memberships
    ADD CONSTRAINT semantic_community_memberships_community_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, community_public_id) REFERENCES focowiki.semantic_communities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_community_memberships semantic_community_memberships_entity_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_community_memberships
    ADD CONSTRAINT semantic_community_memberships_entity_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, entity_public_id) REFERENCES focowiki.semantic_entities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_community_reports semantic_community_reports_community_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_community_reports
    ADD CONSTRAINT semantic_community_reports_community_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, community_public_id) REFERENCES focowiki.semantic_communities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_dirty_partitions semantic_dirty_partitions_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_dirty_partitions
    ADD CONSTRAINT semantic_dirty_partitions_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_embedding_artifact_refs semantic_embedding_artifact_refs_artifact_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_embedding_artifact_refs
    ADD CONSTRAINT semantic_embedding_artifact_refs_artifact_fkey FOREIGN KEY (artifact_public_id) REFERENCES focowiki.embedding_artifacts(public_id) ON DELETE RESTRICT;


--
-- Name: semantic_embedding_artifact_refs semantic_embedding_artifact_refs_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_embedding_artifact_refs
    ADD CONSTRAINT semantic_embedding_artifact_refs_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_embedding_artifact_refs semantic_embedding_artifact_refs_source_file_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_embedding_artifact_refs
    ADD CONSTRAINT semantic_embedding_artifact_refs_source_file_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id) REFERENCES focowiki.source_files(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_entities semantic_entities_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entities
    ADD CONSTRAINT semantic_entities_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_entity_aliases semantic_entity_aliases_entity_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entity_aliases
    ADD CONSTRAINT semantic_entity_aliases_entity_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, entity_public_id) REFERENCES focowiki.semantic_entities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_entity_observations semantic_entity_observations_entity_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entity_observations
    ADD CONSTRAINT semantic_entity_observations_entity_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, entity_public_id) REFERENCES focowiki.semantic_entities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_entity_observations semantic_entity_observations_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entity_observations
    ADD CONSTRAINT semantic_entity_observations_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_entity_partitions semantic_entity_partitions_entity_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_entity_partitions
    ADD CONSTRAINT semantic_entity_partitions_entity_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, entity_public_id) REFERENCES focowiki.semantic_entities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_evidence semantic_evidence_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_evidence
    ADD CONSTRAINT semantic_evidence_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_evidence semantic_evidence_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_evidence
    ADD CONSTRAINT semantic_evidence_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_generations semantic_generations_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_generations
    ADD CONSTRAINT semantic_generations_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: semantic_generations semantic_generations_model_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_generations
    ADD CONSTRAINT semantic_generations_model_revision_fkey FOREIGN KEY (generation_model_configuration_public_id, generation_model_configuration_revision) REFERENCES focowiki.model_config_revisions(configuration_public_id, revision_number) ON DELETE RESTRICT;


--
-- Name: semantic_generations semantic_generations_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_generations
    ADD CONSTRAINT semantic_generations_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_generations semantic_generations_predecessor_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_generations
    ADD CONSTRAINT semantic_generations_predecessor_fkey FOREIGN KEY (knowledge_base_id, expected_predecessor_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE RESTRICT;


--
-- Name: semantic_mentions semantic_mentions_entity_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_mentions
    ADD CONSTRAINT semantic_mentions_entity_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, entity_public_id) REFERENCES focowiki.semantic_entities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_mentions semantic_mentions_evidence_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_mentions
    ADD CONSTRAINT semantic_mentions_evidence_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, evidence_public_id) REFERENCES focowiki.semantic_evidence(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_mentions semantic_mentions_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_mentions
    ADD CONSTRAINT semantic_mentions_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_projection_contracts semantic_projection_contracts_embedding_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_projection_contracts
    ADD CONSTRAINT semantic_projection_contracts_embedding_revision_fkey FOREIGN KEY (embedding_configuration_revision_public_id) REFERENCES focowiki.embedding_configuration_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: semantic_projection_contracts semantic_projection_contracts_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_projection_contracts
    ADD CONSTRAINT semantic_projection_contracts_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_projection_contracts semantic_projection_contracts_query_policy_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_projection_contracts
    ADD CONSTRAINT semantic_projection_contracts_query_policy_revision_fkey FOREIGN KEY (embedding_query_policy_revision_public_id) REFERENCES focowiki.embedding_configuration_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: semantic_relationship_evidence semantic_relationship_evidence_evidence_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationship_evidence
    ADD CONSTRAINT semantic_relationship_evidence_evidence_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, evidence_public_id) REFERENCES focowiki.semantic_evidence(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_relationship_evidence semantic_relationship_evidence_relationship_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationship_evidence
    ADD CONSTRAINT semantic_relationship_evidence_relationship_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, relationship_public_id) REFERENCES focowiki.semantic_relationships(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_relationship_observations semantic_relationship_observations_relationship_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationship_observations
    ADD CONSTRAINT semantic_relationship_observations_relationship_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, relationship_public_id) REFERENCES focowiki.semantic_relationships(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_relationship_observations semantic_relationship_observations_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationship_observations
    ADD CONSTRAINT semantic_relationship_observations_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_relationships semantic_relationships_from_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationships
    ADD CONSTRAINT semantic_relationships_from_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, from_entity_public_id) REFERENCES focowiki.semantic_entities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_relationships semantic_relationships_to_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_relationships
    ADD CONSTRAINT semantic_relationships_to_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, to_entity_public_id) REFERENCES focowiki.semantic_entities(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_reverse_references semantic_reverse_references_evidence_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_reverse_references
    ADD CONSTRAINT semantic_reverse_references_evidence_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id, evidence_public_id) REFERENCES focowiki.semantic_evidence(knowledge_base_id, semantic_generation_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_reverse_references semantic_reverse_references_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_reverse_references
    ADD CONSTRAINT semantic_reverse_references_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_reverse_references semantic_reverse_references_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_reverse_references
    ADD CONSTRAINT semantic_reverse_references_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_source_reconciliations semantic_source_reconciliations_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_source_reconciliations
    ADD CONSTRAINT semantic_source_reconciliations_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_source_reconciliations semantic_source_reconciliations_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_source_reconciliations
    ADD CONSTRAINT semantic_source_reconciliations_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_vector_documents semantic_vector_documents_artifact_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_vector_documents
    ADD CONSTRAINT semantic_vector_documents_artifact_fkey FOREIGN KEY (artifact_public_id) REFERENCES focowiki.embedding_artifacts(public_id) ON DELETE RESTRICT;


--
-- Name: semantic_vector_documents semantic_vector_documents_contract_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_vector_documents
    ADD CONSTRAINT semantic_vector_documents_contract_fkey FOREIGN KEY (projection_contract_public_id) REFERENCES focowiki.semantic_projection_contracts(public_id) ON DELETE CASCADE;


--
-- Name: semantic_vector_documents semantic_vector_documents_embedding_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_vector_documents
    ADD CONSTRAINT semantic_vector_documents_embedding_revision_fkey FOREIGN KEY (embedding_configuration_revision_public_id) REFERENCES focowiki.embedding_configuration_revisions(public_id) ON DELETE RESTRICT;


--
-- Name: semantic_vector_documents semantic_vector_documents_generation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_vector_documents
    ADD CONSTRAINT semantic_vector_documents_generation_fkey FOREIGN KEY (knowledge_base_id, semantic_generation_public_id) REFERENCES focowiki.semantic_generations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: semantic_vector_documents semantic_vector_documents_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.semantic_vector_documents
    ADD CONSTRAINT semantic_vector_documents_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: source_directories source_directories_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: source_directories source_directories_parent_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_directories
    ADD CONSTRAINT source_directories_parent_fkey FOREIGN KEY (knowledge_base_id, parent_public_id) REFERENCES focowiki.source_directories(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: source_file_active_revisions source_file_active_revisions_active_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_active_revisions
    ADD CONSTRAINT source_file_active_revisions_active_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, active_source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE RESTRICT;


--
-- Name: source_file_active_revisions source_file_active_revisions_current_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_active_revisions
    ADD CONSTRAINT source_file_active_revisions_current_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, current_source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE RESTRICT;


--
-- Name: source_file_active_revisions source_file_active_revisions_file_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_active_revisions
    ADD CONSTRAINT source_file_active_revisions_file_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id) REFERENCES focowiki.source_files(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: source_file_identity_keys source_file_identity_keys_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_file_identity_keys
    ADD CONSTRAINT source_file_identity_keys_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: source_files source_files_directory_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_directory_fkey FOREIGN KEY (knowledge_base_id, directory_public_id) REFERENCES focowiki.source_directories(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: source_files source_files_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_files
    ADD CONSTRAINT source_files_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- Name: source_revision_presentations source_revision_presentations_directory_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revision_presentations
    ADD CONSTRAINT source_revision_presentations_directory_fkey FOREIGN KEY (knowledge_base_id, directory_public_id) REFERENCES focowiki.source_directories(knowledge_base_id, public_id) ON DELETE SET NULL (directory_public_id);


--
-- Name: source_revision_presentations source_revision_presentations_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revision_presentations
    ADD CONSTRAINT source_revision_presentations_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: source_revisions source_revisions_file_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_file_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id) REFERENCES focowiki.source_files(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: source_revisions source_revisions_object_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.source_revisions
    ADD CONSTRAINT source_revisions_object_fkey FOREIGN KEY (object_id) REFERENCES focowiki.object_registrations(object_id) ON DELETE RESTRICT;


--
-- Name: unresolved_file_references unresolved_file_references_source_revision_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.unresolved_file_references
    ADD CONSTRAINT unresolved_file_references_source_revision_fkey FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE;


--
-- Name: unresolved_file_references unresolved_file_references_target_file_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.unresolved_file_references
    ADD CONSTRAINT unresolved_file_references_target_file_fkey FOREIGN KEY (knowledge_base_id, resolved_target_source_file_public_id) REFERENCES focowiki.source_files(knowledge_base_id, public_id) ON DELETE SET NULL (resolved_target_source_file_public_id);


--
-- Name: upload_entries upload_entries_object_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_entries
    ADD CONSTRAINT upload_entries_object_fkey FOREIGN KEY (object_id) REFERENCES focowiki.object_registrations(object_id) ON DELETE RESTRICT;


--
-- Name: upload_entries upload_entries_session_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_entries
    ADD CONSTRAINT upload_entries_session_fkey FOREIGN KEY (knowledge_base_id, upload_session_public_id) REFERENCES focowiki.upload_sessions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: upload_path_reservations upload_path_reservations_entry_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_path_reservations
    ADD CONSTRAINT upload_path_reservations_entry_fkey FOREIGN KEY (upload_session_public_id, upload_entry_public_id) REFERENCES focowiki.upload_entries(upload_session_public_id, entry_public_id) ON DELETE CASCADE;


--
-- Name: upload_path_reservations upload_path_reservations_session_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_path_reservations
    ADD CONSTRAINT upload_path_reservations_session_fkey FOREIGN KEY (knowledge_base_id, upload_session_public_id) REFERENCES focowiki.upload_sessions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.upload_sessions
    ADD CONSTRAINT upload_sessions_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_operation_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_operation_fkey FOREIGN KEY (knowledge_base_id, operation_public_id) REFERENCES focowiki.operations(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_redelivery_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_redelivery_fkey FOREIGN KEY (redelivery_of_public_id) REFERENCES focowiki.webhook_deliveries(public_id) ON DELETE SET NULL;


--
-- Name: webhook_deliveries webhook_deliveries_subscription_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_subscription_fkey FOREIGN KEY (knowledge_base_id, subscription_public_id) REFERENCES focowiki.webhook_subscriptions(knowledge_base_id, public_id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_subscription_public_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_subscription_public_fkey FOREIGN KEY (subscription_public_id) REFERENCES focowiki.webhook_subscriptions(public_id) ON DELETE CASCADE;


--
-- Name: webhook_subscriptions webhook_subscriptions_knowledge_base_fkey; Type: FK CONSTRAINT; Schema: focowiki; Owner: -
--

ALTER TABLE ONLY focowiki.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_knowledge_base_fkey FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

CREATE TABLE focowiki.document_artifact_work (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    document_job_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    work_kind text NOT NULL,
    resource_lane text NOT NULL,
    input_fingerprint_sha256 text NOT NULL,
    state text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    maximum_attempts integer NOT NULL,
    next_eligible_at timestamp with time zone NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    wait_time_milliseconds bigint DEFAULT 0 NOT NULL,
    service_time_milliseconds bigint DEFAULT 0 NOT NULL,
    safe_error_code text,
    safe_error_message text,
    retryable boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_artifact_work_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, work_kind, input_fingerprint_sha256),
    CONSTRAINT document_artifact_work_kind_check CHECK (work_kind = ANY (ARRAY['prepare'::text, 'first_layer'::text, 'content_projection'::text, 'graphrag'::text, 'relation_reconcile'::text, 'knowledge_projection'::text, 'activate'::text, 'cleanup'::text])),
    CONSTRAINT document_artifact_work_state_check CHECK (state = ANY (ARRAY['waiting'::text, 'running'::text, 'waiting_on_projection'::text, 'completed'::text, 'error'::text, 'cancelled'::text, 'superseded'::text])),
    CONSTRAINT document_artifact_work_lease_check CHECK ((((state = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((state <> 'running'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT document_artifact_work_value_check CHECK ((public_id <> ''::text) AND (input_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (attempt_count >= 0) AND (maximum_attempts BETWEEN 1 AND 100) AND (attempt_count <= maximum_attempts) AND (wait_time_milliseconds >= 0) AND (service_time_milliseconds >= 0) AND ((safe_error_message IS NULL) OR (octet_length(safe_error_message) <= 2048))),
    FOREIGN KEY (knowledge_base_id, document_job_public_id) REFERENCES focowiki.document_processing_jobs(knowledge_base_id, public_id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_artifact_receipts (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    document_job_public_id text NOT NULL,
    work_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    receipt_kind text NOT NULL,
    receipt_key text DEFAULT ''::text NOT NULL,
    input_fingerprint_sha256 text NOT NULL,
    output_fingerprint_sha256 text NOT NULL,
    receipt jsonb DEFAULT '{}'::jsonb NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_artifact_receipts_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, receipt_kind, receipt_key, input_fingerprint_sha256),
    CONSTRAINT document_artifact_receipts_kind_check CHECK (receipt_kind = ANY (ARRAY['parsed_source'::text, 'first_layer'::text, 'graphrag'::text, 'embedding'::text, 'search_family'::text, 'relation_reconciliation'::text, 'generated_page'::text, 'validation'::text, 'activation'::text, 'cleanup'::text])),
    CONSTRAINT document_artifact_receipts_value_check CHECK ((octet_length(receipt_key) <= 1024) AND (input_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (output_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(receipt) = 'object'::text) AND (octet_length(receipt::text) <= 131072)),
    FOREIGN KEY (work_public_id) REFERENCES focowiki.document_artifact_work(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_graphrag_chunks (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    document_job_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    chunk_number integer NOT NULL,
    input_fingerprint_sha256 text NOT NULL,
    state text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    output_receipt jsonb,
    safe_error_code text,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    CONSTRAINT document_graphrag_chunks_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, chunk_number, input_fingerprint_sha256),
    CONSTRAINT document_graphrag_chunks_value_check CHECK ((chunk_number >= 0) AND (input_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (state = ANY (ARRAY['waiting'::text, 'running'::text, 'completed'::text, 'error'::text])) AND ((output_receipt IS NULL) OR ((jsonb_typeof(output_receipt) = 'object'::text) AND (octet_length(output_receipt::text) <= 131072)))),
    FOREIGN KEY (knowledge_base_id, document_job_public_id) REFERENCES focowiki.document_processing_jobs(knowledge_base_id, public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.relation_candidate_pairs (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    first_source_file_public_id text NOT NULL,
    first_source_revision_public_id text NOT NULL,
    second_source_file_public_id text NOT NULL,
    second_source_revision_public_id text NOT NULL,
    evidence_fingerprint_sha256 text NOT NULL,
    state text NOT NULL,
    ambiguity_reason text,
    pending_endpoint_source_file_public_id text,
    next_eligible_at timestamp with time zone NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT relation_candidate_pairs_identity_key UNIQUE (knowledge_base_id, first_source_revision_public_id, second_source_revision_public_id),
    CONSTRAINT relation_candidate_pairs_value_check CHECK ((first_source_file_public_id COLLATE "C" < second_source_file_public_id COLLATE "C") AND (evidence_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (state = ANY (ARRAY['waiting'::text, 'running'::text, 'resolved'::text, 'ambiguous'::text, 'pending_endpoint'::text, 'retired'::text]))),
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.relation_directed_evidence (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    pair_public_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    target_source_file_public_id text NOT NULL,
    target_source_revision_public_id text NOT NULL,
    evidence_kind text NOT NULL,
    evidence_fingerprint_sha256 text NOT NULL,
    evidence jsonb NOT NULL,
    active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT relation_directed_evidence_identity_key UNIQUE (knowledge_base_id, pair_public_id, source_revision_public_id, target_source_revision_public_id, evidence_fingerprint_sha256),
    CONSTRAINT relation_directed_evidence_value_check CHECK ((evidence_kind = ANY (ARRAY['explicit_reference'::text, 'title_alias'::text, 'first_layer'::text, 'graphrag'::text])) AND (evidence_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(evidence) = 'object'::text) AND (octet_length(evidence::text) <= 65536)),
    FOREIGN KEY (pair_public_id) REFERENCES focowiki.relation_candidate_pairs(public_id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.canonical_file_relations (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    pair_public_id text NOT NULL,
    first_source_file_public_id text NOT NULL,
    first_source_revision_public_id text NOT NULL,
    second_source_file_public_id text NOT NULL,
    second_source_revision_public_id text NOT NULL,
    relation_kind text NOT NULL,
    direction text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    activated_sequence bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT canonical_file_relations_identity_key UNIQUE (knowledge_base_id, first_source_revision_public_id, second_source_revision_public_id),
    CONSTRAINT canonical_file_relations_value_check CHECK ((direction = ANY (ARRAY['first_to_second'::text, 'second_to_first'::text, 'bidirectional'::text])) AND ((NOT active) OR (activated_sequence IS NOT NULL))),
    FOREIGN KEY (pair_public_id) REFERENCES focowiki.relation_candidate_pairs(public_id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.search_family_receipts (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    provider_kind text NOT NULL,
    family text NOT NULL,
    input_fingerprint_sha256 text NOT NULL,
    provider_document_ids text[] DEFAULT '{}'::text[] NOT NULL,
    state text NOT NULL,
    acknowledged_at timestamp with time zone,
    active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_family_receipts_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, provider_kind, family, input_fingerprint_sha256),
    CONSTRAINT search_family_receipts_value_check CHECK ((family = ANY (ARRAY['content_metadata'::text, 'content_segments_vectors'::text, 'semantic_seed_vectors'::text, 'relation_evidence'::text, 'graph_seed'::text])) AND (provider_kind = ANY (ARRAY['opensearch'::text, 'meilisearch'::text])) AND (input_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (state = ANY (ARRAY['waiting'::text, 'buffered'::text, 'acknowledged'::text, 'error'::text]))),
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.generated_page_bases (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    input_fingerprint_sha256 text NOT NULL,
    object_id text NOT NULL,
    checksum_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_page_bases_source_revision_key UNIQUE (knowledge_base_id, source_revision_public_id, input_fingerprint_sha256),
    CONSTRAINT generated_page_bases_value_check CHECK ((input_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    FOREIGN KEY (object_id) REFERENCES focowiki.object_registrations(object_id) ON DELETE RESTRICT,
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.projection_dirty_scopes (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_key text NOT NULL,
    required_sequence bigint NOT NULL,
    completed_sequence bigint DEFAULT 0 NOT NULL,
    state text NOT NULL,
    next_eligible_at timestamp with time zone NOT NULL,
    coalesce_until timestamp with time zone NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    maximum_attempts integer DEFAULT 10 NOT NULL,
    safe_error_code text,
    safe_error_message text,
    retryable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_dirty_scopes_identity_key UNIQUE (knowledge_base_id, scope_kind, scope_key),
    CONSTRAINT projection_dirty_scopes_lease_check CHECK ((((state = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((state <> 'running'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT projection_dirty_scopes_value_check CHECK ((scope_kind = ANY (ARRAY['source'::text, 'relation'::text, 'directory'::text, 'graph'::text, '_index'::text, '_graph'::text, 'root'::text])) AND (scope_key <> ''::text) AND (required_sequence > 0) AND (completed_sequence >= 0) AND (completed_sequence <= required_sequence) AND (attempt_count >= 0) AND (maximum_attempts BETWEEN 1 AND 100) AND (attempt_count <= maximum_attempts) AND ((safe_error_code IS NULL) OR (octet_length(safe_error_code) <= 128)) AND ((safe_error_message IS NULL) OR (octet_length(safe_error_message) <= 2048)) AND (state = ANY (ARRAY['waiting'::text, 'running'::text, 'completed'::text, 'error'::text]))),
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_projection_records (
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    logical_path text NOT NULL,
    normalized_path text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    headings text[] DEFAULT '{}'::text[] NOT NULL,
    entities text[] DEFAULT '{}'::text[] NOT NULL,
    content_type text NOT NULL,
    checksum_sha256 text NOT NULL,
    byte_count bigint NOT NULL,
    tokenizer_contract_version text NOT NULL,
    navigation_term_fingerprint_sha256 text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    PRIMARY KEY (knowledge_base_id, source_revision_public_id),
    CONSTRAINT document_projection_records_value_check CHECK ((logical_path <> ''::text) AND (normalized_path <> ''::text) AND (title <> ''::text) AND (checksum_sha256 ~ '^[0-9a-f]{64}$'::text) AND (navigation_term_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (byte_count >= 0) AND (octet_length(tokenizer_contract_version) BETWEEN 1 AND 255) AND (jsonb_typeof(metadata) = 'object'::text)),
    FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_navigation_terms (
    knowledge_base_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    term text NOT NULL,
    bucket text NOT NULL,
    priority integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, source_revision_public_id, term),
    CONSTRAINT document_navigation_terms_value_check CHECK ((term <> ''::text) AND (octet_length(term) <= 512) AND (bucket = ANY (ARRAY['latin'::text, 'han'::text, 'kana'::text, 'hangul'::text, 'number'::text, 'other'::text])) AND (priority BETWEEN 1 AND 1000000)),
    FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.document_projection_records(knowledge_base_id, source_revision_public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_navigation_postings (
    knowledge_base_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    term text NOT NULL,
    page_path text NOT NULL,
    fields text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, source_revision_public_id, term),
    CONSTRAINT document_navigation_postings_value_check CHECK ((page_path <> ''::text) AND (cardinality(fields) BETWEEN 1 AND 8) AND (fields <@ ARRAY['title'::text, 'alias'::text, 'path'::text, 'heading'::text, 'metadata'::text, 'entity'::text, 'model_keyword'::text, 'body'::text])),
    FOREIGN KEY (knowledge_base_id, source_revision_public_id, term) REFERENCES focowiki.document_navigation_terms(knowledge_base_id, source_revision_public_id, term) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_semantic_directory_memberships (
    knowledge_base_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    directory_path text NOT NULL,
    page_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, source_revision_public_id, directory_path),
    FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.document_projection_records(knowledge_base_id, source_revision_public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_graph_degrees (
    knowledge_base_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    incoming_count integer DEFAULT 0 NOT NULL,
    outgoing_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, source_revision_public_id),
    CONSTRAINT document_graph_degrees_value_check CHECK ((incoming_count >= 0) AND (outgoing_count >= 0)),
    FOREIGN KEY (knowledge_base_id, source_revision_public_id) REFERENCES focowiki.document_projection_records(knowledge_base_id, source_revision_public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.projection_scope_contributions (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    document_job_public_id text NOT NULL,
    scope_public_id text NOT NULL,
    required_sequence bigint NOT NULL,
    state text DEFAULT 'waiting'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    CONSTRAINT projection_scope_contributions_identity_key UNIQUE (knowledge_base_id, source_revision_public_id, scope_public_id, required_sequence),
    CONSTRAINT projection_scope_contributions_value_check CHECK ((required_sequence > 0) AND (state = ANY (ARRAY['waiting'::text, 'acknowledged'::text]))),
    FOREIGN KEY (knowledge_base_id, source_file_public_id, source_revision_public_id) REFERENCES focowiki.source_revisions(knowledge_base_id, source_file_public_id, public_id) ON DELETE CASCADE,
    FOREIGN KEY (scope_public_id) REFERENCES focowiki.projection_dirty_scopes(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.projection_scope_receipts (
    contribution_public_id text PRIMARY KEY,
    scope_public_id text NOT NULL,
    rendered_sequence bigint NOT NULL,
    output_fingerprint_sha256 text NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_scope_receipts_value_check CHECK ((rendered_sequence > 0) AND (output_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text)),
    FOREIGN KEY (contribution_public_id) REFERENCES focowiki.projection_scope_contributions(public_id) ON DELETE CASCADE,
    FOREIGN KEY (scope_public_id) REFERENCES focowiki.projection_dirty_scopes(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.projection_scope_outputs (
    scope_public_id text NOT NULL,
    rendered_sequence bigint NOT NULL,
    knowledge_base_id text NOT NULL,
    output_fingerprint_sha256 text NOT NULL,
    pages jsonb DEFAULT '[]'::jsonb NOT NULL,
    removed_normalized_paths text[] DEFAULT '{}'::text[] NOT NULL,
    navigation_mutations jsonb DEFAULT '[]'::jsonb NOT NULL,
    activation_owner_versions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (scope_public_id, rendered_sequence),
    CONSTRAINT projection_scope_outputs_value_check CHECK ((rendered_sequence > 0) AND (output_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(pages) = 'array'::text) AND (jsonb_array_length(pages) <= 256) AND (octet_length(pages::text) <= 1048576) AND (cardinality(removed_normalized_paths) <= 256) AND (jsonb_typeof(navigation_mutations) = 'array'::text) AND (jsonb_array_length(navigation_mutations) <= 256) AND (octet_length(navigation_mutations::text) <= 1048576) AND (jsonb_typeof(activation_owner_versions) = 'array'::text) AND (jsonb_array_length(activation_owner_versions) <= 30000) AND (octet_length(activation_owner_versions::text) <= 4194304)),
    FOREIGN KEY (scope_public_id) REFERENCES focowiki.projection_dirty_scopes(public_id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.projection_scope_storage_metrics (
    scope_public_id text NOT NULL,
    rendered_sequence bigint NOT NULL,
    knowledge_base_id text NOT NULL,
    put_count integer DEFAULT 0 NOT NULL,
    head_count integer DEFAULT 0 NOT NULL,
    verification_count integer DEFAULT 0 NOT NULL,
    attempted_bytes bigint DEFAULT 0 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    latency_milliseconds bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (scope_public_id, rendered_sequence),
    CONSTRAINT projection_scope_storage_metrics_value_check CHECK ((rendered_sequence > 0) AND (put_count >= 0) AND (head_count >= 0) AND (verification_count >= 0) AND (attempted_bytes >= 0) AND (retry_count >= 0) AND (latency_milliseconds >= 0)),
    FOREIGN KEY (scope_public_id) REFERENCES focowiki.projection_dirty_scopes(public_id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.document_projection_waiting_completions (
    work_public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    document_job_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    receipt_key text NOT NULL,
    input_fingerprint_sha256 text NOT NULL,
    output_fingerprint_sha256 text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_projection_waiting_completion_value_check CHECK ((receipt_key <> ''::text) AND (input_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (output_fingerprint_sha256 ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(receipt) = 'object'::text) AND (octet_length(receipt::text) <= 131072)),
    FOREIGN KEY (work_public_id) REFERENCES focowiki.document_artifact_work(public_id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id, document_job_public_id) REFERENCES focowiki.document_processing_jobs(knowledge_base_id, public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.scoped_activation_owners (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    owner_kind text NOT NULL,
    owner_key text NOT NULL,
    owner_version bigint DEFAULT 0 NOT NULL,
    active_source_revision_public_id text,
    active_page_candidate_public_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scoped_activation_owners_identity_key UNIQUE (knowledge_base_id, owner_kind, owner_key),
    CONSTRAINT scoped_activation_owners_value_check CHECK ((owner_kind = ANY (ARRAY['source'::text, 'relation_pair'::text, 'directory_leaf'::text, 'directory_entry'::text, 'search_family'::text, 'page_head'::text])) AND (owner_key <> ''::text) AND (owner_version >= 0)),
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

CREATE TABLE focowiki.knowledge_base_sequences (
    knowledge_base_id text PRIMARY KEY,
    current_sequence bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_base_sequences_value_check CHECK (current_sequence >= 0),
    FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE
);

ALTER TABLE ONLY focowiki.generated_page_candidates
    ADD CONSTRAINT generated_page_candidates_work_fkey FOREIGN KEY (source_work_public_id) REFERENCES focowiki.document_artifact_work(public_id) ON DELETE CASCADE;

ALTER TABLE ONLY focowiki.object_owners
    ADD CONSTRAINT object_owners_receipt_fkey FOREIGN KEY (source_receipt_public_id) REFERENCES focowiki.document_artifact_receipts(public_id) ON DELETE CASCADE;

CREATE INDEX document_artifact_work_claim_idx ON focowiki.document_artifact_work (resource_lane, next_eligible_at, created_at, public_id) WHERE state = 'waiting';
CREATE INDEX document_artifact_work_lease_idx ON focowiki.document_artifact_work (lease_expires_at, public_id) WHERE state = 'running';
CREATE INDEX document_artifact_work_job_idx ON focowiki.document_artifact_work (knowledge_base_id, document_job_public_id, work_kind);
CREATE INDEX document_artifact_receipts_source_revision_idx ON focowiki.document_artifact_receipts (knowledge_base_id, source_revision_public_id, receipt_kind);
CREATE INDEX document_graphrag_chunks_claim_idx ON focowiki.document_graphrag_chunks (state, lease_expires_at, public_id);
CREATE INDEX relation_candidate_pairs_claim_idx ON focowiki.relation_candidate_pairs (state, next_eligible_at, public_id);
CREATE INDEX relation_directed_evidence_source_idx ON focowiki.relation_directed_evidence (knowledge_base_id, source_revision_public_id, active);
CREATE INDEX canonical_file_relations_first_active_idx ON focowiki.canonical_file_relations (knowledge_base_id, first_source_file_public_id) WHERE active;
CREATE INDEX canonical_file_relations_second_active_idx ON focowiki.canonical_file_relations (knowledge_base_id, second_source_file_public_id) WHERE active;
CREATE INDEX canonical_file_relations_first_pending_projection_idx ON focowiki.canonical_file_relations (knowledge_base_id, first_source_file_public_id, first_source_revision_public_id) WHERE NOT active AND retired_at IS NULL;
CREATE INDEX canonical_file_relations_second_pending_projection_idx ON focowiki.canonical_file_relations (knowledge_base_id, second_source_file_public_id, second_source_revision_public_id) WHERE NOT active AND retired_at IS NULL;
CREATE INDEX search_family_receipts_flush_idx ON focowiki.search_family_receipts (provider_kind, state, created_at, public_id) WHERE state = 'buffered';
CREATE INDEX generated_page_bases_source_revision_idx ON focowiki.generated_page_bases (knowledge_base_id, source_revision_public_id);
CREATE INDEX generated_page_heads_semantic_scope_idx ON focowiki.generated_page_heads (knowledge_base_id, normalized_path text_pattern_ops, logical_path);
CREATE INDEX projection_dirty_scopes_claim_idx ON focowiki.projection_dirty_scopes (state, coalesce_until, next_eligible_at, public_id) WHERE state = 'waiting';
CREATE INDEX projection_dirty_scopes_lease_idx ON focowiki.projection_dirty_scopes (lease_expires_at, public_id) WHERE state = 'running';
CREATE INDEX document_projection_records_active_path_idx ON focowiki.document_projection_records (knowledge_base_id, normalized_path, source_revision_public_id) WHERE active;
CREATE INDEX document_navigation_terms_bucket_idx ON focowiki.document_navigation_terms (knowledge_base_id, bucket, term COLLATE "C", source_revision_public_id);
CREATE INDEX document_navigation_postings_path_idx ON focowiki.document_navigation_postings (knowledge_base_id, page_path, term COLLATE "C");
CREATE INDEX document_semantic_directory_memberships_scope_idx ON focowiki.document_semantic_directory_memberships (knowledge_base_id, directory_path, page_path);
CREATE INDEX document_graph_degrees_relation_idx ON focowiki.document_graph_degrees (knowledge_base_id, source_revision_public_id) WHERE (incoming_count + outgoing_count) > 0;
CREATE INDEX projection_scope_contributions_waiting_idx ON focowiki.projection_scope_contributions (scope_public_id, required_sequence, public_id) WHERE state = 'waiting';
CREATE INDEX projection_scope_receipts_scope_output_idx ON focowiki.projection_scope_receipts (scope_public_id, rendered_sequence, contribution_public_id);
CREATE INDEX projection_scope_outputs_created_idx ON focowiki.projection_scope_outputs (knowledge_base_id, created_at, scope_public_id, rendered_sequence);
CREATE INDEX document_projection_waiting_ready_idx ON focowiki.document_projection_waiting_completions (document_job_public_id, work_public_id);
CREATE INDEX scoped_activation_owners_scope_idx ON focowiki.scoped_activation_owners (knowledge_base_id, owner_kind, owner_key, owner_version);

INSERT INTO focowiki.runtime_generation (singleton, generation)
VALUES (true, 'storage-vnext-v9-document-indexing-hybrid');
