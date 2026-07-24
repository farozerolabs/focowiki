ALTER TABLE focowiki.publication_generations
  DROP CONSTRAINT IF EXISTS publication_generations_kind_check,
  DROP CONSTRAINT IF EXISTS publication_generations_generation_kind_check;
ALTER TABLE focowiki.publication_generations
  ADD CONSTRAINT publication_generations_generation_kind_check CHECK (
    generation_kind = ANY (ARRAY['normal', 'projection_repair', 'lexical_rebuild'])
  );
ALTER TABLE focowiki.publication_generations
  ADD COLUMN search_schema_version text,
  ADD COLUMN tokenizer_contract_version text,
  ADD COLUMN search_segmentation_version text,
  ADD CONSTRAINT publication_generations_search_version_check CHECK (
    (
      search_schema_version IS NULL
      AND tokenizer_contract_version IS NULL
      AND search_segmentation_version IS NULL
    )
    OR (
      char_length(search_schema_version) BETWEEN 1 AND 160
      AND char_length(tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(search_segmentation_version) BETWEEN 1 AND 160
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS publication_generations_one_lexical_rebuild_idx
  ON focowiki.publication_generations (knowledge_base_id)
  WHERE state = ANY (ARRAY['open', 'frozen', 'building', 'validating'])
    AND generation_kind = 'lexical_rebuild';

CREATE UNIQUE INDEX IF NOT EXISTS source_files_knowledge_base_identity_idx
  ON focowiki.source_files (knowledge_base_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS source_revisions_knowledge_base_identity_idx
  ON focowiki.source_revisions (knowledge_base_id, id, source_file_id);
CREATE UNIQUE INDEX IF NOT EXISTS publication_generations_knowledge_base_identity_idx
  ON focowiki.publication_generations (knowledge_base_id, id);

CREATE TABLE focowiki.search_projection_documents (
    id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    source_revision_id text NOT NULL,
    source_body_checksum_sha256 text NOT NULL,
    search_schema_version text NOT NULL,
    tokenizer_contract_version text NOT NULL,
    segmentation_version text NOT NULL,
    segment_count integer DEFAULT 0 NOT NULL,
    lifecycle_state text DEFAULT 'writing' NOT NULL,
    safe_error_code text,
    safe_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT search_projection_documents_identity_key UNIQUE (
      knowledge_base_id,
      source_file_id,
      source_body_checksum_sha256,
      search_schema_version,
      tokenizer_contract_version,
      segmentation_version
    ),
    CONSTRAINT search_projection_documents_knowledge_base_identity_key
      UNIQUE (knowledge_base_id, id),
    CONSTRAINT search_projection_documents_checksum_check CHECK (
      source_body_checksum_sha256 ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT search_projection_documents_segment_count_check CHECK (
      segment_count >= 0
    ),
    CONSTRAINT search_projection_documents_version_check CHECK (
      char_length(search_schema_version) BETWEEN 1 AND 160
      AND char_length(tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(segmentation_version) BETWEEN 1 AND 160
    ),
    CONSTRAINT search_projection_documents_lifecycle_check CHECK (
      lifecycle_state = ANY (ARRAY['writing', 'ready', 'failed'])
    ),
    CONSTRAINT search_projection_documents_error_check CHECK (
      (
        lifecycle_state = 'failed'
        AND safe_error_code IS NOT NULL
        AND safe_error_message IS NOT NULL
      )
      OR (
        lifecycle_state <> 'failed'
        AND safe_error_code IS NULL
        AND safe_error_message IS NULL
      )
    ),
    CONSTRAINT search_projection_documents_completion_check CHECK (
      (lifecycle_state = 'ready' AND completed_at IS NOT NULL)
      OR (lifecycle_state <> 'ready' AND completed_at IS NULL)
    ),
    CONSTRAINT search_projection_documents_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT search_projection_documents_source_file_identity_fkey
      FOREIGN KEY (knowledge_base_id, source_file_id)
      REFERENCES focowiki.source_files(knowledge_base_id, id) ON DELETE CASCADE,
    CONSTRAINT search_projection_documents_source_revision_identity_fkey
      FOREIGN KEY (knowledge_base_id, source_revision_id, source_file_id)
      REFERENCES focowiki.source_revisions(knowledge_base_id, id, source_file_id)
      ON DELETE CASCADE
);

CREATE TABLE focowiki.search_projection_segments (
    document_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    ordinal integer NOT NULL,
    heading text,
    normalized_text text NOT NULL,
    tokens text[] DEFAULT ARRAY[]::text[] NOT NULL,
    token_text text NOT NULL,
    lexical_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, token_text)
    ) STORED,
    character_count integer NOT NULL,
    byte_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_projection_segments_pkey PRIMARY KEY (document_id, ordinal),
    CONSTRAINT search_projection_segments_ordinal_check CHECK (ordinal >= 0),
    CONSTRAINT search_projection_segments_character_count_check CHECK (
      character_count >= 0 AND character_count <= 4096
    ),
    CONSTRAINT search_projection_segments_byte_count_check CHECK (
      byte_count >= 0 AND byte_count <= 16384
    ),
    CONSTRAINT search_projection_segments_bounds_check CHECK (
      cardinality(tokens) <= 512
      AND octet_length(token_text) <= 65536
      AND octet_length(normalized_text) <= 16384
      AND (heading IS NULL OR octet_length(heading) <= 2048)
    ),
    CONSTRAINT search_projection_segments_document_identity_fkey
      FOREIGN KEY (knowledge_base_id, document_id)
      REFERENCES focowiki.search_projection_documents(knowledge_base_id, id)
      ON DELETE CASCADE
);

CREATE TABLE focowiki.generation_search_projection_refs (
    knowledge_base_id text NOT NULL,
    generation_id text NOT NULL,
    source_file_id text NOT NULL,
    source_revision_id text NOT NULL,
    search_document_id text NOT NULL,
    search_schema_version text NOT NULL,
    tokenizer_contract_version text NOT NULL,
    segmentation_version text NOT NULL,
    logical_path text NOT NULL,
    title text NOT NULL,
    summary text,
    source_url text,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_search_projection_refs_pkey
      PRIMARY KEY (generation_id, source_file_id),
    CONSTRAINT generation_search_projection_refs_document_key
      UNIQUE (generation_id, search_document_id),
    CONSTRAINT generation_search_projection_refs_metadata_check
      CHECK (jsonb_typeof(metadata_json) = 'object'),
    CONSTRAINT generation_search_projection_refs_text_bounds_check CHECK (
      octet_length(logical_path) <= 4096
      AND octet_length(title) <= 4096
      AND (summary IS NULL OR octet_length(summary) <= 16384)
      AND (source_url IS NULL OR octet_length(source_url) <= 8192)
      AND char_length(search_schema_version) BETWEEN 1 AND 160
      AND char_length(tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(segmentation_version) BETWEEN 1 AND 160
    ),
    CONSTRAINT generation_search_projection_refs_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT generation_search_projection_refs_generation_identity_fkey
      FOREIGN KEY (knowledge_base_id, generation_id)
      REFERENCES focowiki.publication_generations(knowledge_base_id, id)
      ON DELETE CASCADE,
    CONSTRAINT generation_search_projection_refs_source_file_identity_fkey
      FOREIGN KEY (knowledge_base_id, source_file_id)
      REFERENCES focowiki.source_files(knowledge_base_id, id) ON DELETE CASCADE,
    CONSTRAINT generation_search_projection_refs_source_revision_identity_fkey
      FOREIGN KEY (knowledge_base_id, source_revision_id, source_file_id)
      REFERENCES focowiki.source_revisions(knowledge_base_id, id, source_file_id)
      ON DELETE CASCADE,
    CONSTRAINT generation_search_projection_refs_document_identity_fkey
      FOREIGN KEY (knowledge_base_id, search_document_id)
      REFERENCES focowiki.search_projection_documents(knowledge_base_id, id)
      ON DELETE CASCADE
);

CREATE TABLE focowiki.knowledge_base_lexical_rebuilds (
    knowledge_base_id text PRIMARY KEY,
    target_search_schema_version text NOT NULL,
    target_tokenizer_contract_version text NOT NULL,
    target_segmentation_version text NOT NULL,
    target_content_profile_version text NOT NULL,
    target_graph_lexical_projection_version text NOT NULL,
    base_generation_id text,
    target_generation_id text,
    state text DEFAULT 'pending' NOT NULL,
    phase text DEFAULT 'documents' NOT NULL,
    source_cursor text,
    processed_source_count bigint DEFAULT 0 NOT NULL,
    total_source_count bigint DEFAULT 0 NOT NULL,
    rebase_count integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error_code text,
    last_error_message text,
    started_at timestamp with time zone,
    validated_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_base_lexical_rebuilds_target_generation_key
      UNIQUE (target_generation_id),
    CONSTRAINT knowledge_base_lexical_rebuilds_state_check CHECK (
      state = ANY (ARRAY[
        'pending', 'running', 'validating', 'activating',
        'completed', 'failed', 'cancelled'
      ])
    ),
    CONSTRAINT knowledge_base_lexical_rebuilds_phase_check CHECK (
      phase = ANY (ARRAY[
        'documents', 'lexical_profiles', 'graph_terms', 'reconcile',
        'validate', 'activate', 'cleanup'
      ])
    ),
    CONSTRAINT knowledge_base_lexical_rebuilds_count_check CHECK (
      processed_source_count >= 0
      AND total_source_count >= 0
      AND processed_source_count <= total_source_count
      AND rebase_count >= 0
      AND attempt_count >= 0
      AND max_attempts >= 1
    ),
    CONSTRAINT knowledge_base_lexical_rebuilds_version_check CHECK (
      char_length(target_search_schema_version) BETWEEN 1 AND 160
      AND char_length(target_tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(target_segmentation_version) BETWEEN 1 AND 160
      AND char_length(target_content_profile_version) BETWEEN 1 AND 160
      AND char_length(target_graph_lexical_projection_version) BETWEEN 1 AND 160
    ),
    CONSTRAINT knowledge_base_lexical_rebuilds_lease_check CHECK (
      (
        lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
      )
      OR (
        lease_owner IS NOT NULL
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
    ),
    CONSTRAINT knowledge_base_lexical_rebuilds_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT knowledge_base_lexical_rebuilds_base_generation_identity_fkey
      FOREIGN KEY (knowledge_base_id, base_generation_id)
      REFERENCES focowiki.publication_generations(knowledge_base_id, id)
      ON DELETE SET NULL (base_generation_id),
    CONSTRAINT knowledge_base_lexical_rebuilds_target_generation_identity_fkey
      FOREIGN KEY (knowledge_base_id, target_generation_id)
      REFERENCES focowiki.publication_generations(knowledge_base_id, id)
      ON DELETE SET NULL (target_generation_id)
);

ALTER TABLE focowiki.source_file_graph_nodes
  ADD COLUMN tokenizer_contract_version text,
  ADD COLUMN lexical_projection_version text,
  ADD CONSTRAINT source_file_graph_nodes_lexical_version_check CHECK (
    (
      tokenizer_contract_version IS NULL
      AND lexical_projection_version IS NULL
    )
    OR (
      char_length(tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(lexical_projection_version) BETWEEN 1 AND 160
    )
  );
ALTER TABLE focowiki.source_file_graph_term_documents
  ADD COLUMN tokenizer_contract_version text,
  ADD COLUMN lexical_projection_version text,
  ADD CONSTRAINT source_file_graph_term_documents_lexical_version_check CHECK (
    (
      tokenizer_contract_version IS NULL
      AND lexical_projection_version IS NULL
    )
    OR (
      char_length(tokenizer_contract_version) BETWEEN 1 AND 200
      AND char_length(lexical_projection_version) BETWEEN 1 AND 160
    )
  );

CREATE INDEX search_projection_documents_ready_source_idx
  ON focowiki.search_projection_documents (
    knowledge_base_id,
    lifecycle_state,
    search_schema_version,
    tokenizer_contract_version,
    source_file_id
  );
CREATE INDEX search_projection_documents_cleanup_idx
  ON focowiki.search_projection_documents (lifecycle_state, updated_at, id);
CREATE INDEX search_projection_segments_knowledge_base_document_idx
  ON focowiki.search_projection_segments (knowledge_base_id, document_id, ordinal);
CREATE INDEX search_projection_segments_lexical_gin_idx
  ON focowiki.search_projection_segments USING gin (lexical_vector);
CREATE INDEX search_projection_segments_text_trgm_idx
  ON focowiki.search_projection_segments
  USING gin (lower(normalized_text) focowiki.gin_trgm_ops);
CREATE INDEX generation_search_projection_refs_generation_idx
  ON focowiki.generation_search_projection_refs (
    knowledge_base_id,
    generation_id,
    source_file_id
  );
CREATE INDEX generation_search_projection_refs_document_idx
  ON focowiki.generation_search_projection_refs (search_document_id, generation_id);
CREATE INDEX generation_search_projection_refs_title_exact_idx
  ON focowiki.generation_search_projection_refs (
    knowledge_base_id,
    generation_id,
    lower(title),
    source_file_id
  );
CREATE INDEX generation_search_projection_refs_path_exact_idx
  ON focowiki.generation_search_projection_refs (
    knowledge_base_id,
    generation_id,
    lower(logical_path),
    source_file_id
  );
CREATE INDEX generation_search_projection_refs_title_trgm_idx
  ON focowiki.generation_search_projection_refs
  USING gin (lower(title) focowiki.gin_trgm_ops);
CREATE INDEX generation_search_projection_refs_path_trgm_idx
  ON focowiki.generation_search_projection_refs
  USING gin (lower(logical_path) focowiki.gin_trgm_ops);
CREATE INDEX knowledge_base_lexical_rebuilds_claim_idx
  ON focowiki.knowledge_base_lexical_rebuilds (
    state,
    next_attempt_at,
    lease_expires_at,
    updated_at,
    knowledge_base_id
  )
  WHERE state = ANY (ARRAY['pending', 'running', 'validating', 'activating', 'failed']);

INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
  knowledge_base_id,
  target_search_schema_version,
  target_tokenizer_contract_version,
  target_segmentation_version,
  target_content_profile_version,
  target_graph_lexical_projection_version,
  base_generation_id
)
SELECT
  knowledge_base.id,
  'body-search-v1',
  'lexical-tokenizer-v1-57ed8fff6eba3b110cc594a0ad4cebcac02e78dba853549b9ccaa9c85113e881',
  'body-segmentation-v1',
  'content-profile-v2',
  'graph-lexical-v2',
  knowledge_base.active_generation_id
FROM focowiki.knowledge_bases knowledge_base
WHERE knowledge_base.deleted_at IS NULL
  AND knowledge_base.active_generation_id IS NOT NULL
ON CONFLICT (knowledge_base_id) DO NOTHING;

UPDATE focowiki.runtime_generation
SET generation = 'body-search-projection-v11'
WHERE singleton = true;
