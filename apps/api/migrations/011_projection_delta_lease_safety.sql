ALTER TABLE focowiki.projection_publication_generations
    ADD COLUMN planning_mode text DEFAULT 'delta' NOT NULL,
    ADD COLUMN affected_closure_fingerprint_sha256 text
      DEFAULT repeat('0', 64) NOT NULL,
    ADD COLUMN full_rebuild_reason text,
    ADD COLUMN supersession_reason text,
    ADD COLUMN superseded_by_generation_public_id text,
    ADD COLUMN recovery_evidence jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE focowiki.projection_publication_generations
    ADD CONSTRAINT projection_publication_generations_planning_check CHECK (
      planning_mode IN ('initial', 'delta', 'repair')
      AND affected_closure_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      AND (planning_mode = 'delta' OR full_rebuild_reason IS NOT NULL)
      AND (full_rebuild_reason IS NULL
        OR octet_length(full_rebuild_reason) BETWEEN 1 AND 128)
      AND (supersession_reason IS NULL
        OR octet_length(supersession_reason) BETWEEN 1 AND 128)
      AND jsonb_typeof(recovery_evidence) = 'object'
      AND octet_length(recovery_evidence::text) <= 16384
    ),
    ADD CONSTRAINT projection_publication_generations_replacement_fk
      FOREIGN KEY (superseded_by_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id);

CREATE TABLE focowiki.projection_generation_affected_members (
    publication_generation_public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    member_kind text NOT NULL,
    member_public_id text NOT NULL,
    source_file_public_id text,
    member_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (
      publication_generation_public_id, member_kind, member_public_id
    ),
    UNIQUE (publication_generation_public_id, member_order),
    FOREIGN KEY (publication_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    CONSTRAINT projection_generation_affected_members_value_check CHECK (
      member_kind IN (
        'source', 'revision', 'prior_path', 'successor_path',
        'relation_endpoint', 'directory', 'record_owner',
        'navigation_neighbor'
      )
      AND octet_length(member_public_id) BETWEEN 1 AND 4096
      AND (source_file_public_id IS NULL
        OR octet_length(source_file_public_id) BETWEEN 1 AND 255)
      AND member_order >= 0
    )
);

CREATE INDEX projection_generation_affected_members_source_idx
    ON focowiki.projection_generation_affected_members (
      knowledge_base_id, publication_generation_public_id,
      source_file_public_id, member_order
    );

CREATE TABLE focowiki.projection_generation_statistics (
    publication_generation_public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    source_file_count bigint NOT NULL,
    relationship_count bigint NOT NULL,
    root_entry_count bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    FOREIGN KEY (publication_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(public_id) ON DELETE CASCADE,
    CONSTRAINT projection_generation_statistics_value_check CHECK (
      source_file_count >= 0 AND relationship_count >= 0
      AND root_entry_count >= 0
    )
);

INSERT INTO focowiki.projection_generation_statistics (
  publication_generation_public_id, knowledge_base_id,
  source_file_count, relationship_count, root_entry_count
)
SELECT generation.public_id, generation.knowledge_base_id,
       (SELECT count(*)
        FROM focowiki.generated_page_heads page
        WHERE page.knowledge_base_id = generation.knowledge_base_id
          AND page.entry_kind = 'source'),
       (SELECT count(*)
        FROM focowiki.canonical_file_relations relation
        WHERE relation.knowledge_base_id = generation.knowledge_base_id
          AND relation.active
          AND EXISTS (
            SELECT 1 FROM focowiki.relation_directed_evidence evidence
            WHERE evidence.knowledge_base_id = relation.knowledge_base_id
              AND evidence.pair_public_id = relation.pair_public_id
              AND evidence.active
          )),
       (SELECT coalesce(sum(leaf.entry_count), 0)
        FROM focowiki.generated_directory_leaves leaf
        WHERE leaf.knowledge_base_id = generation.knowledge_base_id
          AND leaf.directory_path = 'pages')
FROM focowiki.projection_publication_generations generation
JOIN focowiki.knowledge_base_projection_heads head
  ON head.active_generation_public_id = generation.public_id
ON CONFLICT (publication_generation_public_id) DO NOTHING;

CREATE INDEX projection_generation_statistics_knowledge_base_idx
    ON focowiki.projection_generation_statistics (
      knowledge_base_id, publication_generation_public_id
    ) INCLUDE (source_file_count, relationship_count, root_entry_count);

CREATE INDEX projection_publication_generations_contract_recovery_idx
    ON focowiki.projection_publication_generations (
      renderer_contract_version, updated_at, public_id
    ) WHERE state IN ('planned', 'rendering', 'validating', 'ready');

CREATE INDEX projection_publication_generations_supersession_idx
    ON focowiki.projection_publication_generations (
      knowledge_base_id, superseded_by_generation_public_id, completed_at
    ) WHERE state = 'obsolete';

ALTER TABLE focowiki.projection_scope_generations
    ADD COLUMN consecutive_lease_loss_count integer DEFAULT 0 NOT NULL,
    ADD COLUMN last_progress_at timestamp with time zone,
    ADD COLUMN progress_evidence jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE focowiki.projection_scope_generations
    ADD CONSTRAINT projection_scope_generations_progress_check CHECK (
      consecutive_lease_loss_count BETWEEN 0 AND 2
      AND jsonb_typeof(progress_evidence) = 'object'
      AND octet_length(progress_evidence::text) <= 16384
    );

CREATE INDEX projection_scope_generations_lease_loss_idx
    ON focowiki.projection_scope_generations (
      publication_generation_public_id, scope_identity,
      input_snapshot_fingerprint_sha256, consecutive_lease_loss_count
    ) WHERE state IN ('waiting', 'running');

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v19-projection-delta-lease-safety'
WHERE singleton = true
  AND generation = 'storage-vnext-v18-projection-large-directory-deltas';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v19-projection-delta-lease-safety'
    );
