ALTER TABLE focowiki.projection_dirty_scopes
    ADD COLUMN lease_generation bigint DEFAULT 0 NOT NULL,
    ADD COLUMN heartbeat_at timestamp with time zone;

ALTER TABLE focowiki.projection_dirty_scopes
    ADD CONSTRAINT projection_dirty_scopes_lease_generation_check CHECK (
      lease_generation >= 0
      AND (heartbeat_at IS NULL OR state = 'running')
    );

CREATE INDEX projection_dirty_scopes_fenced_lease_idx
    ON focowiki.projection_dirty_scopes (
      lease_expires_at, lease_generation, public_id
    )
    WHERE state = 'running';

CREATE TABLE focowiki.projection_cleanup_outbox (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    scope_public_id text NOT NULL,
    rendered_sequence bigint NOT NULL,
    object_id text NOT NULL,
    write_attempt_public_id text NOT NULL,
    state text DEFAULT 'waiting' NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    maximum_attempts integer DEFAULT 20 NOT NULL,
    next_eligible_at timestamp with time zone NOT NULL,
    lease_owner text,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    safe_error_code text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_cleanup_outbox_holder_key UNIQUE (
      object_id, write_attempt_public_id
    ),
    CONSTRAINT projection_cleanup_outbox_state_check CHECK (
      state IN ('waiting', 'running', 'completed', 'error')
      AND attempt_count BETWEEN 0 AND maximum_attempts
      AND maximum_attempts BETWEEN 1 AND 100
      AND lease_generation >= 0
      AND ((state = 'running' AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL)
        OR (state <> 'running' AND lease_owner IS NULL
            AND lease_expires_at IS NULL))
      AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
    ),
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (object_id)
      REFERENCES focowiki.object_registrations(object_id) ON DELETE CASCADE
);

CREATE INDEX projection_cleanup_outbox_claim_idx
    ON focowiki.projection_cleanup_outbox (
      state, next_eligible_at, created_at, public_id
    )
    WHERE state = 'waiting';

CREATE INDEX projection_cleanup_outbox_expired_lease_idx
    ON focowiki.projection_cleanup_outbox (
      lease_expires_at, public_id
    )
    WHERE state = 'running';

CREATE TABLE focowiki.projection_fact_epochs (
    knowledge_base_id text NOT NULL,
    fact_epoch bigint NOT NULL,
    mutation_public_id text NOT NULL,
    mutation_group_public_id text,
    source_file_public_id text,
    source_revision_public_id text,
    fact_kind text NOT NULL,
    state text DEFAULT 'ready' NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, fact_epoch),
    UNIQUE (knowledge_base_id, mutation_public_id),
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    CONSTRAINT projection_fact_epochs_value_check CHECK (
      fact_epoch > 0
      AND mutation_public_id <> ''
      AND octet_length(mutation_public_id) <= 255
      AND (mutation_group_public_id IS NULL OR (
        mutation_group_public_id <> ''
        AND octet_length(mutation_group_public_id) <= 255))
      AND fact_kind IN (
        'create', 'replace', 'move', 'delete', 'repair', 'shadow'
      )
      AND state IN ('ready', 'included', 'superseded')
      AND (source_file_public_id IS NULL
        OR octet_length(source_file_public_id) BETWEEN 1 AND 255)
      AND (source_revision_public_id IS NULL
        OR octet_length(source_revision_public_id) BETWEEN 1 AND 255)
    )
);

