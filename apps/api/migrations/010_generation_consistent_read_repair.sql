CREATE TABLE focowiki.generation_directory_navigation_summaries (
    generation_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    directory_path text NOT NULL,
    entry_count bigint DEFAULT 0 NOT NULL,
    first_leaf_id text,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_directory_navigation_summaries_count_check
      CHECK (entry_count >= 0),
    CONSTRAINT generation_directory_navigation_summaries_pkey
      PRIMARY KEY (generation_id, directory_path),
    CONSTRAINT generation_directory_navigation_summaries_generation_fkey
      FOREIGN KEY (generation_id)
      REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT generation_directory_navigation_summaries_knowledge_base_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE TABLE focowiki.generation_directory_navigation_leaves (
    generation_id text NOT NULL,
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
    CONSTRAINT generation_directory_navigation_leaves_count_check
      CHECK (entry_count >= 0 AND byte_count >= 0),
    CONSTRAINT generation_directory_navigation_leaves_entries_check
      CHECK (jsonb_typeof(entries_json) = 'array'),
    CONSTRAINT generation_directory_navigation_leaves_pkey
      PRIMARY KEY (generation_id, id),
    CONSTRAINT generation_directory_navigation_leaves_generation_fkey
      FOREIGN KEY (generation_id)
      REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT generation_directory_navigation_leaves_knowledge_base_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE TABLE focowiki.generation_directory_navigation_changes (
    generation_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    directory_path text NOT NULL,
    entry_id text NOT NULL,
    touched_leaf_ids text[] DEFAULT '{}'::text[] NOT NULL,
    removed_leaf_ids text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_directory_navigation_changes_pkey
      PRIMARY KEY (generation_id, directory_path, entry_id),
    CONSTRAINT generation_directory_navigation_changes_generation_fkey
      FOREIGN KEY (generation_id)
      REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT generation_directory_navigation_changes_knowledge_base_fkey
      FOREIGN KEY (knowledge_base_id)
      REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX generation_directory_navigation_leaves_order_idx
  ON focowiki.generation_directory_navigation_leaves (
    generation_id, directory_path, first_sort_key, id
  );

CREATE INDEX generation_directory_navigation_leaves_entries_idx
  ON focowiki.generation_directory_navigation_leaves
  USING gin (entries_json jsonb_path_ops);

CREATE INDEX generation_directory_navigation_changes_directory_idx
  ON focowiki.generation_directory_navigation_changes (
    generation_id, directory_path, entry_id
  );

CREATE INDEX active_projection_records_search_title_exact_idx
  ON focowiki.active_projection_records (
    knowledge_base_id, lower(coalesce(title, '')), record_id
  )
  WHERE projection_kind = 'search';

CREATE INDEX active_projection_records_graph_title_exact_idx
  ON focowiki.active_projection_records (
    knowledge_base_id, lower(coalesce(title, '')), projection_kind, record_id
  )
  WHERE projection_kind IN ('graph_node', 'graph_edge');

INSERT INTO focowiki.generation_directory_navigation_summaries (
  generation_id, knowledge_base_id, directory_path, entry_count,
  first_leaf_id, revision, updated_at
)
SELECT knowledge_base.active_generation_id, legacy.knowledge_base_id,
       legacy.directory_path, legacy.entry_count, legacy.first_leaf_id,
       legacy.revision, legacy.updated_at
FROM focowiki.directory_navigation_summaries legacy
JOIN focowiki.knowledge_bases knowledge_base
  ON knowledge_base.id = legacy.knowledge_base_id
 AND knowledge_base.active_generation_id IS NOT NULL
ON CONFLICT (generation_id, directory_path) DO NOTHING;

INSERT INTO focowiki.generation_directory_navigation_leaves (
  generation_id, id, knowledge_base_id, directory_path,
  previous_leaf_id, next_leaf_id, entry_count, byte_count,
  first_sort_key, last_sort_key, entries_json, revision, updated_at
)
SELECT knowledge_base.active_generation_id, legacy.id, legacy.knowledge_base_id,
       legacy.directory_path, legacy.previous_leaf_id, legacy.next_leaf_id,
       legacy.entry_count, legacy.byte_count, legacy.first_sort_key,
       legacy.last_sort_key, legacy.entries_json, legacy.revision, legacy.updated_at
FROM focowiki.directory_navigation_leaves legacy
JOIN focowiki.knowledge_bases knowledge_base
  ON knowledge_base.id = legacy.knowledge_base_id
 AND knowledge_base.active_generation_id IS NOT NULL
ON CONFLICT (generation_id, id) DO NOTHING;

UPDATE focowiki.runtime_generation
SET generation = 'generation-consistent-read-repair-v10'
WHERE singleton = true;
