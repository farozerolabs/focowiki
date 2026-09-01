ALTER TABLE focowiki.semantic_projection_contracts
  DROP CONSTRAINT IF EXISTS semantic_projection_contracts_query_policy_revision_fkey,
  DROP CONSTRAINT IF EXISTS semantic_projection_contracts_contract_check,
  DROP COLUMN IF EXISTS embedding_query_policy_revision_public_id,
  DROP COLUMN IF EXISTS minimum_vector_relevance;

ALTER TABLE focowiki.semantic_projection_contracts
  ADD CONSTRAINT semantic_projection_contracts_contract_check CHECK (
    search_provider_kind = ANY (ARRAY['meilisearch'::text, 'opensearch'::text])
    AND resolved_dimension >= 1
    AND resolved_dimension <= 65536
    AND normalization = ANY (ARRAY['none'::text, 'l2'::text])
    AND artifact_schema_version <> ''
    AND octet_length(artifact_schema_version) <= 128
    AND vector_schema_version <> ''
    AND octet_length(vector_schema_version) <= 128
    AND mapping_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE focowiki.embedding_configuration_revisions
  DROP CONSTRAINT IF EXISTS embedding_configuration_revisions_bounds_check,
  DROP COLUMN IF EXISTS minimum_vector_relevance;

ALTER TABLE focowiki.embedding_configuration_revisions
  ADD CONSTRAINT embedding_configuration_revisions_bounds_check CHECK (
    revision_number >= 1
    AND maximum_input_tokens >= 1
    AND maximum_input_tokens <= 1048576
    AND batch_size >= 1
    AND batch_size <= 2048
    AND timeout_ms >= 100
    AND timeout_ms <= 300000
    AND retry_count >= 0
    AND retry_count <= 10
    AND minimum_interval_ms >= 0
    AND minimum_interval_ms <= 60000
    AND concurrency >= 1
    AND concurrency <= 64
    AND maximum_response_bytes >= 1024
    AND maximum_response_bytes <= 67108864
  );

ALTER TABLE focowiki.runtime_generation
  DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v30-provider-neutral-retrieval'
WHERE singleton = true
  AND generation = 'storage-vnext-v29-source-metadata-persistence-repair';

ALTER TABLE focowiki.runtime_generation
  ADD CONSTRAINT runtime_generation_value_check CHECK (
    generation = 'storage-vnext-v30-provider-neutral-retrieval'
  );
