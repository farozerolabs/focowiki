CREATE TABLE focowiki.publication_items (
    public_id text PRIMARY KEY,
    mutation_public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    document_job_public_id text,
    source_file_public_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    operation text NOT NULL,
    prior_logical_path text,
    next_logical_path text,
    affected_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    readiness_sequence bigint NOT NULL,
    outcome text DEFAULT 'pending' NOT NULL,
    safe_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    terminal_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    UNIQUE (knowledge_base_id, mutation_public_id),
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (document_job_public_id)
      REFERENCES focowiki.document_processing_jobs(public_id) ON DELETE SET NULL,
    CONSTRAINT publication_items_value_check CHECK (
      public_id <> '' AND octet_length(public_id) <= 255
      AND mutation_public_id <> '' AND octet_length(mutation_public_id) <= 255
      AND source_file_public_id <> ''
      AND octet_length(source_file_public_id) <= 255
      AND source_revision_public_id <> ''
      AND octet_length(source_revision_public_id) <= 255
      AND operation IN ('create', 'replace', 'move', 'rename', 'delete', 'repair')
      AND (prior_logical_path IS NULL
        OR octet_length(prior_logical_path) BETWEEN 1 AND 4096)
      AND (next_logical_path IS NULL
        OR octet_length(next_logical_path) BETWEEN 1 AND 4096)
      AND (prior_logical_path IS NOT NULL OR next_logical_path IS NOT NULL)
      AND jsonb_typeof(affected_evidence) = 'object'
      AND octet_length(affected_evidence::text) <= 65536
      AND readiness_sequence > 0
      AND outcome IN ('pending', 'committed', 'failed', 'superseded')
      AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
      AND ((outcome = 'pending' AND terminal_at IS NULL)
        OR (outcome <> 'pending' AND terminal_at IS NOT NULL))
    )
);

CREATE INDEX publication_items_eligibility_idx
    ON focowiki.publication_items (
      knowledge_base_id, readiness_sequence, public_id COLLATE "C"
    ) WHERE outcome = 'pending';

CREATE INDEX publication_items_oldest_idx
    ON focowiki.publication_items (
      created_at, knowledge_base_id, readiness_sequence, public_id COLLATE "C"
    ) WHERE outcome = 'pending';

CREATE INDEX publication_items_pending_age_idx
    ON focowiki.publication_items (
      knowledge_base_id, created_at, public_id COLLATE "C"
    ) WHERE outcome = 'pending';

CREATE TABLE focowiki.publication_jobs (
    public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    base_active_revision bigint NOT NULL,
    target_readiness_sequence bigint NOT NULL,
    renderer_contract_version text NOT NULL,
    settings_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome text DEFAULT 'pending' NOT NULL,
    attempt_owner text,
    attempt_token text,
    attempt_started_at timestamp with time zone,
    attempt_deadline timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_eligible_at timestamp with time zone DEFAULT now() NOT NULL,
    manifest_fingerprint_sha256 text,
    manifest_attempt_token text,
    safe_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    CONSTRAINT publication_jobs_value_check CHECK (
      public_id <> '' AND octet_length(public_id) <= 255
      AND base_active_revision >= 0
      AND target_readiness_sequence >= 0
      AND renderer_contract_version <> ''
      AND octet_length(renderer_contract_version) <= 128
      AND jsonb_typeof(settings_snapshot) = 'object'
      AND octet_length(settings_snapshot::text) <= 65536
      AND outcome IN ('pending', 'committed', 'failed')
      AND attempt_count BETWEEN 0 AND 3
      AND ((attempt_token IS NULL AND attempt_owner IS NULL
            AND attempt_started_at IS NULL AND attempt_deadline IS NULL)
        OR (attempt_token IS NOT NULL AND attempt_owner IS NOT NULL
            AND attempt_started_at IS NOT NULL AND attempt_deadline IS NOT NULL
            AND attempt_deadline > attempt_started_at))
      AND (manifest_fingerprint_sha256 IS NULL
        OR manifest_fingerprint_sha256 ~ '^[0-9a-f]{64}$')
      AND ((manifest_fingerprint_sha256 IS NULL
            AND manifest_attempt_token IS NULL)
        OR (manifest_fingerprint_sha256 IS NOT NULL
            AND manifest_attempt_token IS NOT NULL))
      AND (safe_error_code IS NULL OR octet_length(safe_error_code) <= 128)
      AND ((outcome = 'pending' AND completed_at IS NULL)
        OR (outcome <> 'pending' AND completed_at IS NOT NULL))
    )
);

