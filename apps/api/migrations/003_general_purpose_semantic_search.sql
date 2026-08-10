CREATE TABLE focowiki.embedding_configurations (
  public_id text PRIMARY KEY,
  display_name text NOT NULL,
  lifecycle_status text NOT NULL,
  active_revision_public_id text,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT embedding_configurations_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND display_name <> '' AND octet_length(display_name) <= 255
  ),
  CONSTRAINT embedding_configurations_lifecycle_check CHECK (
    lifecycle_status IN ('draft', 'active', 'paused')
  ),
  CONSTRAINT embedding_configurations_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.embedding_configuration_revisions (
  public_id text PRIMARY KEY,
  configuration_public_id text NOT NULL,
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
  maximum_response_bytes integer NOT NULL,
  minimum_vector_relevance double precision NOT NULL,
  vector_producing_revision_public_id text NOT NULL,
  validation_status text NOT NULL,
  validation_fingerprint_sha256 text,
  safe_validation_error_code text,
  validated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT embedding_configuration_revisions_configuration_key UNIQUE (
    configuration_public_id, revision_number
  ),
  CONSTRAINT embedding_configuration_revisions_scope_key UNIQUE (
    configuration_public_id, public_id
  ),
  CONSTRAINT embedding_configuration_revisions_configuration_fkey FOREIGN KEY (
    configuration_public_id
  ) REFERENCES focowiki.embedding_configurations (public_id) ON DELETE CASCADE,
  CONSTRAINT embedding_configuration_revisions_vector_revision_fkey FOREIGN KEY (
    vector_producing_revision_public_id
  ) REFERENCES focowiki.embedding_configuration_revisions (public_id)
    ON DELETE RESTRICT,
  CONSTRAINT embedding_configuration_revisions_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND vector_producing_revision_public_id <> ''
    AND octet_length(vector_producing_revision_public_id) <= 255
    AND base_url <> '' AND octet_length(base_url) <= 2048
    AND model_name <> '' AND octet_length(model_name) <= 255
  ),
  CONSTRAINT embedding_configuration_revisions_authentication_check CHECK (
    (authentication_mode = 'api_key' AND encrypted_api_key IS NOT NULL)
    OR (authentication_mode = 'none' AND encrypted_api_key IS NULL)
  ),
  CONSTRAINT embedding_configuration_revisions_dimension_check CHECK (
    (requested_dimension IS NULL OR requested_dimension BETWEEN 1 AND 65536)
    AND (resolved_dimension IS NULL OR resolved_dimension BETWEEN 1 AND 65536)
  ),
  CONSTRAINT embedding_configuration_revisions_normalization_check CHECK (
    normalization IN ('none', 'l2')
  ),
  CONSTRAINT embedding_configuration_revisions_bounds_check CHECK (
    revision_number >= 1
    AND maximum_input_tokens BETWEEN 1 AND 1048576
    AND batch_size BETWEEN 1 AND 2048
    AND timeout_ms BETWEEN 100 AND 300000
    AND retry_count BETWEEN 0 AND 10
    AND minimum_interval_ms BETWEEN 0 AND 60000
    AND concurrency BETWEEN 1 AND 64
    AND maximum_response_bytes BETWEEN 1024 AND 67108864
    AND minimum_vector_relevance >= 0
    AND minimum_vector_relevance <= 1
  ),
  CONSTRAINT embedding_configuration_revisions_validation_check CHECK (
    validation_status IN ('not_tested', 'valid', 'invalid')
    AND (validation_fingerprint_sha256 IS NULL
      OR validation_fingerprint_sha256 ~ '^[0-9a-f]{64}$')
    AND (safe_validation_error_code IS NULL
      OR octet_length(safe_validation_error_code) <= 128)
    AND (
      validation_status <> 'valid'
      OR resolved_dimension IS NOT NULL
        AND validation_fingerprint_sha256 IS NOT NULL
        AND validated_at IS NOT NULL
        AND safe_validation_error_code IS NULL
    )
  )
);

ALTER TABLE focowiki.embedding_configurations
  ADD CONSTRAINT embedding_configurations_active_revision_fkey FOREIGN KEY (
    public_id, active_revision_public_id
  ) REFERENCES focowiki.embedding_configuration_revisions (
    configuration_public_id, public_id
  ) ON DELETE RESTRICT;

CREATE TABLE focowiki.reranker_configurations (
  public_id text PRIMARY KEY,
  display_name text NOT NULL,
  lifecycle_status text NOT NULL,
  active_revision_public_id text,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT reranker_configurations_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND display_name <> '' AND octet_length(display_name) <= 255
  ),
  CONSTRAINT reranker_configurations_lifecycle_check CHECK (
    lifecycle_status IN ('draft', 'active', 'paused')
  ),
  CONSTRAINT reranker_configurations_revision_check CHECK (revision >= 1)
);