CREATE TABLE focowiki.projection_publication_generations (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    base_generation_public_id text,
    target_fact_epoch bigint NOT NULL,
    renderer_contract_version text NOT NULL,
    deterministic_changed_at timestamp with time zone NOT NULL,
    state text DEFAULT 'planned' NOT NULL,
    input_fingerprint_sha256 text NOT NULL,
    output_fingerprint_sha256 text,
    activation_contention_count integer DEFAULT 0 NOT NULL,
    activation_next_eligible_at timestamp with time zone,
    safe_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (base_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id),
    CONSTRAINT projection_publication_generations_value_check CHECK (
      public_id <> '' AND octet_length(public_id) <= 255
      AND target_fact_epoch >= 0
      AND renderer_contract_version <> ''
      AND octet_length(renderer_contract_version) <= 128
      AND input_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      AND (output_fingerprint_sha256 IS NULL
        OR output_fingerprint_sha256 ~ '^[0-9a-f]{64}$')
      AND activation_contention_count >= 0
      AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
      AND state IN (
        'planned', 'rendering', 'validating', 'ready', 'active',
        'obsolete', 'quarantined'
      )
      AND ((state IN ('active', 'obsolete') AND completed_at IS NOT NULL)
        OR (state NOT IN ('active', 'obsolete')))
    )
);

CREATE UNIQUE INDEX projection_publication_generations_one_candidate_idx
    ON focowiki.projection_publication_generations (knowledge_base_id)
    WHERE state IN ('planned', 'rendering', 'validating', 'ready');

CREATE INDEX projection_publication_generations_history_idx
    ON focowiki.projection_publication_generations (
      knowledge_base_id, target_fact_epoch DESC, public_id
    );

CREATE TABLE focowiki.knowledge_base_projection_heads (
    knowledge_base_id text PRIMARY KEY,
    active_generation_public_id text,
    active_fact_epoch bigint DEFAULT 0 NOT NULL,
    head_version bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (active_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id),
    CONSTRAINT knowledge_base_projection_heads_value_check CHECK (
      active_fact_epoch >= 0 AND head_version >= 0
    )
);

CREATE TABLE focowiki.projection_generation_documents (
    generation_public_id text NOT NULL,
    mutation_public_id text NOT NULL,
    document_job_public_id text,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    fact_epoch bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (generation_public_id, mutation_public_id),
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (document_job_public_id)
      REFERENCES focowiki.document_processing_jobs(public_id) ON DELETE CASCADE,
    CONSTRAINT projection_generation_documents_value_check CHECK (
      fact_epoch > 0
      AND mutation_public_id <> ''
      AND octet_length(mutation_public_id) <= 255
      AND source_file_public_id <> ''
      AND octet_length(source_file_public_id) <= 255
      AND source_revision_public_id <> ''
      AND octet_length(source_revision_public_id) <= 255
    )
);

CREATE TABLE focowiki.projection_activation_owner_reservations (
    generation_public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    owner_family text NOT NULL,
    owner_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (generation_public_id, owner_family, owner_key),
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    CONSTRAINT projection_activation_owner_reservations_value_check CHECK (
      owner_family IN (
        'source', 'relation', 'search', 'page', 'directory',
        'job', 'receipt', 'outbox'
      )
      AND owner_key <> '' AND octet_length(owner_key) <= 4096
    )
);

CREATE INDEX projection_activation_owner_reservations_lock_idx
    ON focowiki.projection_activation_owner_reservations (
      generation_public_id, owner_family, owner_key COLLATE "C"
    );

CREATE INDEX projection_generation_documents_fact_idx
    ON focowiki.projection_generation_documents (
      generation_public_id, fact_epoch, mutation_public_id
    );

CREATE UNIQUE INDEX projection_generation_documents_job_idx
    ON focowiki.projection_generation_documents (
      generation_public_id, document_job_public_id
    ) WHERE document_job_public_id IS NOT NULL;

CREATE TABLE focowiki.projection_artifact_owners (
    knowledge_base_id text NOT NULL,
    normalized_path text NOT NULL,
    owner_scope_identity text NOT NULL,
    artifact_family text NOT NULL,
    ownership_epoch bigint NOT NULL,
    generation_public_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, normalized_path),
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id),
    CONSTRAINT projection_artifact_owners_value_check CHECK (
      normalized_path <> '' AND octet_length(normalized_path) <= 4096
      AND normalized_path = lower(normalized_path)
      AND owner_scope_identity <> ''
      AND octet_length(owner_scope_identity) <= 2048
      AND artifact_family IN (
        'source', 'page_directory', 'machine_index', 'term', 'graph',
        'graph_catalog', 'root'
      )
      AND ownership_epoch >= 0
    )
);

