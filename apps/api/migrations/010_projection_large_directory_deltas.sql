CREATE TABLE focowiki.projection_generation_graph_degrees (
    publication_generation_public_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    source_revision_public_id text NOT NULL,
    incoming_count integer DEFAULT 0 NOT NULL,
    outgoing_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (
      publication_generation_public_id, source_revision_public_id
    ),
    FOREIGN KEY (publication_generation_public_id)
      REFERENCES focowiki.projection_publication_generations(public_id)
      ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id, source_revision_public_id)
      REFERENCES focowiki.document_projection_records(
        knowledge_base_id, source_revision_public_id
      ) ON DELETE CASCADE,
    CONSTRAINT projection_generation_graph_degrees_value_check CHECK (
      incoming_count >= 0 AND outgoing_count >= 0
    )
);

CREATE INDEX projection_generation_graph_degrees_directory_idx
    ON focowiki.projection_generation_graph_degrees (
      knowledge_base_id, publication_generation_public_id,
      source_revision_public_id
    ) INCLUDE (incoming_count, outgoing_count);

CREATE INDEX document_projection_records_revision_visibility_idx
    ON focowiki.document_projection_records (
      knowledge_base_id, source_revision_public_id
    ) INCLUDE (source_file_public_id, active, normalized_path, title);

CREATE INDEX document_semantic_memberships_directory_revision_idx
    ON focowiki.document_semantic_directory_memberships (
      knowledge_base_id, directory_path, source_revision_public_id
    ) INCLUDE (page_path);

CREATE INDEX canonical_file_relations_first_revision_visible_idx
    ON focowiki.canonical_file_relations (
      knowledge_base_id, first_source_revision_public_id
    ) INCLUDE (
      public_id, pair_public_id, second_source_revision_public_id,
      first_source_file_public_id, second_source_file_public_id, active,
      retired_at
    );

CREATE INDEX canonical_file_relations_second_revision_visible_idx
    ON focowiki.canonical_file_relations (
      knowledge_base_id, second_source_revision_public_id
    ) INCLUDE (
      public_id, pair_public_id, first_source_revision_public_id,
      first_source_file_public_id, second_source_file_public_id, active,
      retired_at
    );

CREATE INDEX canonical_file_relations_first_file_history_idx
    ON focowiki.canonical_file_relations (
      knowledge_base_id, first_source_file_public_id
    ) INCLUDE (
      first_source_revision_public_id, second_source_file_public_id,
      second_source_revision_public_id, public_id, retired_at
    );

CREATE INDEX canonical_file_relations_second_file_history_idx
    ON focowiki.canonical_file_relations (
      knowledge_base_id, second_source_file_public_id
    ) INCLUDE (
      second_source_revision_public_id, first_source_file_public_id,
      first_source_revision_public_id, public_id, retired_at
    );

CREATE INDEX relation_directed_evidence_pair_visible_idx
    ON focowiki.relation_directed_evidence (
      knowledge_base_id, pair_public_id
    ) INCLUDE (
      source_revision_public_id, target_source_revision_public_id,
      source_file_public_id, target_source_file_public_id, active
    ) WHERE retired_at IS NULL;

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v18-projection-large-directory-deltas'
WHERE singleton = true
  AND generation = 'storage-vnext-v17-projection-resource-recovery';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v18-projection-large-directory-deltas'
    );