CREATE TABLE focowiki.reranker_configuration_revisions (
  public_id text PRIMARY KEY,
  configuration_public_id text NOT NULL,
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
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT reranker_configuration_revisions_configuration_key UNIQUE (
    configuration_public_id, revision_number
  ),
  CONSTRAINT reranker_configuration_revisions_scope_key UNIQUE (
    configuration_public_id, public_id
  ),
  CONSTRAINT reranker_configuration_revisions_configuration_fkey FOREIGN KEY (
    configuration_public_id
  ) REFERENCES focowiki.reranker_configurations (public_id) ON DELETE CASCADE,
  CONSTRAINT reranker_configuration_revisions_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND base_url <> '' AND octet_length(base_url) <= 2048
    AND model_name <> '' AND octet_length(model_name) <= 255
  ),
  CONSTRAINT reranker_configuration_revisions_authentication_check CHECK (
    (authentication_mode = 'api_key' AND encrypted_api_key IS NOT NULL)
    OR (authentication_mode = 'none' AND encrypted_api_key IS NULL)
  ),
  CONSTRAINT reranker_configuration_revisions_bounds_check CHECK (
    revision_number >= 1
    AND timeout_ms BETWEEN 100 AND 300000
    AND retry_count BETWEEN 0 AND 10
    AND minimum_interval_ms BETWEEN 0 AND 60000
    AND concurrency BETWEEN 1 AND 64
  ),
  CONSTRAINT reranker_configuration_revisions_validation_check CHECK (
    validation_status IN ('not_tested', 'valid', 'invalid')
    AND (validation_fingerprint_sha256 IS NULL
      OR validation_fingerprint_sha256 ~ '^[0-9a-f]{64}$')
    AND (safe_validation_error_code IS NULL
      OR octet_length(safe_validation_error_code) <= 128)
    AND (validation_status <> 'valid'
      OR validation_fingerprint_sha256 IS NOT NULL
        AND validated_at IS NOT NULL
        AND safe_validation_error_code IS NULL)
  )
);