CREATE INDEX projection_artifact_owners_scope_idx
    ON focowiki.projection_artifact_owners (
      knowledge_base_id, owner_scope_identity, normalized_path COLLATE "C"
    );

CREATE TABLE focowiki.projection_directory_owners (
    knowledge_base_id text NOT NULL,
    directory_path text NOT NULL,
    owner_scope_identity text NOT NULL,
    ownership_epoch bigint NOT NULL,
    generation_public_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, directory_path),
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id),
    CONSTRAINT projection_directory_owners_value_check CHECK (
      octet_length(directory_path) <= 4096
      AND directory_path = lower(directory_path)
      AND owner_scope_identity <> ''
      AND octet_length(owner_scope_identity) <= 2048
      AND ownership_epoch >= 0
    )
);

CREATE INDEX projection_directory_owners_scope_idx
    ON focowiki.projection_directory_owners (
      knowledge_base_id, owner_scope_identity, directory_path COLLATE "C"
    );

CREATE TABLE focowiki.projection_scope_generations (
    public_id text PRIMARY KEY,
    publication_generation_public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    scope_identity text NOT NULL,
    scope_kind text NOT NULL,
    scope_key text NOT NULL,
    scope_generation bigint NOT NULL,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    state text DEFAULT 'waiting' NOT NULL,
    input_snapshot_fingerprint_sha256 text NOT NULL,
    output_fingerprint_sha256 text,
    validation_evidence jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    UNIQUE (publication_generation_public_id, scope_identity),
    UNIQUE (knowledge_base_id, scope_identity, scope_generation),
    UNIQUE (public_id, publication_generation_public_id, scope_identity),
    FOREIGN KEY (publication_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    CONSTRAINT projection_scope_generations_value_check CHECK (
      public_id <> '' AND octet_length(public_id) <= 255
      AND scope_identity <> '' AND octet_length(scope_identity) <= 2048
      AND scope_key <> '' AND octet_length(scope_key) <= 4096
      AND scope_kind IN (
        'source', 'relation', 'directory', 'graph', '_index', '_graph',
        'root', 'validation'
      )
      AND scope_generation > 0 AND lease_generation >= 0
      AND input_snapshot_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      AND (output_fingerprint_sha256 IS NULL
        OR output_fingerprint_sha256 ~ '^[0-9a-f]{64}$')
      AND (validation_evidence IS NULL
        OR (jsonb_typeof(validation_evidence) = 'object'
          AND octet_length(validation_evidence::text) <= 65536))
      AND state IN (
        'waiting', 'running', 'completed', 'superseded', 'error', 'quarantined'
      )
      AND ((state = 'running' AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)
        OR (state <> 'running' AND lease_owner IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL))
    )
);

CREATE INDEX projection_scope_generations_claim_idx
    ON focowiki.projection_scope_generations (
      state, created_at, public_id
    ) WHERE state = 'waiting';

CREATE INDEX projection_scope_generations_expired_idx
    ON focowiki.projection_scope_generations (
      lease_expires_at, public_id
    ) WHERE state = 'running';

CREATE TABLE focowiki.projection_scheduler_credits (
    knowledge_base_id text NOT NULL,
    lane text NOT NULL,
    waiting_count bigint DEFAULT 0 NOT NULL,
    oldest_waiting_at timestamp with time zone,
    last_selected_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, lane),
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    CONSTRAINT projection_scheduler_credits_value_check CHECK (
      lane IN ('scope', 'activation') AND waiting_count >= 0
    )
);

CREATE INDEX projection_scheduler_credits_fair_idx
    ON focowiki.projection_scheduler_credits (
      lane, last_selected_at NULLS FIRST, oldest_waiting_at,
      knowledge_base_id COLLATE "C"
    );