CREATE UNIQUE INDEX publication_jobs_one_nonterminal_idx
    ON focowiki.publication_jobs (knowledge_base_id)
    WHERE outcome = 'pending';

CREATE INDEX publication_jobs_claim_idx
    ON focowiki.publication_jobs (
      next_eligible_at, created_at, public_id COLLATE "C"
    ) WHERE outcome = 'pending';

CREATE INDEX publication_jobs_expiry_idx
    ON focowiki.publication_jobs (
      attempt_deadline, public_id COLLATE "C"
    ) WHERE outcome = 'pending' AND attempt_token IS NOT NULL;

CREATE INDEX publication_jobs_retention_idx
    ON focowiki.publication_jobs (
      completed_at, public_id COLLATE "C"
    ) WHERE outcome <> 'pending';

CREATE TABLE focowiki.document_deletion_embedding_artifacts (
    operation_public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    artifact_public_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (operation_public_id, artifact_public_id),
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_public_id)
      REFERENCES focowiki.embedding_artifacts(public_id) ON DELETE CASCADE,
    CONSTRAINT document_deletion_embedding_artifacts_value_check CHECK (
      operation_public_id <> ''
      AND octet_length(operation_public_id) <= 255
      AND artifact_public_id <> ''
      AND octet_length(artifact_public_id) <= 255
    )
);

CREATE INDEX document_deletion_embedding_artifacts_knowledge_base_idx
    ON focowiki.document_deletion_embedding_artifacts (
      knowledge_base_id, operation_public_id, artifact_public_id COLLATE "C"
    );

CREATE TABLE focowiki.publication_job_items (
    job_public_id text NOT NULL,
    item_public_id text NOT NULL,
    membership_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (job_public_id, item_public_id),
    UNIQUE (item_public_id),
    UNIQUE (job_public_id, membership_order),
    FOREIGN KEY (job_public_id)
      REFERENCES focowiki.publication_jobs(public_id) ON DELETE CASCADE,
    FOREIGN KEY (item_public_id)
      REFERENCES focowiki.publication_items(public_id) ON DELETE CASCADE,
    CONSTRAINT publication_job_items_value_check CHECK (
      membership_order BETWEEN 0 AND 255
    )
);

CREATE INDEX publication_job_items_order_idx
    ON focowiki.publication_job_items (job_public_id, membership_order);

CREATE TABLE focowiki.publication_job_outputs (
    job_public_id text NOT NULL,
    normalized_path text NOT NULL,
    output_order integer NOT NULL,
    action text NOT NULL,
    logical_path text NOT NULL,
    entry_kind text,
    source_file_public_id text,
    source_revision_public_id text,
    object_id text,
    checksum_sha256 text,
    byte_count bigint,
    content_type text,
    producer_fingerprint_sha256 text NOT NULL,
    navigation_mutations jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (job_public_id, normalized_path),
    UNIQUE (job_public_id, output_order),
    FOREIGN KEY (job_public_id)
      REFERENCES focowiki.publication_jobs(public_id) ON DELETE CASCADE,
    FOREIGN KEY (object_id)
      REFERENCES focowiki.object_registrations(object_id),
    CONSTRAINT publication_job_outputs_value_check CHECK (
      normalized_path <> '' AND octet_length(normalized_path) <= 4096
      AND normalized_path = lower(normalized_path)
      AND logical_path <> '' AND octet_length(logical_path) <= 4096
      AND output_order >= 0
      AND action IN ('put', 'delete')
      AND producer_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(navigation_mutations) = 'array'
      AND octet_length(navigation_mutations::text) <= 65536
      AND ((action = 'put'
            AND entry_kind IS NOT NULL
            AND octet_length(entry_kind) BETWEEN 1 AND 128
            AND object_id IS NOT NULL
            AND checksum_sha256 ~ '^[0-9a-f]{64}$'
            AND byte_count >= 0
            AND content_type IS NOT NULL)
        OR (action = 'delete'
            AND entry_kind IS NULL AND object_id IS NULL
            AND checksum_sha256 IS NULL AND byte_count IS NULL
            AND content_type IS NULL))
    )
);

CREATE INDEX publication_job_outputs_path_idx
    ON focowiki.publication_job_outputs (
      normalized_path COLLATE "C", job_public_id
    );