ALTER TABLE focowiki.reranker_configurations
  ADD CONSTRAINT reranker_configurations_active_revision_fkey FOREIGN KEY (
    public_id, active_revision_public_id
  ) REFERENCES focowiki.reranker_configuration_revisions (
    configuration_public_id, public_id
  ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX reranker_configurations_one_active_idx
  ON focowiki.reranker_configurations (lifecycle_status)
  WHERE lifecycle_status = 'active';

CREATE TABLE focowiki.semantic_generations (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_public_id text NOT NULL,
  expected_predecessor_public_id text,
  generation_role text NOT NULL,
  state text NOT NULL,
  generation_model_configuration_public_id text NOT NULL,
  generation_model_configuration_revision bigint NOT NULL,
  extraction_contract_version text NOT NULL,
  graph_schema_version text NOT NULL,
  prompt_contract_version text NOT NULL,
  contract_fingerprint_sha256 text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  activated_at timestamp with time zone,
  deleted_at timestamp with time zone,
  CONSTRAINT semantic_generations_scope_key UNIQUE (knowledge_base_id, public_id),
  CONSTRAINT semantic_generations_knowledge_base_fkey FOREIGN KEY (
    knowledge_base_id
  ) REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_generations_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_generations_predecessor_fkey FOREIGN KEY (
    knowledge_base_id, expected_predecessor_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE RESTRICT,
  CONSTRAINT semantic_generations_identity_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND generation_model_configuration_public_id <> ''
    AND octet_length(generation_model_configuration_public_id) <= 255
    AND generation_model_configuration_revision >= 0
    AND extraction_contract_version <> ''
    AND octet_length(extraction_contract_version) <= 128
    AND graph_schema_version <> '' AND octet_length(graph_schema_version) <= 128
    AND prompt_contract_version <> '' AND octet_length(prompt_contract_version) <= 128
    AND contract_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT semantic_generations_role_check CHECK (
    generation_role IN ('candidate', 'active', 'historical')
  ),
  CONSTRAINT semantic_generations_state_check CHECK (
    state IN ('building', 'validating', 'ready', 'active', 'failed', 'cancelled', 'superseded', 'cleanup_failed')
  ),
  CONSTRAINT semantic_generations_active_check CHECK (
    (generation_role = 'active' AND state = 'active' AND activated_at IS NOT NULL)
    OR generation_role = 'candidate' AND state <> 'active' AND activated_at IS NULL
    OR generation_role = 'historical' AND state = 'superseded' AND activated_at IS NOT NULL
  ),
  CONSTRAINT semantic_generations_revision_check CHECK (revision >= 0)
);

CREATE TABLE focowiki.semantic_projection_contracts (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  embedding_configuration_revision_public_id text NOT NULL,
  embedding_query_policy_revision_public_id text NOT NULL,
  minimum_vector_relevance double precision NOT NULL,
  search_provider_kind text NOT NULL,
  resolved_dimension integer NOT NULL,
  normalization text NOT NULL,
  artifact_schema_version text NOT NULL,
  vector_schema_version text NOT NULL,
  mapping_fingerprint_sha256 text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT semantic_projection_contracts_scope_key UNIQUE (
    knowledge_base_id, semantic_generation_public_id
  ),
  CONSTRAINT semantic_projection_contracts_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_projection_contracts_embedding_revision_fkey FOREIGN KEY (
    embedding_configuration_revision_public_id
  ) REFERENCES focowiki.embedding_configuration_revisions (public_id) ON DELETE RESTRICT,
  CONSTRAINT semantic_projection_contracts_query_policy_revision_fkey FOREIGN KEY (
    embedding_query_policy_revision_public_id
  ) REFERENCES focowiki.embedding_configuration_revisions (public_id) ON DELETE RESTRICT,
  CONSTRAINT semantic_projection_contracts_contract_check CHECK (
    search_provider_kind IN ('meilisearch', 'opensearch')
    AND resolved_dimension BETWEEN 1 AND 65536
    AND minimum_vector_relevance >= 0
    AND minimum_vector_relevance <= 1
    AND normalization IN ('none', 'l2')
    AND artifact_schema_version <> '' AND octet_length(artifact_schema_version) <= 128
    AND vector_schema_version <> '' AND octet_length(vector_schema_version) <= 128
    AND mapping_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE focowiki.semantic_source_reconciliations (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  extraction_contract_version text NOT NULL,
  canonical_input_sha256 text NOT NULL,
  skeleton_policy_version text NOT NULL,
  skeleton_selected boolean NOT NULL,
  source_chunk_count integer NOT NULL,
  selected_chunk_count integer NOT NULL,
  selection_reasons jsonb NOT NULL,
  selection_decision_sha256 text NOT NULL,
  entity_count integer NOT NULL,
  relationship_count integer NOT NULL,
  evidence_count integer NOT NULL,
  affected_closure jsonb NOT NULL,
  reconciled_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (
    semantic_generation_public_id, source_file_public_id,
    source_revision_public_id
  ),
  CONSTRAINT semantic_source_reconciliations_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_source_reconciliations_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_source_reconciliations_counts_check CHECK (
    extraction_contract_version <> ''
    AND octet_length(extraction_contract_version) <= 255
    AND canonical_input_sha256 ~ '^[0-9a-f]{64}$'
    AND skeleton_policy_version <> ''
    AND octet_length(skeleton_policy_version) <= 255
    AND source_chunk_count BETWEEN 1 AND 32
    AND selected_chunk_count BETWEEN 0 AND LEAST(8, source_chunk_count)
    AND skeleton_selected = (selected_chunk_count > 0)
    AND jsonb_typeof(selection_reasons) = 'array'
    AND jsonb_array_length(selection_reasons) <= 8
    AND octet_length(selection_reasons::text) <= 1024
    AND selection_decision_sha256 ~ '^[0-9a-f]{64}$'
    AND entity_count BETWEEN 0 AND 2000
    AND relationship_count BETWEEN 0 AND 4000
    AND evidence_count BETWEEN 0 AND 4000
    AND jsonb_typeof(affected_closure) = 'object'
    AND octet_length(affected_closure::text) <= 4194304
  )
);

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
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_entities_scope_key UNIQUE (
    knowledge_base_id, semantic_generation_public_id, public_id
  ),
  CONSTRAINT semantic_entities_canonical_key UNIQUE (
    semantic_generation_public_id, canonical_key
  ),
  CONSTRAINT semantic_entities_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_entities_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND canonical_key <> '' AND octet_length(canonical_key) <= 1024
    AND entity_kind <> '' AND octet_length(entity_kind) <= 128
    AND label <> '' AND octet_length(label) <= 1024
    AND (description IS NULL OR octet_length(description) <= 8192)
    AND extraction_contract_version <> ''
    AND octet_length(extraction_contract_version) <= 128
    AND confidence BETWEEN 0 AND 1
    AND provenance_kind IN ('deterministic', 'model')
    AND revision >= 0
  )
);

CREATE TABLE focowiki.semantic_entity_aliases (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  entity_public_id text NOT NULL,
  normalized_alias text NOT NULL,
  display_alias text NOT NULL,
  PRIMARY KEY (
    semantic_generation_public_id, entity_public_id, normalized_alias
  ),
  CONSTRAINT semantic_entity_aliases_entity_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, entity_public_id
  ) REFERENCES focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_entity_aliases_value_check CHECK (
    normalized_alias <> '' AND octet_length(normalized_alias) <= 1024
    AND display_alias <> '' AND octet_length(display_alias) <= 1024
  )
);

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
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_evidence_scope_key UNIQUE (
    knowledge_base_id, semantic_generation_public_id, public_id
  ),
  CONSTRAINT semantic_evidence_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_evidence_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_evidence_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND logical_path <> '' AND octet_length(logical_path) <= 4096
    AND start_offset >= 0 AND end_offset >= start_offset
    AND excerpt_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND extraction_contract_version <> ''
    AND octet_length(extraction_contract_version) <= 128
  )
);

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
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_mentions_identity_key UNIQUE (
    semantic_generation_public_id, entity_public_id, evidence_public_id
  ),
  CONSTRAINT semantic_mentions_entity_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, entity_public_id
  ) REFERENCES focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_mentions_evidence_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, evidence_public_id
  ) REFERENCES focowiki.semantic_evidence (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_mentions_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_mentions_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND mention_text <> '' AND octet_length(mention_text) <= 2048
    AND confidence BETWEEN 0 AND 1
  )
);