CREATE TABLE focowiki.projection_scope_generation_dependencies (
    scope_generation_public_id text NOT NULL,
    depends_on_scope_generation_public_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (
      scope_generation_public_id, depends_on_scope_generation_public_id
    ),
    FOREIGN KEY (scope_generation_public_id)
      REFERENCES focowiki.projection_scope_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (depends_on_scope_generation_public_id)
      REFERENCES focowiki.projection_scope_generations(public_id)
      ON DELETE CASCADE,
    CONSTRAINT projection_scope_generation_dependencies_value_check CHECK (
      scope_generation_public_id <> depends_on_scope_generation_public_id
    )
);

CREATE INDEX projection_scope_generation_dependencies_reverse_idx
    ON focowiki.projection_scope_generation_dependencies (
      depends_on_scope_generation_public_id, scope_generation_public_id
    );

CREATE TABLE focowiki.projection_scope_snapshot_members (
    scope_generation_public_id text NOT NULL,
    member_kind text NOT NULL,
    member_public_id text NOT NULL,
    member_version text NOT NULL,
    member_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (
      scope_generation_public_id, member_kind, member_public_id
    ),
    UNIQUE (scope_generation_public_id, member_order),
    FOREIGN KEY (scope_generation_public_id)
      REFERENCES focowiki.projection_scope_generations(public_id)
      ON DELETE CASCADE,
    CONSTRAINT projection_scope_snapshot_members_value_check CHECK (
      member_kind IN (
        'source_revision', 'relation', 'directory', 'term', 'graph',
        'base_owner', 'search_receipt', 'tombstone'
      )
      AND member_public_id <> '' AND octet_length(member_public_id) <= 255
      AND member_version <> '' AND octet_length(member_version) <= 255
      AND member_order BETWEEN 0 AND 999999
    )
);

CREATE TABLE focowiki.projection_scope_generation_pages (
    scope_generation_public_id text NOT NULL,
    publication_generation_public_id text NOT NULL,
    owner_scope_identity text NOT NULL,
    logical_path text NOT NULL,
    normalized_path text NOT NULL,
    action text NOT NULL,
    entry_kind text,
    object_id text,
    checksum_sha256 text,
    byte_count bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (scope_generation_public_id, normalized_path),
    UNIQUE (publication_generation_public_id, normalized_path),
    FOREIGN KEY (
      scope_generation_public_id, publication_generation_public_id,
      owner_scope_identity
    ) REFERENCES focowiki.projection_scope_generations(
      public_id, publication_generation_public_id, scope_identity
    )
      ON DELETE CASCADE,
    CONSTRAINT projection_scope_generation_pages_value_check CHECK (
      normalized_path <> '' AND octet_length(normalized_path) <= 4096
      AND logical_path <> '' AND octet_length(logical_path) <= 4096
      AND normalized_path = lower(logical_path)
      AND normalized_path = lower(normalized_path)
      AND owner_scope_identity <> ''
      AND octet_length(owner_scope_identity) <= 2048
      AND action IN ('put', 'delete')
      AND ((action = 'put' AND entry_kind IS NOT NULL
            AND octet_length(entry_kind) BETWEEN 1 AND 128
            AND object_id IS NOT NULL AND octet_length(object_id) <= 255
            AND checksum_sha256 ~ '^[0-9a-f]{64}$'
            AND byte_count >= 0)
        OR (action = 'delete' AND entry_kind IS NULL AND object_id IS NULL
            AND checksum_sha256 IS NULL AND byte_count IS NULL))
    )
);

CREATE INDEX projection_scope_generation_pages_path_idx
    ON focowiki.projection_scope_generation_pages (
      normalized_path COLLATE "C", scope_generation_public_id
    );