CREATE TABLE focowiki.knowledge_base_publication_heads (
    knowledge_base_id text PRIMARY KEY,
    active_revision bigint DEFAULT 0 NOT NULL,
    active_readiness_sequence bigint DEFAULT 0 NOT NULL,
    latest_readiness_sequence bigint DEFAULT 0 NOT NULL,
    active_job_public_id text,
    pending_item_count integer DEFAULT 0 NOT NULL,
    oldest_pending_at timestamp with time zone,
    latest_pending_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    FOREIGN KEY (active_job_public_id)
      REFERENCES focowiki.publication_jobs(public_id),
    CONSTRAINT knowledge_base_publication_heads_value_check CHECK (
      active_revision >= 0 AND active_readiness_sequence >= 0
      AND latest_readiness_sequence >= active_readiness_sequence
      AND pending_item_count >= 0
      AND ((pending_item_count = 0
            AND oldest_pending_at IS NULL AND latest_pending_at IS NULL)
        OR (pending_item_count > 0
            AND oldest_pending_at IS NOT NULL AND latest_pending_at IS NOT NULL
            AND oldest_pending_at <= latest_pending_at))
    )
);

CREATE INDEX knowledge_base_publication_heads_pending_idx
    ON focowiki.knowledge_base_publication_heads (
      oldest_pending_at, latest_pending_at, knowledge_base_id COLLATE "C"
    ) WHERE pending_item_count > 0;

INSERT INTO focowiki.knowledge_base_publication_heads (
  knowledge_base_id, active_revision, active_readiness_sequence,
  latest_readiness_sequence, updated_at
)
SELECT knowledge_base_id, head_version, active_fact_epoch,
       active_fact_epoch, updated_at
FROM focowiki.knowledge_base_projection_heads
ON CONFLICT (knowledge_base_id) DO NOTHING;

WITH unfinished AS (
  SELECT epoch.knowledge_base_id, epoch.mutation_public_id,
         document.document_job_public_id,
         epoch.source_file_public_id, epoch.source_revision_public_id,
         epoch.fact_epoch, epoch.fact_kind, epoch.created_at,
         prior.logical_path AS prior_logical_path,
         CASE WHEN epoch.fact_kind = 'delete' THEN NULL
           ELSE coalesce(successor.logical_path, source.logical_path) END
           AS next_logical_path
  FROM focowiki.projection_fact_epochs epoch
  JOIN focowiki.knowledge_bases knowledge_base
    ON knowledge_base.public_id = epoch.knowledge_base_id
   AND knowledge_base.deleted_at IS NULL
  JOIN focowiki.knowledge_base_publication_heads head
    ON head.knowledge_base_id = epoch.knowledge_base_id
  LEFT JOIN focowiki.projection_generation_documents document
    ON document.mutation_public_id = epoch.mutation_public_id
   AND document.fact_epoch = epoch.fact_epoch
  LEFT JOIN focowiki.source_file_active_revisions active
    ON active.knowledge_base_id = epoch.knowledge_base_id
   AND active.source_file_public_id = epoch.source_file_public_id
  LEFT JOIN focowiki.document_projection_records prior
    ON prior.knowledge_base_id = epoch.knowledge_base_id
   AND prior.source_revision_public_id
         = active.active_source_revision_public_id
  LEFT JOIN focowiki.document_projection_records successor
    ON successor.knowledge_base_id = epoch.knowledge_base_id
   AND successor.source_revision_public_id = epoch.source_revision_public_id
  LEFT JOIN focowiki.source_files source
    ON source.knowledge_base_id = epoch.knowledge_base_id
   AND source.public_id = epoch.source_file_public_id
  WHERE epoch.state IN ('ready', 'included')
    AND epoch.fact_epoch > head.active_readiness_sequence
    AND active.current_source_revision_public_id
          = epoch.source_revision_public_id
    AND epoch.source_file_public_id IS NOT NULL
    AND epoch.source_revision_public_id IS NOT NULL
), unique_unfinished AS (
  SELECT DISTINCT ON (knowledge_base_id, mutation_public_id)
         unfinished.*
  FROM unfinished
  WHERE prior_logical_path IS NOT NULL OR next_logical_path IS NOT NULL
  ORDER BY knowledge_base_id, mutation_public_id,
           fact_epoch DESC, document_job_public_id NULLS LAST
)
INSERT INTO focowiki.publication_items (
  public_id, mutation_public_id, knowledge_base_id,
  document_job_public_id, source_file_public_id,
  source_revision_public_id, operation, prior_logical_path,
  next_logical_path, affected_evidence, readiness_sequence,
  created_at, updated_at
)
SELECT 'publication-migrated-item-' || md5(
         knowledge_base_id || chr(31) || mutation_public_id
       ),
       mutation_public_id, knowledge_base_id, document_job_public_id,
       source_file_public_id, source_revision_public_id,
       CASE fact_kind WHEN 'shadow' THEN 'repair' ELSE fact_kind END,
       prior_logical_path, next_logical_path,
       jsonb_build_object('migratedPublicationBoundary', true),
       fact_epoch, created_at, now()