CREATE TABLE focowiki.semantic_entity_observations (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  entity_public_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  label text NOT NULL,
  description text,
  aliases jsonb NOT NULL,
  extraction_contract_version text NOT NULL,
  confidence double precision NOT NULL,
  provenance_kind text NOT NULL,
  CONSTRAINT semantic_entity_observations_identity_key PRIMARY KEY (
    semantic_generation_public_id, entity_public_id, source_revision_public_id
  ),
  CONSTRAINT semantic_entity_observations_entity_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, entity_public_id
  ) REFERENCES focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_entity_observations_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_entity_observations_value_check CHECK (
    label <> '' AND octet_length(label) <= 1024
    AND (description IS NULL OR octet_length(description) <= 8192)
    AND jsonb_typeof(aliases) = 'array'
    AND jsonb_array_length(aliases) <= 128
    AND octet_length(aliases::text) <= 131072
    AND extraction_contract_version <> ''
    AND octet_length(extraction_contract_version) <= 128
    AND confidence BETWEEN 0 AND 1
    AND provenance_kind IN ('deterministic', 'model')
  )
);

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
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_relationships_scope_key UNIQUE (
    knowledge_base_id, semantic_generation_public_id, public_id
  ),
  CONSTRAINT semantic_relationships_identity_key UNIQUE (
    semantic_generation_public_id,
    from_entity_public_id,
    to_entity_public_id,
    relationship_kind
  ),
  CONSTRAINT semantic_relationships_from_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, from_entity_public_id
  ) REFERENCES focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_relationships_to_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, to_entity_public_id
  ) REFERENCES focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_relationships_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND from_entity_public_id <> to_entity_public_id
    AND relationship_kind <> '' AND octet_length(relationship_kind) <= 128
    AND (description IS NULL OR octet_length(description) <= 8192)
    AND confidence BETWEEN 0 AND 1
    AND provenance_kind IN ('deterministic', 'model')
    AND revision >= 0
  )
);

CREATE TABLE focowiki.semantic_relationship_evidence (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  relationship_public_id text NOT NULL,
  evidence_public_id text NOT NULL,
  PRIMARY KEY (
    semantic_generation_public_id, relationship_public_id, evidence_public_id
  ),
  CONSTRAINT semantic_relationship_evidence_relationship_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, relationship_public_id
  ) REFERENCES focowiki.semantic_relationships (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_relationship_evidence_evidence_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, evidence_public_id
  ) REFERENCES focowiki.semantic_evidence (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE
);

CREATE TABLE focowiki.semantic_relationship_observations (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  relationship_public_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  description text,
  confidence double precision NOT NULL,
  provenance_kind text NOT NULL,
  CONSTRAINT semantic_relationship_observations_identity_key PRIMARY KEY (
    semantic_generation_public_id,
    relationship_public_id,
    source_revision_public_id
  ),
  CONSTRAINT semantic_relationship_observations_relationship_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, relationship_public_id
  ) REFERENCES focowiki.semantic_relationships (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_relationship_observations_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_relationship_observations_value_check CHECK (
    (description IS NULL OR octet_length(description) <= 8192)
    AND confidence BETWEEN 0 AND 1
    AND provenance_kind IN ('deterministic', 'model')
  )
);

CREATE TABLE focowiki.semantic_reverse_references (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  target_kind text NOT NULL,
  target_public_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_revision_public_id text NOT NULL,
  evidence_public_id text NOT NULL,
  PRIMARY KEY (
    semantic_generation_public_id,
    target_kind,
    target_public_id,
    source_file_public_id,
    evidence_public_id
  ),
  CONSTRAINT semantic_reverse_references_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_reverse_references_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_reverse_references_evidence_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, evidence_public_id
  ) REFERENCES focowiki.semantic_evidence (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_reverse_references_kind_check CHECK (
    target_kind IN ('entity', 'relationship', 'file')
  )
);

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
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_communities_scope_key UNIQUE (
    knowledge_base_id, semantic_generation_public_id, public_id
  ),
  CONSTRAINT semantic_communities_partition_key UNIQUE (
    semantic_generation_public_id, partition_key
  ),
  CONSTRAINT semantic_communities_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_communities_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND source_partition_key <> ''
    AND octet_length(source_partition_key) <= 1024
    AND partition_key <> '' AND octet_length(partition_key) <= 1024
    AND level BETWEEN 0 AND 64
    AND (title IS NULL OR octet_length(title) <= 1024)
    AND revision >= 0
  )
);

CREATE TABLE focowiki.semantic_community_memberships (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  community_public_id text NOT NULL,
  entity_public_id text NOT NULL,
  membership_weight double precision NOT NULL,
  PRIMARY KEY (
    semantic_generation_public_id, community_public_id, entity_public_id
  ),
  CONSTRAINT semantic_community_memberships_community_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, community_public_id
  ) REFERENCES focowiki.semantic_communities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_community_memberships_entity_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, entity_public_id
  ) REFERENCES focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_community_memberships_weight_check CHECK (
    membership_weight > 0 AND membership_weight <= 1
  )
);