CREATE TABLE focowiki.projection_generation_directory_claims (
    publication_generation_public_id text NOT NULL,
    directory_path text NOT NULL,
    scope_generation_public_id text NOT NULL,
    owner_scope_identity text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (publication_generation_public_id, directory_path),
    UNIQUE (
      publication_generation_public_id, directory_path,
      scope_generation_public_id, owner_scope_identity
    ),
    FOREIGN KEY (
      scope_generation_public_id, publication_generation_public_id,
      owner_scope_identity
    ) REFERENCES focowiki.projection_scope_generations(
      public_id, publication_generation_public_id, scope_identity
    ) ON DELETE CASCADE,
    CONSTRAINT projection_generation_directory_claims_value_check CHECK (
      octet_length(directory_path) <= 4096
      AND directory_path = lower(directory_path)
      AND owner_scope_identity <> ''
      AND octet_length(owner_scope_identity) <= 2048
    )
);

CREATE TABLE focowiki.projection_scope_navigation_mutations (
    scope_generation_public_id text NOT NULL,
    publication_generation_public_id text NOT NULL,
    owner_scope_identity text NOT NULL,
    directory_path text NOT NULL,
    mutation_order integer NOT NULL,
    action text NOT NULL,
    mutation jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (
      scope_generation_public_id, directory_path, mutation_order
    ),
    FOREIGN KEY (
      publication_generation_public_id, directory_path,
      scope_generation_public_id, owner_scope_identity
    ) REFERENCES focowiki.projection_generation_directory_claims(
      publication_generation_public_id, directory_path,
      scope_generation_public_id, owner_scope_identity
    )
      ON DELETE CASCADE,
    CONSTRAINT projection_scope_navigation_mutations_value_check CHECK (
      octet_length(directory_path) <= 4096
      AND directory_path = lower(directory_path)
      AND owner_scope_identity <> ''
      AND octet_length(owner_scope_identity) <= 2048
      AND mutation_order BETWEEN 0 AND 999999
      AND action IN ('upsert', 'delete')
      AND jsonb_typeof(mutation) = 'object'
      AND octet_length(mutation::text) <= 65536
    )
);

CREATE TABLE focowiki.projection_scope_generation_object_refs (
    scope_generation_public_id text NOT NULL,
    object_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (scope_generation_public_id, object_id),
    FOREIGN KEY (scope_generation_public_id)
      REFERENCES focowiki.projection_scope_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (object_id)
      REFERENCES focowiki.object_registrations(object_id)
);

CREATE INDEX projection_scope_generation_object_refs_object_idx
    ON focowiki.projection_scope_generation_object_refs (object_id);

CREATE TABLE focowiki.projection_generation_validation_results (
    generation_public_id text NOT NULL,
    check_name text NOT NULL,
    state text NOT NULL,
    checked_count bigint DEFAULT 0 NOT NULL,
    evidence_sha256 text,
    safe_detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    PRIMARY KEY (generation_public_id, check_name),
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    CONSTRAINT projection_generation_validation_results_value_check CHECK (
      check_name <> '' AND octet_length(check_name) <= 128
      AND state IN ('passed', 'failed') AND checked_count >= 0
      AND (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$')
      AND jsonb_typeof(safe_detail) = 'object'
      AND octet_length(safe_detail::text) <= 65536
    )
);

CREATE TABLE focowiki.projection_invariant_diagnostics (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    generation_public_id text,
    invariant_code text NOT NULL,
    normalized_path text,
    normalized_path_sha256 text,
    safe_evidence jsonb NOT NULL,
    trace_public_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id),
    CONSTRAINT projection_invariant_diagnostics_value_check CHECK (
      public_id <> '' AND octet_length(public_id) <= 255
      AND invariant_code <> '' AND octet_length(invariant_code) <= 128
      AND (normalized_path IS NULL OR octet_length(normalized_path) <= 4096)
      AND (normalized_path_sha256 IS NULL
        OR normalized_path_sha256 ~ '^[0-9a-f]{64}$')
      AND jsonb_typeof(safe_evidence) = 'object'
      AND octet_length(safe_evidence::text) <= 65536
      AND (trace_public_id IS NULL OR octet_length(trace_public_id) <= 255)
    )
);

CREATE INDEX projection_invariant_diagnostics_open_idx
    ON focowiki.projection_invariant_diagnostics (
      knowledge_base_id, created_at, public_id
    ) WHERE resolved_at IS NULL;