FROM unique_unfinished
ON CONFLICT (knowledge_base_id, mutation_public_id) DO NOTHING;

WITH pending AS (
  SELECT knowledge_base_id, count(*)::integer AS item_count,
         min(created_at) AS oldest_at, max(created_at) AS latest_at
  FROM focowiki.publication_items
  WHERE outcome = 'pending'
  GROUP BY knowledge_base_id
)
UPDATE focowiki.knowledge_base_publication_heads head
SET pending_item_count = pending.item_count,
    latest_readiness_sequence = greatest(
      head.active_readiness_sequence,
      (SELECT max(item.readiness_sequence)
       FROM focowiki.publication_items item
       WHERE item.knowledge_base_id = head.knowledge_base_id)
    ),
    oldest_pending_at = pending.oldest_at,
    latest_pending_at = pending.latest_at,
    updated_at = now()
FROM pending
WHERE pending.knowledge_base_id = head.knowledge_base_id;

UPDATE focowiki.document_artifact_work work
SET state = CASE work.work_kind
      WHEN 'knowledge_projection' THEN 'waiting_on_projection'
      ELSE 'waiting'
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    ended_at = NULL,
    safe_error_code = NULL,
    safe_error_message = NULL,
    retryable = false,
    updated_at = now()
FROM focowiki.publication_items item
WHERE item.document_job_public_id = work.document_job_public_id
  AND item.affected_evidence ? 'migratedPublicationBoundary'
  AND work.work_kind IN ('knowledge_projection', 'activate');

UPDATE focowiki.document_processing_jobs job
SET state = 'processing',
    active_work_kinds = '{}'::text[],
    blocking_work_kind = 'knowledge_projection',
    retrying_work_kind = NULL,
    safe_error_code = NULL,
    safe_error_message = NULL,
    retryable = false,
    terminal_at = NULL,
    updated_at = now()
WHERE job.state NOT IN ('available', 'cancelled', 'superseded')
  AND EXISTS (
    SELECT 1 FROM focowiki.publication_items item
    WHERE item.document_job_public_id = job.public_id
      AND item.affected_evidence ? 'migratedPublicationBoundary'
  );

DROP TRIGGER IF EXISTS knowledge_bases_projection_publication_owner
ON focowiki.knowledge_bases;

DROP FUNCTION IF EXISTS focowiki.initialize_projection_publication_owner();
DROP FUNCTION IF EXISTS focowiki.try_cleanup_legacy_projection_schema(
  timestamp with time zone
);
DROP FUNCTION IF EXISTS focowiki.legacy_projection_object_is_referenced(text);

ALTER TABLE focowiki.generated_page_heads
    DROP COLUMN IF EXISTS projection_generation_public_id;

DROP TABLE IF EXISTS
    focowiki.projection_scope_storage_metrics,
    focowiki.projection_scope_object_refs,
    focowiki.projection_scope_receipts,
    focowiki.projection_scope_outputs,
    focowiki.projection_scope_contributions,
    focowiki.projection_dirty_scopes,
    focowiki.scoped_activation_owners,
    focowiki.projection_shadow_parity_results,
    focowiki.projection_shadow_scope_accumulators,
    focowiki.projection_cutover_states,
    focowiki.projection_invariant_diagnostics,
    focowiki.projection_generation_validation_results,
    focowiki.projection_scope_generation_object_refs,
    focowiki.projection_scope_navigation_mutations,
    focowiki.projection_generation_directory_claims,
    focowiki.projection_scope_generation_pages,
    focowiki.projection_scope_snapshot_members,
    focowiki.projection_scope_generation_dependencies,
    focowiki.projection_scope_generations,
    focowiki.projection_scheduler_credits,
    focowiki.projection_activation_owner_reservations,
    focowiki.projection_generation_graph_degrees,
    focowiki.projection_generation_affected_members,
    focowiki.projection_generation_statistics,
    focowiki.projection_generation_retention,
    focowiki.projection_artifact_owners,
    focowiki.projection_directory_owners,
    focowiki.projection_generation_documents,
    focowiki.projection_fact_epochs,
    focowiki.knowledge_base_projection_heads,
    focowiki.projection_publication_generations,
    focowiki.projection_legacy_cleanup_state
CASCADE;

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v21-single-job-publication-foundation'
WHERE singleton = true
  AND generation = 'storage-vnext-v20-projection-runtime-recovery';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v21-single-job-publication-foundation'
    );