CREATE TABLE focowiki.semantic_community_reports (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  public_id text NOT NULL,
  community_public_id text NOT NULL,
  input_graph_version text NOT NULL,
  boundary_version text NOT NULL,
  summary text NOT NULL,
  report_checksum_sha256 text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_community_reports_community_key UNIQUE (
    semantic_generation_public_id, community_public_id
  ),
  CONSTRAINT semantic_community_reports_community_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, community_public_id
  ) REFERENCES focowiki.semantic_communities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_community_reports_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND input_graph_version <> '' AND octet_length(input_graph_version) <= 255
    AND boundary_version <> '' AND octet_length(boundary_version) <= 255
    AND summary <> '' AND octet_length(summary) <= 65536
    AND report_checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE focowiki.semantic_community_summary_artifacts (
  knowledge_base_id text NOT NULL,
  public_id text NOT NULL,
  input_sha256 text NOT NULL,
  model_configuration_public_id text NOT NULL,
  model_configuration_revision bigint NOT NULL,
  prompt_contract_version text NOT NULL,
  summary text NOT NULL,
  summary_sha256 text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_base_id, public_id),
  CONSTRAINT semantic_community_summary_artifacts_identity_key UNIQUE (
    knowledge_base_id, input_sha256, model_configuration_public_id,
    model_configuration_revision, prompt_contract_version
  ),
  CONSTRAINT semantic_community_summary_artifacts_knowledge_base_fkey
    FOREIGN KEY (knowledge_base_id)
    REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_community_summary_artifacts_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND input_sha256 ~ '^[0-9a-f]{64}$'
    AND model_configuration_public_id <> ''
    AND octet_length(model_configuration_public_id) <= 255
    AND model_configuration_revision >= 1
    AND prompt_contract_version <> ''
    AND octet_length(prompt_contract_version) <= 255
    AND summary <> '' AND octet_length(summary) <= 65536
    AND summary_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE focowiki.semantic_entity_partitions (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  entity_public_id text NOT NULL,
  partition_key text NOT NULL,
  input_version text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (semantic_generation_public_id, entity_public_id),
  CONSTRAINT semantic_entity_partitions_entity_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id, entity_public_id
  ) REFERENCES focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_entity_partitions_value_check CHECK (
    partition_key <> '' AND octet_length(partition_key) <= 1024
    AND input_version <> '' AND octet_length(input_version) <= 255
  )
);

CREATE TABLE focowiki.semantic_dirty_partitions (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  public_id text NOT NULL,
  partition_key text NOT NULL,
  reason_kind text NOT NULL,
  input_version text NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_owner text,
  lease_expires_at timestamp with time zone,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  safe_error_code text,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_dirty_partitions_partition_key UNIQUE (
    semantic_generation_public_id, partition_key
  ),
  CONSTRAINT semantic_dirty_partitions_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_dirty_partitions_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND partition_key <> '' AND octet_length(partition_key) <= 1024
    AND reason_kind IN ('entity_changed', 'relationship_changed', 'membership_changed', 'deleted', 'merge', 'split')
    AND input_version <> '' AND octet_length(input_version) <= 255
    AND state IN ('dirty', 'processing', 'completed', 'failed', 'cancelled', 'superseded')
    AND attempt_count BETWEEN 0 AND 100
    AND jsonb_typeof(checkpoint) = 'object'
    AND octet_length(checkpoint::text) <= 32768
    AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
    AND revision >= 0
    AND (
      state = 'processing' AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL
      OR state <> 'processing' AND lease_owner IS NULL
        AND lease_expires_at IS NULL
    )
  )
);

ALTER TABLE focowiki.object_owners
  DROP CONSTRAINT object_owners_identity_key,
  DROP CONSTRAINT object_owners_kind_check,
  DROP CONSTRAINT object_owners_target_check,
  DROP COLUMN owner_public_id,
  ADD COLUMN embedding_artifact_public_id text,
  ADD COLUMN owner_public_id text GENERATED ALWAYS AS (
    coalesce(
      source_revision_public_id,
      release_root_public_id,
      release_shard_public_id,
      operation_public_id,
      embedding_artifact_public_id
    )
  ) STORED,
  ADD CONSTRAINT object_owners_identity_key UNIQUE (
    object_id, owner_kind, owner_public_id
  ),
  ADD CONSTRAINT object_owners_kind_check CHECK (
    owner_kind IN (
      'source_revision', 'active_root', 'candidate_root',
      'rollback_root', 'shared_segment', 'live_reservation',
      'embedding_artifact'
    )
  ),
  ADD CONSTRAINT object_owners_target_check CHECK (
    (source_revision_public_id IS NOT NULL)::integer
    + (release_root_public_id IS NOT NULL)::integer
    + (release_shard_public_id IS NOT NULL)::integer
    + (operation_public_id IS NOT NULL)::integer
    + (embedding_artifact_public_id IS NOT NULL)::integer = 1
    AND (
      (owner_kind = 'source_revision' AND source_revision_public_id IS NOT NULL)
      OR (owner_kind IN ('active_root', 'candidate_root', 'rollback_root')
        AND release_root_public_id IS NOT NULL)
      OR (owner_kind = 'shared_segment' AND release_shard_public_id IS NOT NULL)
      OR (owner_kind = 'live_reservation' AND operation_public_id IS NOT NULL)
      OR (owner_kind = 'embedding_artifact'
        AND embedding_artifact_public_id IS NOT NULL)
    )
  );