CREATE TABLE focowiki.projection_cutover_states (
    knowledge_base_id text PRIMARY KEY,
    writer_mode text DEFAULT 'legacy' NOT NULL,
    shadow_generation_public_id text,
    cutover_generation_public_id text,
    shadow_cursor text,
    shadow_expected_path_count bigint,
    shadow_processed_path_count bigint DEFAULT 0 NOT NULL,
    shadow_target_fact_epoch bigint,
    shadow_started_at timestamp with time zone,
    shadow_completed_at timestamp with time zone,
    parity_cursor text,
    parity_processed_path_count bigint DEFAULT 0 NOT NULL,
    parity_expected_sha256 text,
    parity_actual_sha256 text,
    safe_error_code text,
    revision bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (shadow_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id),
    FOREIGN KEY (cutover_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id),
    CONSTRAINT projection_cutover_states_value_check CHECK (
      writer_mode IN ('legacy', 'shadow', 'coherent', 'paused')
      AND revision >= 0
      AND shadow_processed_path_count >= 0
      AND parity_processed_path_count >= 0
      AND (parity_expected_sha256 IS NULL
        OR parity_expected_sha256 ~ '^[0-9a-f]{64}$')
      AND (parity_actual_sha256 IS NULL
        OR parity_actual_sha256 ~ '^[0-9a-f]{64}$')
      AND (shadow_expected_path_count IS NULL
        OR shadow_expected_path_count >= shadow_processed_path_count)
      AND (shadow_target_fact_epoch IS NULL OR shadow_target_fact_epoch >= 0)
      AND (shadow_cursor IS NULL OR octet_length(shadow_cursor) <= 4096)
      AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
    )
);

CREATE TABLE focowiki.projection_shadow_scope_accumulators (
    scope_generation_public_id text PRIMARY KEY,
    item_count bigint DEFAULT 0 NOT NULL,
    rolling_sha256 text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    FOREIGN KEY (scope_generation_public_id)
      REFERENCES focowiki.projection_scope_generations(public_id)
      ON DELETE CASCADE,
    CONSTRAINT projection_shadow_scope_accumulators_value_check CHECK (
      item_count >= 0 AND rolling_sha256 ~ '^[0-9a-f]{64}$'
    )
);

CREATE TABLE focowiki.projection_shadow_parity_results (
    generation_public_id text NOT NULL,
    check_name text NOT NULL,
    state text NOT NULL,
    expected_count bigint,
    actual_count bigint,
    expected_sha256 text,
    actual_sha256 text,
    checked_at timestamp with time zone NOT NULL,
    PRIMARY KEY (generation_public_id, check_name),
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    CONSTRAINT projection_shadow_parity_results_value_check CHECK (
      check_name <> '' AND octet_length(check_name) <= 128
      AND state IN ('passed', 'failed')
      AND (expected_count IS NULL OR expected_count >= 0)
      AND (actual_count IS NULL OR actual_count >= 0)
      AND (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$')
      AND (actual_sha256 IS NULL OR actual_sha256 ~ '^[0-9a-f]{64}$')
    )
);

CREATE TABLE focowiki.projection_generation_retention (
    generation_public_id text PRIMARY KEY,
    retention_state text DEFAULT 'retained' NOT NULL,
    retain_until timestamp with time zone,
    reason text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    FOREIGN KEY (generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    CONSTRAINT projection_generation_retention_value_check CHECK (
      retention_state IN ('retained', 'eligible', 'deleting', 'deleted')
      AND reason <> '' AND octet_length(reason) <= 255
    )
);

ALTER TABLE focowiki.generated_page_heads
    ALTER COLUMN page_candidate_public_id DROP NOT NULL,
    ADD COLUMN projection_generation_public_id text,
    ADD FOREIGN KEY (projection_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id);

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v14-projection-publication-coherence'
WHERE singleton = true
  AND generation = 'storage-vnext-v13-clean-document-indexing';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
        generation = 'storage-vnext-v14-projection-publication-coherence'
    );