CREATE TABLE focowiki.embedding_artifacts (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  object_id text NOT NULL,
  owner_kind text NOT NULL,
  owner_public_id text NOT NULL,
  source_revision_public_id text,
  canonical_input_sha256 text NOT NULL,
  input_kind text NOT NULL,
  embedding_configuration_revision_public_id text NOT NULL,
  normalization text NOT NULL,
  dimension integer NOT NULL,
  artifact_schema_version text NOT NULL,
  vector_checksum_sha256 text NOT NULL,
  byte_count bigint NOT NULL,
  state text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT embedding_artifacts_identity_key UNIQUE NULLS NOT DISTINCT (
    knowledge_base_id,
    owner_kind,
    owner_public_id,
    source_revision_public_id,
    canonical_input_sha256,
    input_kind,
    embedding_configuration_revision_public_id,
    normalization,
    dimension,
    artifact_schema_version
  ),
  CONSTRAINT embedding_artifacts_knowledge_base_fkey FOREIGN KEY (
    knowledge_base_id
  ) REFERENCES focowiki.knowledge_bases (public_id) ON DELETE CASCADE,
  CONSTRAINT embedding_artifacts_object_fkey FOREIGN KEY (
    object_id
  ) REFERENCES focowiki.object_registrations (object_id) ON DELETE RESTRICT,
  CONSTRAINT embedding_artifacts_embedding_revision_fkey FOREIGN KEY (
    embedding_configuration_revision_public_id
  ) REFERENCES focowiki.embedding_configuration_revisions (public_id) ON DELETE RESTRICT,
  CONSTRAINT embedding_artifacts_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND owner_kind IN ('content', 'entity', 'relationship', 'community')
    AND owner_public_id <> '' AND octet_length(owner_public_id) <= 255
    AND canonical_input_sha256 ~ '^[0-9a-f]{64}$'
    AND input_kind IN ('content', 'entity', 'relationship', 'community')
    AND normalization IN ('none', 'l2')
    AND dimension BETWEEN 1 AND 65536
    AND artifact_schema_version <> '' AND octet_length(artifact_schema_version) <= 128
    AND vector_checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND byte_count > 0 AND byte_count <= 268435456
    AND state IN ('registered', 'verified', 'failed', 'orphaned')
  )
);

ALTER TABLE focowiki.object_owners
  ADD CONSTRAINT object_owners_embedding_artifact_fkey FOREIGN KEY (
    embedding_artifact_public_id
  ) REFERENCES focowiki.embedding_artifacts (public_id) ON DELETE CASCADE;

CREATE TABLE focowiki.embedding_artifact_owners (
  knowledge_base_id text NOT NULL,
  artifact_public_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  operation_public_id text,
  source_revision_public_id text,
  owner_kind text NOT NULL,
  owner_public_id text NOT NULL,
  retention_kind text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (
    artifact_public_id, semantic_generation_public_id, owner_kind, owner_public_id
  ),
  CONSTRAINT embedding_artifact_owners_artifact_fkey FOREIGN KEY (
    artifact_public_id
  ) REFERENCES focowiki.embedding_artifacts (public_id) ON DELETE CASCADE,
  CONSTRAINT embedding_artifact_owners_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT embedding_artifact_owners_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT embedding_artifact_owners_value_check CHECK (
    owner_kind IN ('content', 'entity', 'relationship', 'community')
    AND owner_public_id <> '' AND octet_length(owner_public_id) <= 255
    AND retention_kind IN ('candidate', 'active', 'retry', 'cleanup')
  )
);

CREATE TABLE focowiki.semantic_embedding_artifact_refs (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  artifact_public_id text NOT NULL,
  semantic_owner_kind text NOT NULL,
  semantic_owner_public_id text NOT NULL,
  source_file_public_id text NOT NULL,
  source_excerpt text NOT NULL,
  PRIMARY KEY (
    semantic_generation_public_id,
    semantic_owner_kind,
    semantic_owner_public_id,
    artifact_public_id
  ),
  CONSTRAINT semantic_embedding_artifact_refs_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_embedding_artifact_refs_artifact_fkey FOREIGN KEY (
    artifact_public_id
  ) REFERENCES focowiki.embedding_artifacts (public_id) ON DELETE RESTRICT,
  CONSTRAINT semantic_embedding_artifact_refs_source_file_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id
  ) REFERENCES focowiki.source_files (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_embedding_artifact_refs_kind_check CHECK (
    semantic_owner_kind IN ('content', 'entity', 'relationship', 'community')
  ),
  CONSTRAINT semantic_embedding_artifact_refs_excerpt_check CHECK (
    source_excerpt <> '' AND octet_length(source_excerpt) <= 4096
  )
);

CREATE TABLE focowiki.semantic_vector_documents (
  knowledge_base_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  public_id text NOT NULL,
  projection_contract_public_id text NOT NULL,
  embedding_configuration_revision_public_id text NOT NULL,
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
  PRIMARY KEY (semantic_generation_public_id, public_id),
  CONSTRAINT semantic_vector_documents_owner_key UNIQUE (
    semantic_generation_public_id, vector_family, owner_public_id,
    source_revision_public_id
  ),
  CONSTRAINT semantic_vector_documents_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_vector_documents_contract_fkey FOREIGN KEY (
    projection_contract_public_id
  ) REFERENCES focowiki.semantic_projection_contracts (public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_vector_documents_embedding_revision_fkey FOREIGN KEY (
    embedding_configuration_revision_public_id
  ) REFERENCES focowiki.embedding_configuration_revisions (public_id) ON DELETE RESTRICT,
  CONSTRAINT semantic_vector_documents_artifact_fkey FOREIGN KEY (
    artifact_public_id
  ) REFERENCES focowiki.embedding_artifacts (public_id) ON DELETE RESTRICT,
  CONSTRAINT semantic_vector_documents_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_vector_documents_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND vector_family IN ('content', 'entity', 'relationship', 'community')
    AND owner_public_id <> '' AND octet_length(owner_public_id) <= 255
    AND dimension BETWEEN 1 AND 65536
    AND provider_document_id <> '' AND octet_length(provider_document_id) <= 1024
    AND evidence_target_path <> '' AND octet_length(evidence_target_path) <= 4096
    AND state IN ('candidate', 'active', 'failed', 'deleted')
  )
);

CREATE TABLE focowiki.semantic_maintenance_checkpoints (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_public_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  projection_contract_public_id text NOT NULL,
  partition_kind text NOT NULL,
  partition_key text NOT NULL,
  cursor_value text,
  completed_item_count bigint NOT NULL,
  completed_byte_count bigint NOT NULL,
  state text NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT semantic_maintenance_checkpoints_partition_key UNIQUE (
    operation_public_id, partition_kind, partition_key
  ),
  CONSTRAINT semantic_maintenance_checkpoints_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_maintenance_checkpoints_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_maintenance_checkpoints_contract_fkey FOREIGN KEY (
    projection_contract_public_id
  ) REFERENCES focowiki.semantic_projection_contracts (public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_maintenance_checkpoints_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND partition_kind IN ('source', 'graph', 'community', 'vector', 'publication', 'validation')
    AND partition_key <> '' AND octet_length(partition_key) <= 1024
    AND (cursor_value IS NULL OR octet_length(cursor_value) <= 4096)
    AND completed_item_count >= 0 AND completed_byte_count >= 0
    AND state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'superseded')
    AND jsonb_typeof(checkpoint) = 'object'
    AND octet_length(checkpoint::text) <= 32768
    AND revision >= 0
  )
);

CREATE TABLE focowiki.semantic_stage_work_items (
  public_id text PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  operation_public_id text NOT NULL,
  semantic_generation_public_id text NOT NULL,
  source_file_public_id text,
  source_revision_public_id text,
  stage_kind text NOT NULL,
  partition_key text NOT NULL,
  extraction_contract_version text NOT NULL,
  embedding_configuration_revision_public_id text NOT NULL,
  settings_snapshot jsonb NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL,
  maximum_attempts integer NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_owner text,
  lease_expires_at timestamp with time zone,
  execution_started_at timestamp with time zone,
  service_time_milliseconds bigint NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  cancellation_requested_at timestamp with time zone,
  safe_error_code text,
  revision bigint NOT NULL DEFAULT 0,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT semantic_stage_work_items_identity_key UNIQUE (
    operation_public_id, stage_kind, partition_key
  ),
  CONSTRAINT semantic_stage_work_items_operation_fkey FOREIGN KEY (
    knowledge_base_id, operation_public_id
  ) REFERENCES focowiki.operations (knowledge_base_id, public_id) ON DELETE CASCADE,
  CONSTRAINT semantic_stage_work_items_generation_fkey FOREIGN KEY (
    knowledge_base_id, semantic_generation_public_id
  ) REFERENCES focowiki.semantic_generations (
    knowledge_base_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_stage_work_items_source_revision_fkey FOREIGN KEY (
    knowledge_base_id, source_file_public_id, source_revision_public_id
  ) REFERENCES focowiki.source_revisions (
    knowledge_base_id, source_file_public_id, public_id
  ) ON DELETE CASCADE,
  CONSTRAINT semantic_stage_work_items_embedding_revision_fkey FOREIGN KEY (
    embedding_configuration_revision_public_id
  ) REFERENCES focowiki.embedding_configuration_revisions (public_id) ON DELETE RESTRICT,
  CONSTRAINT semantic_stage_work_items_value_check CHECK (
    public_id <> '' AND octet_length(public_id) <= 255
    AND stage_kind IN ('extraction', 'embedding', 'reconciliation', 'community', 'vector', 'publication', 'validation', 'cleanup')
    AND partition_key <> '' AND octet_length(partition_key) <= 1024
    AND extraction_contract_version <> ''
    AND octet_length(extraction_contract_version) <= 128
    AND jsonb_typeof(settings_snapshot) = 'object'
    AND octet_length(settings_snapshot::text) <= 32768
    AND state IN ('queued', 'running', 'retry', 'completed', 'failed', 'cancelled', 'superseded')
    AND attempt_count BETWEEN 0 AND maximum_attempts
    AND maximum_attempts BETWEEN 1 AND 100
    AND jsonb_typeof(checkpoint) = 'object'
    AND octet_length(checkpoint::text) <= 32768
    AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
    AND revision >= 0
    AND service_time_milliseconds >= 0
    AND (
      (source_file_public_id IS NULL AND source_revision_public_id IS NULL)
      OR (source_file_public_id IS NOT NULL AND source_revision_public_id IS NOT NULL)
    )
    AND (
      state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
        AND execution_started_at IS NOT NULL
      OR state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL
        AND execution_started_at IS NULL
    )
    AND (
      state IN ('completed', 'failed', 'cancelled', 'superseded')
        AND completed_at IS NOT NULL
      OR state IN ('queued', 'running', 'retry') AND completed_at IS NULL
    )
  )
);

CREATE UNIQUE INDEX semantic_generations_one_active_idx
  ON focowiki.semantic_generations (knowledge_base_id)
  WHERE generation_role = 'active' AND state = 'active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX embedding_configurations_one_active_idx
  ON focowiki.embedding_configurations (lifecycle_status)
  WHERE lifecycle_status = 'active' AND deleted_at IS NULL;
CREATE INDEX semantic_generations_candidate_operation_idx
  ON focowiki.semantic_generations (knowledge_base_id, operation_public_id, public_id)
  WHERE generation_role = 'candidate' AND deleted_at IS NULL;
CREATE INDEX semantic_entities_active_kind_idx
  ON focowiki.semantic_entities (
    knowledge_base_id, semantic_generation_public_id, entity_kind, canonical_key
  ) WHERE deleted_at IS NULL;
CREATE INDEX semantic_mentions_source_revision_idx
  ON focowiki.semantic_mentions (
    knowledge_base_id, source_file_public_id, source_revision_public_id, public_id
  );
CREATE INDEX semantic_entity_observations_source_idx
  ON focowiki.semantic_entity_observations (
    knowledge_base_id, source_file_public_id, source_revision_public_id,
    entity_public_id
  );
CREATE INDEX semantic_relationships_from_idx
  ON focowiki.semantic_relationships (
    knowledge_base_id, semantic_generation_public_id, from_entity_public_id, public_id
  ) WHERE deleted_at IS NULL;
CREATE INDEX semantic_relationships_to_idx
  ON focowiki.semantic_relationships (
    knowledge_base_id, semantic_generation_public_id, to_entity_public_id, public_id
  ) WHERE deleted_at IS NULL;
CREATE INDEX semantic_relationship_observations_source_idx
  ON focowiki.semantic_relationship_observations (
    knowledge_base_id, source_file_public_id, source_revision_public_id,
    relationship_public_id
  );
CREATE INDEX semantic_reverse_references_source_idx
  ON focowiki.semantic_reverse_references (
    knowledge_base_id, source_file_public_id, target_kind, target_public_id
  );
CREATE INDEX semantic_entity_partitions_partition_idx
  ON focowiki.semantic_entity_partitions (
    knowledge_base_id, semantic_generation_public_id, partition_key,
    entity_public_id
  );
CREATE INDEX semantic_communities_source_partition_idx
  ON focowiki.semantic_communities (
    knowledge_base_id, semantic_generation_public_id, source_partition_key,
    public_id
  ) WHERE deleted_at IS NULL;
CREATE INDEX semantic_dirty_partitions_claim_idx
  ON focowiki.semantic_dirty_partitions (
    state, next_attempt_at, updated_at, public_id
  )
  WHERE state IN ('dirty', 'failed');
CREATE INDEX embedding_artifacts_reuse_idx
  ON focowiki.embedding_artifacts (
    knowledge_base_id,
    embedding_configuration_revision_public_id,
    input_kind,
    canonical_input_sha256,
    public_id
  ) WHERE deleted_at IS NULL AND state = 'verified';
CREATE INDEX embedding_artifact_owners_generation_idx
  ON focowiki.embedding_artifact_owners (
    knowledge_base_id, semantic_generation_public_id, artifact_public_id
  );
CREATE INDEX semantic_vector_documents_active_family_idx
  ON focowiki.semantic_vector_documents (
    knowledge_base_id, semantic_generation_public_id, vector_family, public_id
  ) WHERE state = 'active' AND deleted_at IS NULL;
CREATE INDEX semantic_maintenance_checkpoints_resume_idx
  ON focowiki.semantic_maintenance_checkpoints (
    knowledge_base_id, operation_public_id, state, partition_kind, partition_key
  ) WHERE state IN ('queued', 'running', 'failed');
CREATE INDEX semantic_stage_work_items_claim_idx
  ON focowiki.semantic_stage_work_items (
    stage_kind, next_attempt_at, updated_at, public_id
  ) WHERE state IN ('queued', 'retry');
CREATE INDEX semantic_stage_work_items_lease_idx
  ON focowiki.semantic_stage_work_items (lease_expires_at, public_id)
  WHERE state = 'running';

ALTER TABLE focowiki.source_event_summaries
  DROP CONSTRAINT source_event_summaries_stage_check;

ALTER TABLE focowiki.source_event_summaries
  ADD CONSTRAINT source_event_summaries_stage_check CHECK (
    stage_key IN (
      'upload_storage', 'metadata_resolution', 'llm_suggestion',
      'graph_generation', 'graphrag_processing',
      'semantic_reconciliation', 'embedding_generation',
      'affected_projection', 'search_publication',
      'semantic_maintenance_required', 'projection_generation',
      'generation_validation', 'generation_activation'
    )
  );

ALTER TABLE focowiki.release_candidate_changed_facts
  DROP CONSTRAINT release_candidate_changed_facts_kind_check;
ALTER TABLE focowiki.release_candidate_changed_facts
  ADD CONSTRAINT release_candidate_changed_facts_kind_check CHECK (
    fact_kind IN (
      'knowledge_base', 'directory', 'source_file', 'source_revision',
      'graph_node', 'graph_edge', 'semantic_entity',
      'semantic_relationship', 'semantic_evidence',
      'semantic_reverse_reference', 'semantic_vector', 'semantic_community'
    )
  );

ALTER TABLE focowiki.release_candidate_dependencies
  DROP CONSTRAINT release_candidate_dependencies_kind_check;
ALTER TABLE focowiki.release_candidate_dependencies
  ADD CONSTRAINT release_candidate_dependencies_kind_check CHECK (
    dependency_kind IN (
      'path', 'ancestor', 'link', 'search', 'graph', 'index', 'schema',
      'log', 'scope', 'semantic', 'vector', 'community'
    )
  );

ALTER TABLE focowiki.release_candidates
  ADD COLUMN fact_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE focowiki.release_candidates
  ADD CONSTRAINT release_candidates_fact_revision_check CHECK (
    fact_revision >= 0
  );

ALTER TABLE focowiki.runtime_generation
  DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v3-semantic'
WHERE singleton = true
  AND generation = 'storage-vnext-v2';

ALTER TABLE focowiki.runtime_generation
  ADD CONSTRAINT runtime_generation_value_check CHECK (
    generation = 'storage-vnext-v3-semantic'
  );
