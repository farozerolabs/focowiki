CREATE TABLE IF NOT EXISTS focowiki.source_file_graph_term_documents (
    knowledge_base_id text NOT NULL,
    source_file_id text NOT NULL,
    source_revision_id text NOT NULL,
    term_fingerprint text NOT NULL,
    lexical_text text NOT NULL,
    lexical_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, lexical_text)
    ) STORED,
    exact_terms text[] DEFAULT ARRAY[]::text[] NOT NULL,
    phrase_terms text[] DEFAULT ARRAY[]::text[] NOT NULL,
    explicit_references text[] DEFAULT ARRAY[]::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_graph_term_documents_pkey
      PRIMARY KEY (knowledge_base_id, source_file_id),
    CONSTRAINT source_file_graph_term_documents_fingerprint_check
      CHECK (term_fingerprint ~ '^[a-f0-9]{32,64}$'),
    CONSTRAINT source_file_graph_term_documents_term_caps_check
      CHECK (
        cardinality(exact_terms) <= 600
        AND cardinality(phrase_terms) <= 120
        AND cardinality(explicit_references) <= 100
        AND octet_length(lexical_text) <= 65536
      ),
    CONSTRAINT source_file_graph_term_documents_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT source_file_graph_term_documents_source_file_id_fkey
      FOREIGN KEY (source_file_id) REFERENCES focowiki.source_files(id) ON DELETE CASCADE,
    CONSTRAINT source_file_graph_term_documents_source_revision_id_fkey
      FOREIGN KEY (source_revision_id) REFERENCES focowiki.source_revisions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS source_file_graph_term_documents_revision_idx
  ON focowiki.source_file_graph_term_documents
  (knowledge_base_id, source_revision_id, source_file_id);
CREATE INDEX IF NOT EXISTS source_file_graph_term_documents_lexical_gin_idx
  ON focowiki.source_file_graph_term_documents USING gin (lexical_vector);
CREATE INDEX IF NOT EXISTS source_file_graph_term_documents_exact_gin_idx
  ON focowiki.source_file_graph_term_documents USING gin (exact_terms);
CREATE INDEX IF NOT EXISTS source_file_graph_term_documents_phrase_gin_idx
  ON focowiki.source_file_graph_term_documents USING gin (phrase_terms);
CREATE INDEX IF NOT EXISTS source_file_graph_term_documents_reference_gin_idx
  ON focowiki.source_file_graph_term_documents USING gin (explicit_references);
CREATE INDEX IF NOT EXISTS source_file_graph_term_documents_text_trgm_idx
  ON focowiki.source_file_graph_term_documents USING gin (lexical_text focowiki.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS active_object_refs_generated_path_idx
  ON focowiki.active_object_refs (knowledge_base_id, logical_path)
  WHERE logical_path IS NOT NULL
    AND ref_kind NOT IN ('page', 'generation_manifest');

CREATE INDEX IF NOT EXISTS source_revisions_migration_page_idx
  ON focowiki.source_revisions (knowledge_base_id, source_file_id, id)
  INCLUDE (object_key);

CREATE TABLE IF NOT EXISTS focowiki.source_file_graph_term_frequencies (
    knowledge_base_id text NOT NULL,
    term text NOT NULL,
    counter_shard smallint NOT NULL,
    document_count bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_file_graph_term_frequencies_pkey
      PRIMARY KEY (knowledge_base_id, term, counter_shard),
    CONSTRAINT source_file_graph_term_frequencies_count_check
      CHECK (document_count >= 0),
    CONSTRAINT source_file_graph_term_frequencies_shard_check
      CHECK (counter_shard >= 0 AND counter_shard < 32),
    CONSTRAINT source_file_graph_term_frequencies_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION focowiki.graph_term_frequency_shard(
  target_source_file_id text
) RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (hashtextextended(target_source_file_id, 0) & 31)::smallint
$$;

INSERT INTO focowiki.source_file_graph_term_frequencies (
  knowledge_base_id, term, counter_shard, document_count, updated_at
)
SELECT document.knowledge_base_id, term.value,
       focowiki.graph_term_frequency_shard(document.source_file_id),
       count(*)::bigint, now()
FROM focowiki.source_file_graph_term_documents document
CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
GROUP BY document.knowledge_base_id, term.value,
         focowiki.graph_term_frequency_shard(document.source_file_id)
ON CONFLICT (knowledge_base_id, term, counter_shard) DO UPDATE
SET document_count = EXCLUDED.document_count,
    updated_at = EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION focowiki.lock_graph_term_frequency_scopes(
  target_knowledge_base_ids text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_scope_key text;
BEGIN
  FOR target_scope_key IN
    SELECT DISTINCT value
    FROM unnest(target_knowledge_base_ids) AS value
    WHERE value IS NOT NULL
    ORDER BY value
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'focowiki:graph-term-frequency:' || target_scope_key,
        0
      )
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.increment_graph_term_frequencies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM focowiki.lock_graph_term_frequency_scopes(
    ARRAY(
      SELECT DISTINCT knowledge_base_id || ':'
             || focowiki.graph_term_frequency_shard(source_file_id)::text
      FROM new_rows
    )
  );
  INSERT INTO focowiki.source_file_graph_term_frequencies (
    knowledge_base_id, term, counter_shard, document_count, updated_at
  )
  SELECT document.knowledge_base_id, term.value,
         focowiki.graph_term_frequency_shard(document.source_file_id),
         count(*)::bigint, now()
  FROM new_rows document
  CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
  GROUP BY document.knowledge_base_id, term.value,
           focowiki.graph_term_frequency_shard(document.source_file_id)
  ORDER BY document.knowledge_base_id,
           focowiki.graph_term_frequency_shard(document.source_file_id), term.value
  ON CONFLICT (knowledge_base_id, term, counter_shard) DO UPDATE
  SET document_count = focowiki.source_file_graph_term_frequencies.document_count
      + EXCLUDED.document_count,
      updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.decrement_graph_term_frequencies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM focowiki.lock_graph_term_frequency_scopes(
    ARRAY(
      SELECT DISTINCT knowledge_base_id || ':'
             || focowiki.graph_term_frequency_shard(source_file_id)::text
      FROM old_rows
    )
  );
  WITH removed AS MATERIALIZED (
    SELECT document.knowledge_base_id, term.value AS term,
           focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard,
           count(*)::bigint AS count
    FROM old_rows document
    CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
    GROUP BY document.knowledge_base_id, term.value,
             focowiki.graph_term_frequency_shard(document.source_file_id)
  )
  UPDATE focowiki.source_file_graph_term_frequencies frequency
  SET document_count = greatest(0, frequency.document_count - removed.count),
      updated_at = now()
  FROM removed
  WHERE frequency.knowledge_base_id = removed.knowledge_base_id
    AND frequency.term = removed.term
    AND frequency.counter_shard = removed.counter_shard;

  DELETE FROM focowiki.source_file_graph_term_frequencies frequency
  USING (
    SELECT DISTINCT document.knowledge_base_id, term.value AS term,
           focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard
    FROM old_rows document
    CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
  ) removed
  WHERE frequency.knowledge_base_id = removed.knowledge_base_id
    AND frequency.term = removed.term
    AND frequency.counter_shard = removed.counter_shard
    AND frequency.document_count = 0;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.replace_graph_term_frequencies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM focowiki.lock_graph_term_frequency_scopes(
    ARRAY(
      SELECT knowledge_base_id || ':'
             || focowiki.graph_term_frequency_shard(source_file_id)::text
      FROM old_rows
      UNION
      SELECT knowledge_base_id || ':'
             || focowiki.graph_term_frequency_shard(source_file_id)::text
      FROM new_rows
    )
  );
  WITH old_counts AS MATERIALIZED (
    SELECT document.knowledge_base_id, term.value AS term,
           focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard,
           count(*)::bigint AS count
    FROM old_rows document
    CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
    GROUP BY document.knowledge_base_id, term.value,
             focowiki.graph_term_frequency_shard(document.source_file_id)
  ), new_counts AS MATERIALIZED (
    SELECT document.knowledge_base_id, term.value AS term,
           focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard,
           count(*)::bigint AS count
    FROM new_rows document
    CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
    GROUP BY document.knowledge_base_id, term.value,
             focowiki.graph_term_frequency_shard(document.source_file_id)
  ), deltas AS MATERIALIZED (
    SELECT coalesce(new_counts.knowledge_base_id, old_counts.knowledge_base_id)
             AS knowledge_base_id,
           coalesce(new_counts.term, old_counts.term) AS term,
           coalesce(new_counts.counter_shard, old_counts.counter_shard) AS counter_shard,
           coalesce(new_counts.count, 0) - coalesce(old_counts.count, 0) AS delta
    FROM old_counts
    FULL OUTER JOIN new_counts USING (knowledge_base_id, term, counter_shard)
    WHERE coalesce(new_counts.count, 0) <> coalesce(old_counts.count, 0)
  )
  UPDATE focowiki.source_file_graph_term_frequencies frequency
  SET document_count = greatest(0, frequency.document_count + deltas.delta),
      updated_at = now()
  FROM deltas
  WHERE deltas.delta < 0
    AND frequency.knowledge_base_id = deltas.knowledge_base_id
    AND frequency.term = deltas.term
    AND frequency.counter_shard = deltas.counter_shard;

  DELETE FROM focowiki.source_file_graph_term_frequencies frequency
  USING (
    WITH old_counts AS MATERIALIZED (
      SELECT document.knowledge_base_id, term.value AS term,
             focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard,
             count(*)::bigint AS count
      FROM old_rows document
      CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
      GROUP BY document.knowledge_base_id, term.value,
               focowiki.graph_term_frequency_shard(document.source_file_id)
    ), new_counts AS MATERIALIZED (
      SELECT document.knowledge_base_id, term.value AS term,
             focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard,
             count(*)::bigint AS count
      FROM new_rows document
      CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
      GROUP BY document.knowledge_base_id, term.value,
               focowiki.graph_term_frequency_shard(document.source_file_id)
    )
    SELECT old_counts.knowledge_base_id, old_counts.term,
           old_counts.counter_shard
    FROM old_counts
    LEFT JOIN new_counts USING (knowledge_base_id, term, counter_shard)
    WHERE old_counts.count > coalesce(new_counts.count, 0)
  ) removed
  WHERE frequency.knowledge_base_id = removed.knowledge_base_id
    AND frequency.term = removed.term
    AND frequency.counter_shard = removed.counter_shard
    AND frequency.document_count = 0;

  INSERT INTO focowiki.source_file_graph_term_frequencies (
    knowledge_base_id, term, counter_shard, document_count, updated_at
  )
  WITH old_counts AS MATERIALIZED (
    SELECT document.knowledge_base_id, term.value AS term,
           focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard,
           count(*)::bigint AS count
    FROM old_rows document
    CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
    GROUP BY document.knowledge_base_id, term.value,
             focowiki.graph_term_frequency_shard(document.source_file_id)
  ), new_counts AS MATERIALIZED (
    SELECT document.knowledge_base_id, term.value AS term,
           focowiki.graph_term_frequency_shard(document.source_file_id) AS counter_shard,
           count(*)::bigint AS count
    FROM new_rows document
    CROSS JOIN LATERAL unnest(document.exact_terms[1:100]) AS term(value)
    GROUP BY document.knowledge_base_id, term.value,
             focowiki.graph_term_frequency_shard(document.source_file_id)
  )
  SELECT new_counts.knowledge_base_id, new_counts.term, new_counts.counter_shard,
         new_counts.count - coalesce(old_counts.count, 0), now()
  FROM new_counts
  LEFT JOIN old_counts USING (knowledge_base_id, term, counter_shard)
  WHERE new_counts.count > coalesce(old_counts.count, 0)
  ORDER BY new_counts.knowledge_base_id, new_counts.counter_shard, new_counts.term
  ON CONFLICT (knowledge_base_id, term, counter_shard) DO UPDATE
  SET document_count = focowiki.source_file_graph_term_frequencies.document_count
      + EXCLUDED.document_count,
      updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS graph_term_frequencies_insert
  ON focowiki.source_file_graph_term_documents;
DROP TRIGGER IF EXISTS graph_term_frequencies_update
  ON focowiki.source_file_graph_term_documents;
DROP TRIGGER IF EXISTS graph_term_frequencies_delete
  ON focowiki.source_file_graph_term_documents;
CREATE TRIGGER graph_term_frequencies_insert
  AFTER INSERT ON focowiki.source_file_graph_term_documents
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.increment_graph_term_frequencies();
CREATE TRIGGER graph_term_frequencies_update
  AFTER UPDATE ON focowiki.source_file_graph_term_documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.replace_graph_term_frequencies();
CREATE TRIGGER graph_term_frequencies_delete
  AFTER DELETE ON focowiki.source_file_graph_term_documents
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.decrement_graph_term_frequencies();

CREATE TABLE IF NOT EXISTS focowiki.knowledge_base_incremental_stats (
    knowledge_base_id text PRIMARY KEY,
    source_file_count bigint DEFAULT 0 NOT NULL,
    source_directory_count bigint DEFAULT 0 NOT NULL,
    graph_node_count bigint DEFAULT 0 NOT NULL,
    graph_edge_count bigint DEFAULT 0 NOT NULL,
    active_projection_record_count bigint DEFAULT 0 NOT NULL,
    active_generated_object_count bigint DEFAULT 0 NOT NULL,
    stats_revision bigint DEFAULT 0 NOT NULL,
    reconciled_at timestamp with time zone,
    reconciliation_lease_owner text,
    reconciliation_lease_token text,
    reconciliation_lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_base_incremental_stats_counts_check CHECK (
      source_file_count >= 0
      AND source_directory_count >= 0
      AND graph_node_count >= 0
      AND graph_edge_count >= 0
      AND active_projection_record_count >= 0
      AND active_generated_object_count >= 0
      AND stats_revision >= 0
    ),
    CONSTRAINT knowledge_base_incremental_stats_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

ALTER TABLE focowiki.knowledge_base_incremental_stats
  ADD COLUMN IF NOT EXISTS reconciliation_lease_owner text,
  ADD COLUMN IF NOT EXISTS reconciliation_lease_token text,
  ADD COLUMN IF NOT EXISTS reconciliation_lease_expires_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS knowledge_base_incremental_stats_reconciliation_idx
  ON focowiki.knowledge_base_incremental_stats (
    reconciled_at, reconciliation_lease_expires_at, knowledge_base_id
  );

CREATE TABLE IF NOT EXISTS focowiki.knowledge_base_incremental_stat_shards (
    knowledge_base_id text NOT NULL,
    counter_shard smallint NOT NULL,
    source_file_count bigint DEFAULT 0 NOT NULL,
    source_directory_count bigint DEFAULT 0 NOT NULL,
    graph_node_count bigint DEFAULT 0 NOT NULL,
    graph_edge_count bigint DEFAULT 0 NOT NULL,
    active_projection_record_count bigint DEFAULT 0 NOT NULL,
    active_generated_object_count bigint DEFAULT 0 NOT NULL,
    stats_revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, counter_shard),
    CONSTRAINT knowledge_base_incremental_stat_shards_range_check
      CHECK (counter_shard >= 0 AND counter_shard < 32),
    CONSTRAINT knowledge_base_incremental_stat_shards_revision_check
      CHECK (stats_revision >= 0),
    CONSTRAINT knowledge_base_incremental_stat_shards_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION focowiki.incremental_stat_shard(
  resource_identity text
) RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT mod(
    hashtextextended(coalesce(resource_identity, ''), 0)
      & 9223372036854775807,
    32
  )::smallint;
$$;

INSERT INTO focowiki.knowledge_base_incremental_stats (
  knowledge_base_id, source_file_count, source_directory_count,
  graph_node_count, graph_edge_count, active_projection_record_count,
  active_generated_object_count, stats_revision, reconciled_at
)
SELECT knowledge_base.id,
       (SELECT count(*) FROM focowiki.source_files source
        WHERE source.knowledge_base_id = knowledge_base.id AND source.deleted_at IS NULL),
       (SELECT count(*) FROM focowiki.source_directories directory
        WHERE directory.knowledge_base_id = knowledge_base.id AND directory.deleted_at IS NULL),
       (SELECT count(*) FROM focowiki.source_file_graph_nodes node
        WHERE node.knowledge_base_id = knowledge_base.id),
       (SELECT count(*) FROM focowiki.source_file_graph_edges edge
        WHERE edge.knowledge_base_id = knowledge_base.id AND edge.status = 'accepted'),
       (SELECT count(*) FROM focowiki.active_projection_records projection
        WHERE projection.knowledge_base_id = knowledge_base.id),
       (SELECT count(*) FROM focowiki.active_object_refs reference
        WHERE reference.knowledge_base_id = knowledge_base.id),
       1,
       now()
FROM focowiki.knowledge_bases knowledge_base
WHERE knowledge_base.deleted_at IS NULL
ON CONFLICT (knowledge_base_id) DO NOTHING;

INSERT INTO focowiki.knowledge_base_incremental_stat_shards (
  knowledge_base_id, counter_shard, source_file_count, source_directory_count,
  graph_node_count, graph_edge_count, active_projection_record_count,
  active_generated_object_count, stats_revision, updated_at
)
SELECT knowledge_base_id, 0, source_file_count, source_directory_count,
       graph_node_count, graph_edge_count, active_projection_record_count,
       active_generated_object_count, stats_revision, updated_at
FROM focowiki.knowledge_base_incremental_stats
ON CONFLICT (knowledge_base_id, counter_shard) DO NOTHING;

CREATE OR REPLACE FUNCTION focowiki.apply_incremental_stat_delta(
  target_knowledge_base_id text,
  target_counter_shard smallint,
  target_column text,
  target_delta bigint
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF target_delta = 0 THEN
    RETURN;
  END IF;
  IF target_counter_shard < 0 OR target_counter_shard >= 32 THEN
    RAISE EXCEPTION 'Unsupported incremental statistic shard';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM focowiki.knowledge_bases
    WHERE id = target_knowledge_base_id
  ) THEN
    RETURN;
  END IF;
  IF target_column NOT IN (
    'source_file_count', 'source_directory_count', 'graph_node_count',
    'graph_edge_count', 'active_projection_record_count',
    'active_generated_object_count'
  ) THEN
    RAISE EXCEPTION 'Unsupported incremental statistic column';
  END IF;
  EXECUTE format(
    'INSERT INTO focowiki.knowledge_base_incremental_stat_shards '
    || '(knowledge_base_id, counter_shard, %I, stats_revision, updated_at) '
    || 'VALUES ($1, $2, $3, 1, now()) '
    || 'ON CONFLICT (knowledge_base_id, counter_shard) DO UPDATE SET '
    || '%I = focowiki.knowledge_base_incremental_stat_shards.%I + $3, '
    || 'stats_revision = focowiki.knowledge_base_incremental_stat_shards.stats_revision + 1, '
    || 'updated_at = now()',
    target_column, target_column, target_column
  ) USING target_knowledge_base_id, target_counter_shard, target_delta;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.update_incremental_stat_all_rows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR item IN
      WITH old_counts AS (
        SELECT knowledge_base_id,
               focowiki.incremental_stat_shard(to_jsonb(old_rows)->>TG_ARGV[1])
                 AS counter_shard,
               count(*)::bigint AS count
        FROM old_rows GROUP BY knowledge_base_id, counter_shard
      ), new_counts AS (
        SELECT knowledge_base_id,
               focowiki.incremental_stat_shard(to_jsonb(new_rows)->>TG_ARGV[1])
                 AS counter_shard,
               count(*)::bigint AS count
        FROM new_rows GROUP BY knowledge_base_id, counter_shard
      )
      SELECT coalesce(new_counts.knowledge_base_id, old_counts.knowledge_base_id)
               AS knowledge_base_id,
             coalesce(new_counts.counter_shard, old_counts.counter_shard)
               AS counter_shard,
             coalesce(new_counts.count, 0) - coalesce(old_counts.count, 0) AS delta
      FROM old_counts
      FULL OUTER JOIN new_counts USING (knowledge_base_id, counter_shard)
      WHERE coalesce(new_counts.count, 0) <> coalesce(old_counts.count, 0)
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, TG_ARGV[0], item.delta
      );
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    FOR item IN
      SELECT knowledge_base_id,
             focowiki.incremental_stat_shard(to_jsonb(old_rows)->>TG_ARGV[1])
               AS counter_shard,
             -count(*)::bigint AS delta
      FROM old_rows GROUP BY knowledge_base_id, counter_shard
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, TG_ARGV[0], item.delta
      );
    END LOOP;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOR item IN
      SELECT knowledge_base_id,
             focowiki.incremental_stat_shard(to_jsonb(new_rows)->>TG_ARGV[1])
               AS counter_shard,
             count(*)::bigint AS delta
      FROM new_rows GROUP BY knowledge_base_id, counter_shard
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, TG_ARGV[0], item.delta
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.update_incremental_stat_visible_rows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR item IN
      WITH old_counts AS (
        SELECT knowledge_base_id,
               focowiki.incremental_stat_shard(to_jsonb(old_rows)->>TG_ARGV[1])
                 AS counter_shard,
               count(*)::bigint AS count
        FROM old_rows WHERE deleted_at IS NULL
        GROUP BY knowledge_base_id, counter_shard
      ), new_counts AS (
        SELECT knowledge_base_id,
               focowiki.incremental_stat_shard(to_jsonb(new_rows)->>TG_ARGV[1])
                 AS counter_shard,
               count(*)::bigint AS count
        FROM new_rows WHERE deleted_at IS NULL
        GROUP BY knowledge_base_id, counter_shard
      )
      SELECT coalesce(new_counts.knowledge_base_id, old_counts.knowledge_base_id)
               AS knowledge_base_id,
             coalesce(new_counts.counter_shard, old_counts.counter_shard)
               AS counter_shard,
             coalesce(new_counts.count, 0) - coalesce(old_counts.count, 0) AS delta
      FROM old_counts
      FULL OUTER JOIN new_counts USING (knowledge_base_id, counter_shard)
      WHERE coalesce(new_counts.count, 0) <> coalesce(old_counts.count, 0)
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, TG_ARGV[0], item.delta
      );
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    FOR item IN
      SELECT knowledge_base_id,
             focowiki.incremental_stat_shard(to_jsonb(old_rows)->>TG_ARGV[1])
               AS counter_shard,
             -count(*)::bigint AS delta
      FROM old_rows WHERE deleted_at IS NULL
      GROUP BY knowledge_base_id, counter_shard
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, TG_ARGV[0], item.delta
      );
    END LOOP;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOR item IN
      SELECT knowledge_base_id,
             focowiki.incremental_stat_shard(to_jsonb(new_rows)->>TG_ARGV[1])
               AS counter_shard,
             count(*)::bigint AS delta
      FROM new_rows WHERE deleted_at IS NULL
      GROUP BY knowledge_base_id, counter_shard
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, TG_ARGV[0], item.delta
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.update_incremental_stat_accepted_edges()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR item IN
      WITH old_counts AS (
        SELECT knowledge_base_id,
               focowiki.incremental_stat_shard(to_jsonb(old_rows)->>TG_ARGV[0])
                 AS counter_shard,
               count(*)::bigint AS count
        FROM old_rows WHERE status = 'accepted'
        GROUP BY knowledge_base_id, counter_shard
      ), new_counts AS (
        SELECT knowledge_base_id,
               focowiki.incremental_stat_shard(to_jsonb(new_rows)->>TG_ARGV[0])
                 AS counter_shard,
               count(*)::bigint AS count
        FROM new_rows WHERE status = 'accepted'
        GROUP BY knowledge_base_id, counter_shard
      )
      SELECT coalesce(new_counts.knowledge_base_id, old_counts.knowledge_base_id)
               AS knowledge_base_id,
             coalesce(new_counts.counter_shard, old_counts.counter_shard)
               AS counter_shard,
             coalesce(new_counts.count, 0) - coalesce(old_counts.count, 0) AS delta
      FROM old_counts
      FULL OUTER JOIN new_counts USING (knowledge_base_id, counter_shard)
      WHERE coalesce(new_counts.count, 0) <> coalesce(old_counts.count, 0)
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, 'graph_edge_count', item.delta
      );
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    FOR item IN
      SELECT knowledge_base_id,
             focowiki.incremental_stat_shard(to_jsonb(old_rows)->>TG_ARGV[0])
               AS counter_shard,
             -count(*)::bigint AS delta
      FROM old_rows WHERE status = 'accepted'
      GROUP BY knowledge_base_id, counter_shard
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, 'graph_edge_count', item.delta
      );
    END LOOP;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOR item IN
      SELECT knowledge_base_id,
             focowiki.incremental_stat_shard(to_jsonb(new_rows)->>TG_ARGV[0])
               AS counter_shard,
             count(*)::bigint AS delta
      FROM new_rows WHERE status = 'accepted'
      GROUP BY knowledge_base_id, counter_shard
      ORDER BY knowledge_base_id, counter_shard
    LOOP
      PERFORM focowiki.apply_incremental_stat_delta(
        item.knowledge_base_id, item.counter_shard, 'graph_edge_count', item.delta
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS source_files_incremental_stats_insert ON focowiki.source_files;
DROP TRIGGER IF EXISTS source_files_incremental_stats_update ON focowiki.source_files;
DROP TRIGGER IF EXISTS source_files_incremental_stats_delete ON focowiki.source_files;
CREATE TRIGGER source_files_incremental_stats_insert
  AFTER INSERT ON focowiki.source_files
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_visible_rows('source_file_count', 'id');
CREATE TRIGGER source_files_incremental_stats_update
  AFTER UPDATE ON focowiki.source_files
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_visible_rows('source_file_count', 'id');
CREATE TRIGGER source_files_incremental_stats_delete
  AFTER DELETE ON focowiki.source_files
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_visible_rows('source_file_count', 'id');

DROP TRIGGER IF EXISTS source_directories_incremental_stats_insert ON focowiki.source_directories;
DROP TRIGGER IF EXISTS source_directories_incremental_stats_update ON focowiki.source_directories;
DROP TRIGGER IF EXISTS source_directories_incremental_stats_delete ON focowiki.source_directories;
CREATE TRIGGER source_directories_incremental_stats_insert
  AFTER INSERT ON focowiki.source_directories
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_visible_rows('source_directory_count', 'id');
CREATE TRIGGER source_directories_incremental_stats_update
  AFTER UPDATE ON focowiki.source_directories
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_visible_rows('source_directory_count', 'id');
CREATE TRIGGER source_directories_incremental_stats_delete
  AFTER DELETE ON focowiki.source_directories
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_visible_rows('source_directory_count', 'id');

DROP TRIGGER IF EXISTS graph_nodes_incremental_stats_insert ON focowiki.source_file_graph_nodes;
DROP TRIGGER IF EXISTS graph_nodes_incremental_stats_update ON focowiki.source_file_graph_nodes;
DROP TRIGGER IF EXISTS graph_nodes_incremental_stats_delete ON focowiki.source_file_graph_nodes;
CREATE TRIGGER graph_nodes_incremental_stats_insert
  AFTER INSERT ON focowiki.source_file_graph_nodes
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('graph_node_count', 'source_file_id');
CREATE TRIGGER graph_nodes_incremental_stats_update
  AFTER UPDATE ON focowiki.source_file_graph_nodes
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('graph_node_count', 'source_file_id');
CREATE TRIGGER graph_nodes_incremental_stats_delete
  AFTER DELETE ON focowiki.source_file_graph_nodes
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('graph_node_count', 'source_file_id');

DROP TRIGGER IF EXISTS graph_edges_incremental_stats_insert ON focowiki.source_file_graph_edges;
DROP TRIGGER IF EXISTS graph_edges_incremental_stats_update ON focowiki.source_file_graph_edges;
DROP TRIGGER IF EXISTS graph_edges_incremental_stats_delete ON focowiki.source_file_graph_edges;
CREATE TRIGGER graph_edges_incremental_stats_insert
  AFTER INSERT ON focowiki.source_file_graph_edges
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_accepted_edges('from_source_file_id');
CREATE TRIGGER graph_edges_incremental_stats_update
  AFTER UPDATE ON focowiki.source_file_graph_edges
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_accepted_edges('from_source_file_id');
CREATE TRIGGER graph_edges_incremental_stats_delete
  AFTER DELETE ON focowiki.source_file_graph_edges
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_accepted_edges('from_source_file_id');

DROP TRIGGER IF EXISTS active_projection_records_incremental_stats_insert ON focowiki.active_projection_records;
DROP TRIGGER IF EXISTS active_projection_records_incremental_stats_update ON focowiki.active_projection_records;
DROP TRIGGER IF EXISTS active_projection_records_incremental_stats_delete ON focowiki.active_projection_records;
CREATE TRIGGER active_projection_records_incremental_stats_insert
  AFTER INSERT ON focowiki.active_projection_records
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('active_projection_record_count', 'record_id');
CREATE TRIGGER active_projection_records_incremental_stats_update
  AFTER UPDATE ON focowiki.active_projection_records
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('active_projection_record_count', 'record_id');
CREATE TRIGGER active_projection_records_incremental_stats_delete
  AFTER DELETE ON focowiki.active_projection_records
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('active_projection_record_count', 'record_id');

DROP TRIGGER IF EXISTS active_object_refs_incremental_stats_insert ON focowiki.active_object_refs;
DROP TRIGGER IF EXISTS active_object_refs_incremental_stats_update ON focowiki.active_object_refs;
DROP TRIGGER IF EXISTS active_object_refs_incremental_stats_delete ON focowiki.active_object_refs;
CREATE TRIGGER active_object_refs_incremental_stats_insert
  AFTER INSERT ON focowiki.active_object_refs
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('active_generated_object_count', 'ref_key');
CREATE TRIGGER active_object_refs_incremental_stats_update
  AFTER UPDATE ON focowiki.active_object_refs
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('active_generated_object_count', 'ref_key');
CREATE TRIGGER active_object_refs_incremental_stats_delete
  AFTER DELETE ON focowiki.active_object_refs
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.update_incremental_stat_all_rows('active_generated_object_count', 'ref_key');

DROP FUNCTION IF EXISTS focowiki.apply_incremental_stat_delta(text, text, bigint);

CREATE TABLE IF NOT EXISTS focowiki.knowledge_base_optimization_migrations (
    knowledge_base_id text PRIMARY KEY,
    state text DEFAULT 'legacy_readable' NOT NULL,
    phase text DEFAULT 'source_terms' NOT NULL,
    high_water_source_file_id text,
    high_water_projection_record_id text,
    high_water_object_checksum text,
    high_water_object_identity text,
    prior_active_generation_id text,
    optimized_active_generation_id text,
    parity_evidence_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    last_error_code text,
    last_error_message text,
    started_at timestamp with time zone,
    verified_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_base_optimization_migrations_state_check CHECK (
      state = ANY (ARRAY[
        'legacy_readable', 'backfilling', 'verifying', 'optimized_active', 'failed'
      ])
    ),
    CONSTRAINT knowledge_base_optimization_migrations_parity_check
      CHECK (jsonb_typeof(parity_evidence_json) = 'object'),
    CONSTRAINT knowledge_base_optimization_migrations_phase_check CHECK (
      phase = ANY (ARRAY[
        'source_terms', 'projection_segments', 'object_validation', 'verifying'
      ])
    ),
    CONSTRAINT knowledge_base_optimization_migrations_attempts_check CHECK (
      attempt_count >= 0 AND max_attempts >= 1
    ),
    CONSTRAINT knowledge_base_optimization_migrations_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT knowledge_base_optimization_migrations_prior_generation_fkey
      FOREIGN KEY (prior_active_generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE SET NULL,
    CONSTRAINT knowledge_base_optimization_migrations_optimized_generation_fkey
      FOREIGN KEY (optimized_active_generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE SET NULL
);

ALTER TABLE focowiki.knowledge_base_optimization_migrations
  ADD COLUMN IF NOT EXISTS phase text DEFAULT 'source_terms' NOT NULL,
  ADD COLUMN IF NOT EXISTS high_water_object_identity text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS attempt_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS max_attempts integer DEFAULT 5 NOT NULL;

ALTER TABLE focowiki.knowledge_base_optimization_migrations
  DROP CONSTRAINT IF EXISTS knowledge_base_optimization_migrations_phase_check;
ALTER TABLE focowiki.knowledge_base_optimization_migrations
  ADD CONSTRAINT knowledge_base_optimization_migrations_phase_check CHECK (
    phase = ANY (ARRAY[
      'source_terms', 'projection_segments', 'object_validation', 'verifying'
    ])
  );
ALTER TABLE focowiki.knowledge_base_optimization_migrations
  DROP CONSTRAINT IF EXISTS knowledge_base_optimization_migrations_attempts_check;
ALTER TABLE focowiki.knowledge_base_optimization_migrations
  ADD CONSTRAINT knowledge_base_optimization_migrations_attempts_check CHECK (
    attempt_count >= 0 AND max_attempts >= 1
  );

DROP INDEX IF EXISTS focowiki.knowledge_base_optimization_migrations_claim_idx;
CREATE INDEX knowledge_base_optimization_migrations_claim_idx
  ON focowiki.knowledge_base_optimization_migrations (
    state, lease_expires_at, updated_at, knowledge_base_id
  )
  WHERE state = ANY (ARRAY['legacy_readable', 'backfilling', 'verifying', 'failed']);

INSERT INTO focowiki.knowledge_base_optimization_migrations (
  knowledge_base_id, prior_active_generation_id
)
SELECT id, active_generation_id
FROM focowiki.knowledge_bases
WHERE deleted_at IS NULL
ON CONFLICT (knowledge_base_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS focowiki.projection_segments (
    id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    logical_partition text NOT NULL,
    segment_kind text NOT NULL,
    sequence_number integer NOT NULL,
    format_version integer DEFAULT 2 NOT NULL,
    checksum_sha256 text NOT NULL,
    object_key text NOT NULL,
    logical_path text NOT NULL,
    entry_count integer NOT NULL,
    encoded_bytes bigint NOT NULL,
    first_record_identity text,
    last_record_identity text,
    base_segment_id text,
    lifecycle_state text DEFAULT 'active' NOT NULL,
    ownership_count bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    compacted_at timestamp with time zone,
    CONSTRAINT projection_segments_kind_check CHECK (
      segment_kind = ANY (ARRAY['base', 'delta', 'tombstone', 'compacted'])
    ),
    CONSTRAINT projection_segments_lifecycle_check CHECK (
      lifecycle_state = ANY (ARRAY['writing', 'active', 'retained', 'quarantined', 'deleted'])
    ),
    CONSTRAINT projection_segments_counts_check CHECK (
      sequence_number >= 0 AND format_version >= 1 AND entry_count >= 0
      AND encoded_bytes >= 0 AND ownership_count >= 0
    ),
    CONSTRAINT projection_segments_identity_key UNIQUE (
      knowledge_base_id, projection_kind, logical_partition,
      segment_kind, sequence_number, checksum_sha256
    ),
    CONSTRAINT projection_segments_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT projection_segments_base_segment_id_fkey
      FOREIGN KEY (base_segment_id) REFERENCES focowiki.projection_segments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS projection_segments_partition_idx
  ON focowiki.projection_segments
  (knowledge_base_id, projection_kind, logical_partition, lifecycle_state, sequence_number);
CREATE INDEX IF NOT EXISTS projection_segments_object_idx
  ON focowiki.projection_segments (checksum_sha256, format_version);
CREATE INDEX IF NOT EXISTS projection_segments_compaction_idx
  ON focowiki.projection_segments
  (lifecycle_state, knowledge_base_id, projection_kind, logical_partition)
  WHERE lifecycle_state IN ('active', 'retained');

ALTER TABLE focowiki.projection_segments
  ADD COLUMN IF NOT EXISTS logical_path text;
UPDATE focowiki.projection_segments
SET logical_path = '_segments/legacy/' || id || '.json'
WHERE logical_path IS NULL;
ALTER TABLE focowiki.projection_segments
  ALTER COLUMN logical_path SET NOT NULL;

CREATE TABLE IF NOT EXISTS focowiki.generation_projection_segments (
    generation_id text NOT NULL,
    segment_id text NOT NULL,
    ordinal integer NOT NULL,
    effective boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_projection_segments_pkey PRIMARY KEY (generation_id, segment_id),
    CONSTRAINT generation_projection_segments_ordinal_key UNIQUE (generation_id, ordinal),
    CONSTRAINT generation_projection_segments_ordinal_check CHECK (ordinal >= 0),
    CONSTRAINT generation_projection_segments_generation_id_fkey
      FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT generation_projection_segments_segment_id_fkey
      FOREIGN KEY (segment_id) REFERENCES focowiki.projection_segments(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS generation_projection_segments_effective_idx
  ON focowiki.generation_projection_segments (generation_id, effective, ordinal);

CREATE INDEX IF NOT EXISTS active_generation_read_format_idx
  ON focowiki.publication_generations (knowledge_base_id, id, format_version)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS active_projection_records_tree_page_idx
  ON focowiki.active_projection_records (
    knowledge_base_id,
    (coalesce(parent_path, '')),
    (coalesce(sort_key, '')),
    record_id
  )
  WHERE projection_kind = 'tree';

CREATE INDEX IF NOT EXISTS active_projection_records_search_source_idx
  ON focowiki.active_projection_records (
    knowledge_base_id,
    source_file_id,
    record_id
  )
  WHERE projection_kind = 'search' AND source_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS active_projection_records_graph_edge_source_weight_idx
  ON focowiki.active_projection_records (
    knowledge_base_id,
    source_file_id,
    (coalesce((payload_json->>'weight')::double precision, 0)) DESC,
    record_id
  )
  WHERE projection_kind = 'graph_edge';

CREATE INDEX IF NOT EXISTS active_projection_records_graph_edge_related_weight_idx
  ON focowiki.active_projection_records (
    knowledge_base_id,
    related_source_file_id,
    (coalesce((payload_json->>'weight')::double precision, 0)) DESC,
    record_id
  )
  WHERE projection_kind = 'graph_edge';

ALTER TABLE focowiki.generation_projection_segments
  DROP CONSTRAINT IF EXISTS generation_projection_segments_ordinal_key;

CREATE OR REPLACE FUNCTION focowiki.adjust_projection_segment_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE focowiki.projection_segments
    SET ownership_count = ownership_count + 1
    WHERE id = NEW.segment_id;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE focowiki.projection_segments
    SET ownership_count = greatest(ownership_count - 1, 0)
    WHERE id = OLD.segment_id;
    RETURN OLD;
  END IF;
  IF OLD.segment_id IS DISTINCT FROM NEW.segment_id THEN
    UPDATE focowiki.projection_segments
    SET ownership_count = greatest(ownership_count - 1, 0)
    WHERE id = OLD.segment_id;
    UPDATE focowiki.projection_segments
    SET ownership_count = ownership_count + 1
    WHERE id = NEW.segment_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generation_projection_segments_ownership_trigger
  ON focowiki.generation_projection_segments;
CREATE TRIGGER generation_projection_segments_ownership_trigger
AFTER INSERT OR DELETE OR UPDATE ON focowiki.generation_projection_segments
FOR EACH ROW EXECUTE FUNCTION focowiki.adjust_projection_segment_ownership();

UPDATE focowiki.projection_segments segment
SET ownership_count = ownership.count
FROM (
  SELECT segment_id, count(*)::bigint AS count
  FROM focowiki.generation_projection_segments
  GROUP BY segment_id
) ownership
WHERE ownership.segment_id = segment.id;

UPDATE focowiki.projection_segments segment
SET ownership_count = 0
WHERE ownership_count <> 0
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.generation_projection_segments ownership
    WHERE ownership.segment_id = segment.id
  );

CREATE TABLE IF NOT EXISTS focowiki.active_projection_segments (
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    logical_partition text NOT NULL,
    segment_id text NOT NULL,
    ordinal integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT active_projection_segments_pkey PRIMARY KEY (
      knowledge_base_id, projection_kind, logical_partition, segment_id
    ),
    CONSTRAINT active_projection_segments_ordinal_check CHECK (ordinal >= 0),
    CONSTRAINT active_projection_segments_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT active_projection_segments_segment_id_fkey
      FOREIGN KEY (segment_id) REFERENCES focowiki.projection_segments(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS active_projection_segments_partition_idx
  ON focowiki.active_projection_segments
  (knowledge_base_id, projection_kind, logical_partition, ordinal);

ALTER TABLE focowiki.projection_segments
  ADD COLUMN IF NOT EXISTS last_storage_seen_cycle_id text,
  ADD COLUMN IF NOT EXISTS last_storage_seen_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS integrity_error_code text,
  ADD COLUMN IF NOT EXISTS integrity_checked_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS projection_segments_storage_verification_idx
  ON focowiki.projection_segments (
    object_key, lifecycle_state, last_storage_seen_cycle_id,
    checksum_sha256, format_version
  );

CREATE OR REPLACE VIEW focowiki.storage_object_protection AS
SELECT source.knowledge_base_id,
       source.checksum_sha256,
       1 AS format_version,
       source.object_key,
       'source'::text AS object_kind,
       'active_referenced'::text AS protection_class
FROM focowiki.source_files source
WHERE source.deleted_at IS NULL
UNION ALL
SELECT NULL::text AS knowledge_base_id,
       object.checksum_sha256,
       object.format_version,
       object.object_key,
       'unknown'::text AS object_kind,
       'registered'::text AS protection_class
FROM focowiki.immutable_objects object
WHERE object.lifecycle_state IN ('writing', 'active', 'deleting')
UNION ALL
SELECT reference.knowledge_base_id,
       reference.checksum_sha256,
       reference.format_version,
       object.object_key,
       CASE
         WHEN reference.ref_kind = 'page' THEN 'page'
         WHEN reference.ref_kind IN ('generation_manifest', 'projection_manifest') THEN 'manifest'
         ELSE 'root'
       END AS object_kind,
       'active_referenced'::text AS protection_class
FROM focowiki.active_object_refs reference
JOIN focowiki.immutable_objects object
  ON object.checksum_sha256 = reference.checksum_sha256
 AND object.format_version = reference.format_version
UNION ALL
SELECT reference.knowledge_base_id,
       reference.checksum_sha256,
       reference.format_version,
       object.object_key,
       CASE
         WHEN reference.ref_kind = 'page' THEN 'page'
         WHEN reference.ref_kind IN ('generation_manifest', 'projection_manifest') THEN 'manifest'
         ELSE 'root'
       END AS object_kind,
       CASE
         WHEN reference.ref_kind = 'projection_shard' OR generation.format_version < 2
           THEN 'legacy_retained'
         WHEN generation.state = 'active' THEN 'active_referenced'
         ELSE 'retained_referenced'
       END AS protection_class
FROM focowiki.generation_object_refs reference
JOIN focowiki.publication_generations generation ON generation.id = reference.generation_id
JOIN focowiki.immutable_objects object
  ON object.checksum_sha256 = reference.checksum_sha256
 AND object.format_version = reference.format_version
WHERE reference.action = 'upsert'
UNION ALL
SELECT generation.knowledge_base_id,
       generation.root_manifest_checksum_sha256,
       generation.format_version,
       object.object_key,
       'manifest'::text AS object_kind,
       CASE
         WHEN generation.state = 'active' THEN 'active_referenced'
         ELSE 'retained_referenced'
       END AS protection_class
FROM focowiki.publication_generations generation
JOIN focowiki.immutable_objects object
  ON object.checksum_sha256 = generation.root_manifest_checksum_sha256
 AND object.format_version = generation.format_version
WHERE generation.root_manifest_checksum_sha256 IS NOT NULL
UNION ALL
SELECT segment.knowledge_base_id,
       segment.checksum_sha256,
       segment.format_version,
       segment.object_key,
       segment.segment_kind AS object_kind,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM focowiki.active_projection_segments active
           WHERE active.segment_id = segment.id
         ) THEN 'active_referenced'
         WHEN segment.ownership_count > 0 OR EXISTS (
           SELECT 1 FROM focowiki.generation_projection_segments retained
           WHERE retained.segment_id = segment.id
         ) OR segment.lifecycle_state = 'retained' THEN 'retained_referenced'
         WHEN segment.lifecycle_state IN ('writing', 'active') THEN 'registered'
         ELSE 'unreferenced'
       END AS protection_class
FROM focowiki.projection_segments segment;

CREATE TABLE IF NOT EXISTS focowiki.generation_projection_partition_stats (
    generation_id text NOT NULL,
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    logical_partition text NOT NULL,
    record_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generation_projection_partition_stats_pkey PRIMARY KEY (
      generation_id, projection_kind, logical_partition
    ),
    CONSTRAINT generation_projection_partition_stats_count_check CHECK (record_count >= 0),
    CONSTRAINT generation_projection_partition_stats_generation_id_fkey
      FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE,
    CONSTRAINT generation_projection_partition_stats_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS generation_projection_partition_stats_generation_idx
  ON focowiki.generation_projection_partition_stats
  (knowledge_base_id, generation_id, projection_kind, logical_partition);

ALTER TABLE focowiki.publication_impacts
  ADD COLUMN IF NOT EXISTS physical_partition text GENERATED ALWAYS AS (
    CASE
      WHEN projection_kind = 'graph_reverse_neighbor'
        THEN 'related_files' || chr(31) || record_identity
      WHEN projection_kind = 'related_files'
        THEN 'related_files' || chr(31) || projection_key
      ELSE projection_kind || chr(31) || projection_key
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS publication_impacts_partition_claim_idx
  ON focowiki.publication_impacts (
    generation_id, physical_partition, status, run_after, created_at, id
  );

CREATE TABLE IF NOT EXISTS focowiki.active_projection_partition_stats (
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    logical_partition text NOT NULL,
    record_count bigint DEFAULT 0 NOT NULL,
    last_changed_generation_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT active_projection_partition_stats_pkey PRIMARY KEY (
      knowledge_base_id, projection_kind, logical_partition
    ),
    CONSTRAINT active_projection_partition_stats_count_check CHECK (record_count >= 0),
    CONSTRAINT active_projection_partition_stats_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT active_projection_partition_stats_generation_id_fkey
      FOREIGN KEY (last_changed_generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE
);

ALTER TABLE focowiki.active_projection_partition_stats
  DROP CONSTRAINT IF EXISTS active_projection_partition_stats_generation_id_fkey;
ALTER TABLE focowiki.active_projection_partition_stats
  ADD CONSTRAINT active_projection_partition_stats_generation_id_fkey
  FOREIGN KEY (last_changed_generation_id)
  REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS focowiki.publication_subtasks (
    id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    generation_id text NOT NULL,
    task_kind text NOT NULL,
    projection_kind text,
    physical_partition text NOT NULL,
    settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    processed_count bigint DEFAULT 0 NOT NULL,
    total_count bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    last_error_message text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_subtasks_identity_key UNIQUE (
      generation_id, task_kind, projection_kind, physical_partition
    ),
    CONSTRAINT publication_subtasks_kind_check CHECK (
      task_kind = ANY (ARRAY[
        'coordinator', 'projection_partition', 'directory', 'object',
        'validation', 'activation'
      ])
    ),
    CONSTRAINT publication_subtasks_state_check CHECK (
      state = ANY (ARRAY['pending', 'running', 'retry', 'completed', 'failed', 'cancelled'])
    ),
    CONSTRAINT publication_subtasks_counts_check CHECK (
      attempt_count >= 0 AND max_attempts >= 1
      AND processed_count >= 0 AND total_count >= 0
      AND processed_count <= total_count
    ),
    CONSTRAINT publication_subtasks_settings_check CHECK (
      jsonb_typeof(settings_snapshot_json) = 'object'
    ),
    CONSTRAINT publication_subtasks_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT publication_subtasks_generation_id_fkey
      FOREIGN KEY (generation_id) REFERENCES focowiki.publication_generations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS publication_subtasks_claim_idx
  ON focowiki.publication_subtasks
  (state, run_after, task_kind, knowledge_base_id, generation_id, physical_partition)
  WHERE state IN ('pending', 'retry', 'running');
CREATE INDEX IF NOT EXISTS publication_subtasks_generation_idx
  ON focowiki.publication_subtasks (knowledge_base_id, generation_id, state, task_kind);
CREATE UNIQUE INDEX IF NOT EXISTS publication_subtasks_partition_owner_idx
  ON focowiki.publication_subtasks
  (knowledge_base_id, generation_id, projection_kind, physical_partition)
  WHERE task_kind = 'projection_partition' AND state = 'running';

ALTER TABLE focowiki.publication_subtasks
  ADD COLUMN IF NOT EXISTS settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE focowiki.publication_subtasks
  DROP CONSTRAINT IF EXISTS publication_subtasks_settings_check;
ALTER TABLE focowiki.publication_subtasks
  ADD CONSTRAINT publication_subtasks_settings_check CHECK (
    jsonb_typeof(settings_snapshot_json) = 'object'
  );

CREATE TABLE IF NOT EXISTS focowiki.runtime_pressure_counters (
    counter_key text PRIMARY KEY,
    counter_value bigint DEFAULT 0 NOT NULL,
    reconciled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_pressure_counters_value_check CHECK (counter_value >= 0)
);

CREATE TABLE IF NOT EXISTS focowiki.runtime_pressure_counter_shards (
    counter_key text NOT NULL,
    counter_shard smallint NOT NULL,
    counter_value bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_pressure_counter_shards_pkey
      PRIMARY KEY (counter_key, counter_shard),
    CONSTRAINT runtime_pressure_counter_shards_key_check CHECK (
      counter_key = ANY (ARRAY[
        'source_queue_depth', 'dirty_file_count',
        'pending_impact_count', 'pending_marker_count'
      ])
    ),
    CONSTRAINT runtime_pressure_counter_shards_shard_check CHECK (
      counter_shard >= 0 AND counter_shard < 32
    )
);

CREATE OR REPLACE FUNCTION focowiki.runtime_pressure_shard(
  target_resource_id text
) RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (hashtextextended(target_resource_id, 0) & 31)::smallint
$$;

ALTER TABLE focowiki.role_jobs
  ADD COLUMN IF NOT EXISTS early_claim_on_upstream_drain boolean DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS role_jobs_kb_upstream_active_idx
  ON focowiki.role_jobs (knowledge_base_id, role, kind, status, id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS upload_sessions_kb_active_idx
  ON focowiki.upload_sessions (knowledge_base_id, state, id)
  WHERE state IN ('draft', 'manifest_building', 'manifest_sealed', 'uploading', 'finalizing');

ALTER TABLE focowiki.publication_change_facts
  ADD COLUMN IF NOT EXISTS assembly_state text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS assembly_claimed_by text,
  ADD COLUMN IF NOT EXISTS assembly_claimed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS assembled_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS planning_payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS settings_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS publication_max_attempts integer DEFAULT 3 NOT NULL;

UPDATE focowiki.publication_change_facts
SET assembly_state = 'assembled',
    assembled_at = coalesce(assembled_at, created_at)
WHERE generation_id IS NOT NULL
  AND assembly_state <> 'assembled';

ALTER TABLE focowiki.publication_change_facts
  DROP CONSTRAINT IF EXISTS publication_change_facts_assembly_state_check;
ALTER TABLE focowiki.publication_change_facts
  ADD CONSTRAINT publication_change_facts_assembly_state_check CHECK (
    assembly_state = ANY (ARRAY['pending', 'claimed', 'assembled', 'cancelled'])
  );

CREATE INDEX IF NOT EXISTS publication_change_facts_assembly_claim_idx
  ON focowiki.publication_change_facts
  (assembly_state, created_at, knowledge_base_id, id)
  WHERE assembly_state IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS publication_change_facts_kb_unassembled_idx
  ON focowiki.publication_change_facts (knowledge_base_id, assembly_state, id)
  WHERE assembly_state IN ('pending', 'claimed');

CREATE TEMP TABLE focowiki_migration_v8_recoverable_generations
ON COMMIT DROP
AS
SELECT DISTINCT generation.id AS generation_id,
       generation.knowledge_base_id
FROM focowiki.publication_generations generation
LEFT JOIN focowiki.publication_progress progress
  ON progress.knowledge_base_id = generation.knowledge_base_id
 AND progress.generation_id = generation.id
LEFT JOIN focowiki.role_jobs job
  ON job.knowledge_base_id = generation.knowledge_base_id
 AND job.generation_id = generation.id
 AND job.role = 'publication'
 AND job.kind = 'generation_publication'
WHERE generation.generation_kind = 'normal'
  AND generation.state IN ('building', 'validating', 'failed')
  AND (
    generation.safe_error_message IN (
      'Immutable object upload metadata verification failed',
      'Projection shard exceeds the configured byte budget',
      'Projection write will be retried'
    )
    OR progress.safe_error_message IN (
      'Immutable object upload metadata verification failed',
      'Projection shard exceeds the configured byte budget',
      'Projection write will be retried'
    )
    OR job.last_error_message IN (
      'Immutable object upload metadata verification failed',
      'Projection shard exceeds the configured byte budget',
      'Projection write will be retried'
    )
  );

DELETE FROM focowiki.generation_object_refs reference
USING focowiki_migration_v8_recoverable_generations migrated
WHERE reference.knowledge_base_id = migrated.knowledge_base_id
  AND reference.generation_id = migrated.generation_id;

DELETE FROM focowiki.immutable_objects object
WHERE object.lifecycle_state = 'writing'
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.generation_object_refs reference
    WHERE reference.checksum_sha256 = object.checksum_sha256
      AND reference.format_version = object.format_version
  )
  AND NOT EXISTS (
    SELECT 1
    FROM focowiki.active_object_refs reference
    WHERE reference.checksum_sha256 = object.checksum_sha256
      AND reference.format_version = object.format_version
  );

UPDATE focowiki.publication_impacts impact
SET status = 'pending',
    run_after = now(),
    attempt_count = 0,
    claimed_by = NULL,
    claimed_at = NULL,
    heartbeat_at = NULL,
    completed_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
FROM focowiki_migration_v8_recoverable_generations migrated
WHERE impact.knowledge_base_id = migrated.knowledge_base_id
  AND impact.generation_id = migrated.generation_id;

UPDATE focowiki.publication_progress progress
SET stage = 'pending',
    processed_impact_count = counts.completed_count,
    heartbeat_at = now(),
    completed_at = NULL,
    safe_error_code = NULL,
    safe_error_message = NULL,
    updated_at = now()
FROM (
  SELECT migrated.knowledge_base_id,
         migrated.generation_id,
         0::bigint AS completed_count
  FROM focowiki_migration_v8_recoverable_generations migrated
  LEFT JOIN focowiki.publication_impacts impact
    ON impact.knowledge_base_id = migrated.knowledge_base_id
   AND impact.generation_id = migrated.generation_id
  GROUP BY migrated.knowledge_base_id, migrated.generation_id
) counts
WHERE progress.knowledge_base_id = counts.knowledge_base_id
  AND progress.generation_id = counts.generation_id;

UPDATE focowiki.role_jobs job
SET status = 'queued',
    run_after = now(),
    attempt_count = 0,
    locked_by = NULL,
    locked_at = NULL,
    heartbeat_at = NULL,
    completed_at = NULL,
    failed_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
FROM focowiki_migration_v8_recoverable_generations migrated
WHERE job.knowledge_base_id = migrated.knowledge_base_id
  AND job.generation_id = migrated.generation_id
  AND job.role = 'publication'
  AND job.kind = 'generation_publication'
  AND job.status <> 'completed';

UPDATE focowiki.source_files source
SET processing_status = 'completed',
    processing_stage = 'projection_generation',
    processing_ended_at = now(),
    generated_output_status = 'pending',
    terminal_failure_stage = NULL,
    terminal_failure_code = NULL,
    terminal_failure_message = NULL,
    terminal_failure_at = NULL,
    terminal_failure_retry_kind = NULL,
    terminal_failure_correlation_id = NULL
FROM focowiki_migration_v8_recoverable_generations migrated
WHERE source.knowledge_base_id = migrated.knowledge_base_id
  AND source.deleted_at IS NULL
  AND source.task_deleted_at IS NULL
  AND source.deletion_intent_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM focowiki.publication_change_facts fact
    WHERE fact.knowledge_base_id = migrated.knowledge_base_id
      AND fact.generation_id = migrated.generation_id
      AND fact.source_file_id = source.id
  );

CREATE INDEX IF NOT EXISTS role_jobs_source_pressure_age_idx
  ON focowiki.role_jobs (created_at, id)
  WHERE role = 'source' AND status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS publication_change_facts_pressure_age_idx
  ON focowiki.publication_change_facts (created_at, id)
  WHERE assembly_state IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS publication_impacts_pressure_active_idx
  ON focowiki.publication_impacts (created_at, id)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS source_dispatch_markers_pressure_active_idx
  ON focowiki.source_dispatch_markers (created_at, id)
  WHERE status = 'pending';

DROP FUNCTION IF EXISTS focowiki.apply_runtime_pressure_delta(text, bigint);

CREATE OR REPLACE FUNCTION focowiki.apply_runtime_pressure_delta(
  target_counter_key text,
  target_counter_shard smallint,
  target_delta bigint
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF target_delta = 0 THEN
    RETURN;
  END IF;
  IF target_counter_key NOT IN (
    'source_queue_depth', 'dirty_file_count',
    'pending_impact_count', 'pending_marker_count'
  ) THEN
    RAISE EXCEPTION 'Unsupported runtime pressure counter';
  END IF;
  IF target_counter_shard < 0 OR target_counter_shard >= 32 THEN
    RAISE EXCEPTION 'Unsupported runtime pressure shard';
  END IF;
  INSERT INTO focowiki.runtime_pressure_counter_shards (
    counter_key, counter_shard, counter_value, updated_at
  ) VALUES (
    target_counter_key, target_counter_shard, target_delta, now()
  )
  ON CONFLICT (counter_key, counter_shard) DO UPDATE
  SET counter_value = focowiki.runtime_pressure_counter_shards.counter_value
        + EXCLUDED.counter_value,
      updated_at = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.increment_runtime_pressure_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_counter_key text;
  target_counter record;
BEGIN
  IF TG_TABLE_NAME = 'role_jobs' THEN
    target_counter_key := 'source_queue_depth';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             count(*)::bigint AS delta
      FROM new_rows
      WHERE role = 'source' AND status IN ('queued', 'running')
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'publication_change_facts' THEN
    target_counter_key := 'dirty_file_count';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             count(*)::bigint AS delta
      FROM new_rows
      WHERE assembly_state IN ('pending', 'claimed')
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'publication_impacts' THEN
    target_counter_key := 'pending_impact_count';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             count(*)::bigint AS delta
      FROM new_rows
      WHERE status IN ('pending', 'running')
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'source_dispatch_markers' THEN
    target_counter_key := 'pending_marker_count';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             count(*)::bigint AS delta
      FROM new_rows WHERE status = 'pending'
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSE
    RAISE EXCEPTION 'Unsupported runtime pressure source table';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.decrement_runtime_pressure_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_counter_key text;
  target_counter record;
BEGIN
  IF TG_TABLE_NAME = 'role_jobs' THEN
    target_counter_key := 'source_queue_depth';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             -count(*)::bigint AS delta
      FROM old_rows
      WHERE role = 'source' AND status IN ('queued', 'running')
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'publication_change_facts' THEN
    target_counter_key := 'dirty_file_count';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             -count(*)::bigint AS delta
      FROM old_rows
      WHERE assembly_state IN ('pending', 'claimed')
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'publication_impacts' THEN
    target_counter_key := 'pending_impact_count';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             -count(*)::bigint AS delta
      FROM old_rows
      WHERE status IN ('pending', 'running')
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'source_dispatch_markers' THEN
    target_counter_key := 'pending_marker_count';
    FOR target_counter IN
      SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
             -count(*)::bigint AS delta
      FROM old_rows WHERE status = 'pending'
      GROUP BY counter_shard ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSE
    RAISE EXCEPTION 'Unsupported runtime pressure source table';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.replace_runtime_pressure_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_counter_key text;
  target_counter record;
BEGIN
  IF TG_TABLE_NAME = 'role_jobs' THEN
    target_counter_key := 'source_queue_depth';
    FOR target_counter IN
      WITH old_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM old_rows
        WHERE role = 'source' AND status IN ('queued', 'running')
        GROUP BY counter_shard
      ), new_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM new_rows
        WHERE role = 'source' AND status IN ('queued', 'running')
        GROUP BY counter_shard
      )
      SELECT coalesce(new_counts.counter_shard, old_counts.counter_shard) AS counter_shard,
             coalesce(new_counts.value, 0) - coalesce(old_counts.value, 0) AS delta
      FROM old_counts FULL OUTER JOIN new_counts USING (counter_shard)
      WHERE coalesce(new_counts.value, 0) <> coalesce(old_counts.value, 0)
      ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'publication_change_facts' THEN
    target_counter_key := 'dirty_file_count';
    FOR target_counter IN
      WITH old_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM old_rows WHERE assembly_state IN ('pending', 'claimed')
        GROUP BY counter_shard
      ), new_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM new_rows WHERE assembly_state IN ('pending', 'claimed')
        GROUP BY counter_shard
      )
      SELECT coalesce(new_counts.counter_shard, old_counts.counter_shard) AS counter_shard,
             coalesce(new_counts.value, 0) - coalesce(old_counts.value, 0) AS delta
      FROM old_counts FULL OUTER JOIN new_counts USING (counter_shard)
      WHERE coalesce(new_counts.value, 0) <> coalesce(old_counts.value, 0)
      ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'publication_impacts' THEN
    target_counter_key := 'pending_impact_count';
    FOR target_counter IN
      WITH old_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM old_rows WHERE status IN ('pending', 'running')
        GROUP BY counter_shard
      ), new_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM new_rows WHERE status IN ('pending', 'running')
        GROUP BY counter_shard
      )
      SELECT coalesce(new_counts.counter_shard, old_counts.counter_shard) AS counter_shard,
             coalesce(new_counts.value, 0) - coalesce(old_counts.value, 0) AS delta
      FROM old_counts FULL OUTER JOIN new_counts USING (counter_shard)
      WHERE coalesce(new_counts.value, 0) <> coalesce(old_counts.value, 0)
      ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'source_dispatch_markers' THEN
    target_counter_key := 'pending_marker_count';
    FOR target_counter IN
      WITH old_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM old_rows WHERE status = 'pending'
        GROUP BY counter_shard
      ), new_counts AS (
        SELECT focowiki.runtime_pressure_shard(id) AS counter_shard,
               count(*)::bigint AS value
        FROM new_rows WHERE status = 'pending'
        GROUP BY counter_shard
      )
      SELECT coalesce(new_counts.counter_shard, old_counts.counter_shard) AS counter_shard,
             coalesce(new_counts.value, 0) - coalesce(old_counts.value, 0) AS delta
      FROM old_counts FULL OUTER JOIN new_counts USING (counter_shard)
      WHERE coalesce(new_counts.value, 0) <> coalesce(old_counts.value, 0)
      ORDER BY counter_shard
    LOOP
      PERFORM focowiki.apply_runtime_pressure_delta(
        target_counter_key, target_counter.counter_shard, target_counter.delta
      );
    END LOOP;
  ELSE
    RAISE EXCEPTION 'Unsupported runtime pressure source table';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS role_jobs_pressure_insert ON focowiki.role_jobs;
DROP TRIGGER IF EXISTS role_jobs_pressure_update ON focowiki.role_jobs;
DROP TRIGGER IF EXISTS role_jobs_pressure_delete ON focowiki.role_jobs;
CREATE TRIGGER role_jobs_pressure_insert
  AFTER INSERT ON focowiki.role_jobs
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.increment_runtime_pressure_counter();
CREATE TRIGGER role_jobs_pressure_update
  AFTER UPDATE ON focowiki.role_jobs
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.replace_runtime_pressure_counter();
CREATE TRIGGER role_jobs_pressure_delete
  AFTER DELETE ON focowiki.role_jobs
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.decrement_runtime_pressure_counter();

DROP TRIGGER IF EXISTS publication_change_facts_pressure_insert
  ON focowiki.publication_change_facts;
DROP TRIGGER IF EXISTS publication_change_facts_pressure_update
  ON focowiki.publication_change_facts;
DROP TRIGGER IF EXISTS publication_change_facts_pressure_delete
  ON focowiki.publication_change_facts;
CREATE TRIGGER publication_change_facts_pressure_insert
  AFTER INSERT ON focowiki.publication_change_facts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.increment_runtime_pressure_counter();
CREATE TRIGGER publication_change_facts_pressure_update
  AFTER UPDATE ON focowiki.publication_change_facts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.replace_runtime_pressure_counter();
CREATE TRIGGER publication_change_facts_pressure_delete
  AFTER DELETE ON focowiki.publication_change_facts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.decrement_runtime_pressure_counter();

DROP TRIGGER IF EXISTS publication_impacts_pressure_insert
  ON focowiki.publication_impacts;
DROP TRIGGER IF EXISTS publication_impacts_pressure_update
  ON focowiki.publication_impacts;
DROP TRIGGER IF EXISTS publication_impacts_pressure_delete
  ON focowiki.publication_impacts;
CREATE TRIGGER publication_impacts_pressure_insert
  AFTER INSERT ON focowiki.publication_impacts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.increment_runtime_pressure_counter();
CREATE TRIGGER publication_impacts_pressure_update
  AFTER UPDATE ON focowiki.publication_impacts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.replace_runtime_pressure_counter();
CREATE TRIGGER publication_impacts_pressure_delete
  AFTER DELETE ON focowiki.publication_impacts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.decrement_runtime_pressure_counter();

DROP TRIGGER IF EXISTS source_dispatch_markers_pressure_insert
  ON focowiki.source_dispatch_markers;
DROP TRIGGER IF EXISTS source_dispatch_markers_pressure_update
  ON focowiki.source_dispatch_markers;
DROP TRIGGER IF EXISTS source_dispatch_markers_pressure_delete
  ON focowiki.source_dispatch_markers;
CREATE TRIGGER source_dispatch_markers_pressure_insert
  AFTER INSERT ON focowiki.source_dispatch_markers
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.increment_runtime_pressure_counter();
CREATE TRIGGER source_dispatch_markers_pressure_update
  AFTER UPDATE ON focowiki.source_dispatch_markers
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.replace_runtime_pressure_counter();
CREATE TRIGGER source_dispatch_markers_pressure_delete
  AFTER DELETE ON focowiki.source_dispatch_markers
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.decrement_runtime_pressure_counter();

DELETE FROM focowiki.runtime_pressure_counter_shards
WHERE counter_key = ANY (ARRAY[
  'source_queue_depth', 'dirty_file_count',
  'pending_impact_count', 'pending_marker_count'
]);

INSERT INTO focowiki.runtime_pressure_counter_shards (
  counter_key, counter_shard, counter_value, updated_at
) VALUES
  ('source_queue_depth', 0, 0, now()),
  ('dirty_file_count', 0, 0, now()),
  ('pending_impact_count', 0, 0, now()),
  ('pending_marker_count', 0, 0, now());

INSERT INTO focowiki.runtime_pressure_counter_shards (
  counter_key, counter_shard, counter_value, updated_at
)
SELECT 'source_queue_depth', focowiki.runtime_pressure_shard(id), count(*)::bigint, now()
FROM focowiki.role_jobs
WHERE role = 'source' AND status IN ('queued', 'running')
GROUP BY focowiki.runtime_pressure_shard(id)
ON CONFLICT (counter_key, counter_shard) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    updated_at = EXCLUDED.updated_at;

INSERT INTO focowiki.runtime_pressure_counter_shards (
  counter_key, counter_shard, counter_value, updated_at
)
SELECT 'dirty_file_count', focowiki.runtime_pressure_shard(id), count(*)::bigint, now()
FROM focowiki.publication_change_facts
WHERE assembly_state IN ('pending', 'claimed')
GROUP BY focowiki.runtime_pressure_shard(id)
ON CONFLICT (counter_key, counter_shard) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    updated_at = EXCLUDED.updated_at;

INSERT INTO focowiki.runtime_pressure_counter_shards (
  counter_key, counter_shard, counter_value, updated_at
)
SELECT 'pending_impact_count', focowiki.runtime_pressure_shard(id), count(*)::bigint, now()
FROM focowiki.publication_impacts
WHERE status IN ('pending', 'running')
GROUP BY focowiki.runtime_pressure_shard(id)
ON CONFLICT (counter_key, counter_shard) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    updated_at = EXCLUDED.updated_at;

INSERT INTO focowiki.runtime_pressure_counter_shards (
  counter_key, counter_shard, counter_value, updated_at
)
SELECT 'pending_marker_count', focowiki.runtime_pressure_shard(id), count(*)::bigint, now()
FROM focowiki.source_dispatch_markers
WHERE status = 'pending'
GROUP BY focowiki.runtime_pressure_shard(id)
ON CONFLICT (counter_key, counter_shard) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    updated_at = EXCLUDED.updated_at;

INSERT INTO focowiki.runtime_pressure_counters (
  counter_key, counter_value, reconciled_at, updated_at
)
SELECT 'source_queue_depth', count(*)::bigint, now(), now()
FROM focowiki.role_jobs
WHERE role = 'source' AND status IN ('queued', 'running')
ON CONFLICT (counter_key) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    reconciled_at = EXCLUDED.reconciled_at,
    updated_at = EXCLUDED.updated_at;
INSERT INTO focowiki.runtime_pressure_counters (
  counter_key, counter_value, reconciled_at, updated_at
)
SELECT 'dirty_file_count', count(*)::bigint, now(), now()
FROM focowiki.publication_change_facts
WHERE assembly_state IN ('pending', 'claimed')
ON CONFLICT (counter_key) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    reconciled_at = EXCLUDED.reconciled_at,
    updated_at = EXCLUDED.updated_at;
INSERT INTO focowiki.runtime_pressure_counters (
  counter_key, counter_value, reconciled_at, updated_at
)
SELECT 'pending_impact_count', count(*)::bigint, now(), now()
FROM focowiki.publication_impacts
WHERE status IN ('pending', 'running')
ON CONFLICT (counter_key) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    reconciled_at = EXCLUDED.reconciled_at,
    updated_at = EXCLUDED.updated_at;
INSERT INTO focowiki.runtime_pressure_counters (
  counter_key, counter_value, reconciled_at, updated_at
)
SELECT 'pending_marker_count', count(*)::bigint, now(), now()
FROM focowiki.source_dispatch_markers
WHERE status = 'pending'
ON CONFLICT (counter_key) DO UPDATE
SET counter_value = EXCLUDED.counter_value,
    reconciled_at = EXCLUDED.reconciled_at,
    updated_at = EXCLUDED.updated_at;

DROP TABLE IF EXISTS focowiki.generation_assembly_signals;

ALTER TABLE focowiki.publication_change_facts
  DROP CONSTRAINT IF EXISTS publication_change_facts_planning_payload_check;
ALTER TABLE focowiki.publication_change_facts
  ADD CONSTRAINT publication_change_facts_planning_payload_check CHECK (
    jsonb_typeof(planning_payload_json) = 'object'
    AND jsonb_typeof(settings_snapshot_json) = 'object'
    AND publication_max_attempts >= 1
  );

ALTER TABLE focowiki.publication_generations
  ADD COLUMN IF NOT EXISTS assembled_change_count bigint DEFAULT 0 NOT NULL;
ALTER TABLE focowiki.publication_generations
  DROP CONSTRAINT IF EXISTS publication_generations_assembled_count_check;
ALTER TABLE focowiki.publication_generations
  ADD CONSTRAINT publication_generations_assembled_count_check CHECK (
    assembled_change_count >= 0
  );

ALTER TABLE focowiki.publication_progress
  ADD COLUMN IF NOT EXISTS remaining_impact_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS remaining_subtask_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS running_subtask_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS failed_subtask_count bigint DEFAULT 0 NOT NULL;

ALTER TABLE focowiki.publication_progress
  DROP CONSTRAINT IF EXISTS publication_progress_remaining_counts_check;
ALTER TABLE focowiki.publication_progress
  ADD CONSTRAINT publication_progress_remaining_counts_check CHECK (
    remaining_impact_count >= 0 AND remaining_subtask_count >= 0
    AND running_subtask_count >= 0 AND failed_subtask_count >= 0
    AND running_subtask_count + failed_subtask_count <= remaining_subtask_count
  );

UPDATE focowiki.publication_progress progress
SET remaining_impact_count = counts.remaining_count,
    updated_at = now()
FROM (
  SELECT generation_id,
         count(*) FILTER (WHERE status IN ('pending', 'running'))::bigint AS remaining_count
  FROM focowiki.publication_impacts
  GROUP BY generation_id
) counts
WHERE counts.generation_id = progress.generation_id;

CREATE TABLE IF NOT EXISTS focowiki.projection_compaction_scan_cursor (
    singleton boolean PRIMARY KEY DEFAULT true,
    knowledge_base_id text,
    projection_kind text,
    logical_partition text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_compaction_scan_cursor_singleton_check CHECK (singleton)
);

INSERT INTO focowiki.projection_compaction_scan_cursor (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS focowiki.projection_compaction_jobs (
    id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    projection_kind text NOT NULL,
    logical_partition text NOT NULL,
    active_generation_id text NOT NULL,
    expected_segment_ids text[] NOT NULL,
    reason_codes text[] NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    locked_by text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT projection_compaction_jobs_partition_key UNIQUE (
      knowledge_base_id, projection_kind, logical_partition
    ),
    CONSTRAINT projection_compaction_jobs_state_check CHECK (
      state = ANY (ARRAY['pending', 'running', 'completed', 'failed', 'superseded'])
    ),
    CONSTRAINT projection_compaction_jobs_attempt_check CHECK (
      attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts
    ),
    CONSTRAINT projection_compaction_jobs_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS projection_compaction_jobs_claim_idx
  ON focowiki.projection_compaction_jobs (state, run_after, lease_expires_at, updated_at, id)
  WHERE state IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS projection_compaction_jobs_active_summary_idx
  ON focowiki.projection_compaction_jobs (knowledge_base_id, updated_at DESC, id)
  WHERE state IN ('pending', 'running', 'failed');

CREATE INDEX IF NOT EXISTS projection_compaction_jobs_completed_summary_idx
  ON focowiki.projection_compaction_jobs (knowledge_base_id, updated_at DESC, id)
  WHERE state IN ('completed', 'superseded');

CREATE TABLE IF NOT EXISTS focowiki.source_directory_statistics (
    knowledge_base_id text NOT NULL,
    directory_id text PRIMARY KEY,
    direct_file_count bigint DEFAULT 0 NOT NULL,
    descendant_file_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_directory_statistics_counts_check CHECK (
      direct_file_count >= 0 AND descendant_file_count >= 0
    ),
    CONSTRAINT source_directory_statistics_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    CONSTRAINT source_directory_statistics_directory_id_fkey
      FOREIGN KEY (directory_id) REFERENCES focowiki.source_directories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS source_directory_statistics_directory_idx
  ON focowiki.source_directory_statistics (knowledge_base_id, directory_id);
CREATE INDEX IF NOT EXISTS source_directories_resource_page_idx
  ON focowiki.source_directories (knowledge_base_id, parent_id, id)
  WHERE deleted_at IS NULL AND deletion_intent_id IS NULL;

INSERT INTO focowiki.source_directory_statistics (
  knowledge_base_id, directory_id, direct_file_count, descendant_file_count, updated_at
)
WITH RECURSIVE visible_directories AS MATERIALIZED (
  SELECT id, knowledge_base_id, parent_id
  FROM focowiki.source_directories
  WHERE deleted_at IS NULL AND deletion_intent_id IS NULL
),
ancestry AS (
  SELECT id AS directory_id, knowledge_base_id, id AS ancestor_id
  FROM visible_directories
  UNION ALL
  SELECT ancestry.directory_id, ancestry.knowledge_base_id, directory.parent_id
  FROM ancestry
  JOIN visible_directories directory
    ON directory.id = ancestry.ancestor_id
   AND directory.knowledge_base_id = ancestry.knowledge_base_id
  WHERE directory.parent_id IS NOT NULL
),
direct_counts AS (
  SELECT source.knowledge_base_id, source.directory_id, count(*)::bigint AS file_count
  FROM focowiki.source_files source
  WHERE source.directory_id IS NOT NULL
    AND source.deleted_at IS NULL
    AND source.deletion_intent_id IS NULL
  GROUP BY source.knowledge_base_id, source.directory_id
),
descendant_counts AS (
  SELECT ancestry.knowledge_base_id, ancestry.ancestor_id AS directory_id,
         count(source.id)::bigint AS file_count
  FROM ancestry
  JOIN focowiki.source_files source
    ON source.knowledge_base_id = ancestry.knowledge_base_id
   AND source.directory_id = ancestry.directory_id
   AND source.deleted_at IS NULL
   AND source.deletion_intent_id IS NULL
  GROUP BY ancestry.knowledge_base_id, ancestry.ancestor_id
)
SELECT directory.knowledge_base_id, directory.id,
       coalesce(direct.file_count, 0), coalesce(descendant.file_count, 0), now()
FROM visible_directories directory
LEFT JOIN direct_counts direct
  ON direct.knowledge_base_id = directory.knowledge_base_id
 AND direct.directory_id = directory.id
LEFT JOIN descendant_counts descendant
  ON descendant.knowledge_base_id = directory.knowledge_base_id
 AND descendant.directory_id = directory.id
ON CONFLICT (directory_id) DO UPDATE
SET knowledge_base_id = EXCLUDED.knowledge_base_id,
    direct_file_count = EXCLUDED.direct_file_count,
    descendant_file_count = EXCLUDED.descendant_file_count,
    updated_at = EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION focowiki.initialize_source_directory_statistics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO focowiki.source_directory_statistics (
    knowledge_base_id, directory_id, direct_file_count, descendant_file_count, updated_at
  )
  SELECT knowledge_base_id, id, 0, 0, now()
  FROM new_source_directories
  ON CONFLICT (directory_id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.increment_source_directory_statistics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH RECURSIVE changes AS MATERIALIZED (
    SELECT knowledge_base_id, directory_id, 1::bigint AS delta
    FROM new_source_files
    WHERE directory_id IS NOT NULL
      AND deleted_at IS NULL
      AND deletion_intent_id IS NULL
  ),
  ancestry AS (
    SELECT knowledge_base_id, directory_id, directory_id AS ancestor_id, delta
    FROM changes
    UNION ALL
    SELECT ancestry.knowledge_base_id, ancestry.directory_id,
           directory.parent_id, ancestry.delta
    FROM ancestry
    JOIN focowiki.source_directories directory
      ON directory.id = ancestry.ancestor_id
     AND directory.knowledge_base_id = ancestry.knowledge_base_id
    WHERE directory.parent_id IS NOT NULL
  ),
  direct_deltas AS (
    SELECT knowledge_base_id, directory_id, sum(delta)::bigint AS delta
    FROM changes GROUP BY knowledge_base_id, directory_id
  ),
  descendant_deltas AS (
    SELECT knowledge_base_id, ancestor_id AS directory_id, sum(delta)::bigint AS delta
    FROM ancestry GROUP BY knowledge_base_id, ancestor_id
  ),
  deltas AS (
    SELECT coalesce(direct.knowledge_base_id, descendant.knowledge_base_id) AS knowledge_base_id,
           coalesce(direct.directory_id, descendant.directory_id) AS directory_id,
           coalesce(direct.delta, 0) AS direct_delta,
           coalesce(descendant.delta, 0) AS descendant_delta
    FROM direct_deltas direct
    FULL JOIN descendant_deltas descendant
      ON descendant.knowledge_base_id = direct.knowledge_base_id
     AND descendant.directory_id = direct.directory_id
  )
  UPDATE focowiki.source_directory_statistics statistics
  SET direct_file_count = statistics.direct_file_count + deltas.direct_delta,
      descendant_file_count = statistics.descendant_file_count + deltas.descendant_delta,
      updated_at = now()
  FROM deltas
  WHERE statistics.knowledge_base_id = deltas.knowledge_base_id
    AND statistics.directory_id = deltas.directory_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.decrement_source_directory_statistics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH RECURSIVE changes AS MATERIALIZED (
    SELECT knowledge_base_id, directory_id, -1::bigint AS delta
    FROM old_source_files
    WHERE directory_id IS NOT NULL
      AND deleted_at IS NULL
      AND deletion_intent_id IS NULL
  ),
  ancestry AS (
    SELECT knowledge_base_id, directory_id, directory_id AS ancestor_id, delta
    FROM changes
    UNION ALL
    SELECT ancestry.knowledge_base_id, ancestry.directory_id,
           directory.parent_id, ancestry.delta
    FROM ancestry
    JOIN focowiki.source_directories directory
      ON directory.id = ancestry.ancestor_id
     AND directory.knowledge_base_id = ancestry.knowledge_base_id
    WHERE directory.parent_id IS NOT NULL
  ),
  direct_deltas AS (
    SELECT knowledge_base_id, directory_id, sum(delta)::bigint AS delta
    FROM changes GROUP BY knowledge_base_id, directory_id
  ),
  descendant_deltas AS (
    SELECT knowledge_base_id, ancestor_id AS directory_id, sum(delta)::bigint AS delta
    FROM ancestry GROUP BY knowledge_base_id, ancestor_id
  ),
  deltas AS (
    SELECT coalesce(direct.knowledge_base_id, descendant.knowledge_base_id) AS knowledge_base_id,
           coalesce(direct.directory_id, descendant.directory_id) AS directory_id,
           coalesce(direct.delta, 0) AS direct_delta,
           coalesce(descendant.delta, 0) AS descendant_delta
    FROM direct_deltas direct
    FULL JOIN descendant_deltas descendant
      ON descendant.knowledge_base_id = direct.knowledge_base_id
     AND descendant.directory_id = direct.directory_id
  )
  UPDATE focowiki.source_directory_statistics statistics
  SET direct_file_count = statistics.direct_file_count + deltas.direct_delta,
      descendant_file_count = statistics.descendant_file_count + deltas.descendant_delta,
      updated_at = now()
  FROM deltas
  WHERE statistics.knowledge_base_id = deltas.knowledge_base_id
    AND statistics.directory_id = deltas.directory_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.replace_source_directory_statistics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH RECURSIVE changes AS MATERIALIZED (
    SELECT knowledge_base_id, directory_id, -1::bigint AS delta
    FROM old_source_files
    WHERE directory_id IS NOT NULL
      AND deleted_at IS NULL
      AND deletion_intent_id IS NULL
    UNION ALL
    SELECT knowledge_base_id, directory_id, 1::bigint AS delta
    FROM new_source_files
    WHERE directory_id IS NOT NULL
      AND deleted_at IS NULL
      AND deletion_intent_id IS NULL
  ),
  ancestry AS (
    SELECT knowledge_base_id, directory_id, directory_id AS ancestor_id, delta
    FROM changes
    UNION ALL
    SELECT ancestry.knowledge_base_id, ancestry.directory_id,
           directory.parent_id, ancestry.delta
    FROM ancestry
    JOIN focowiki.source_directories directory
      ON directory.id = ancestry.ancestor_id
     AND directory.knowledge_base_id = ancestry.knowledge_base_id
    WHERE directory.parent_id IS NOT NULL
  ),
  direct_deltas AS (
    SELECT knowledge_base_id, directory_id, sum(delta)::bigint AS delta
    FROM changes GROUP BY knowledge_base_id, directory_id
  ),
  descendant_deltas AS (
    SELECT knowledge_base_id, ancestor_id AS directory_id, sum(delta)::bigint AS delta
    FROM ancestry GROUP BY knowledge_base_id, ancestor_id
  ),
  deltas AS (
    SELECT coalesce(direct.knowledge_base_id, descendant.knowledge_base_id) AS knowledge_base_id,
           coalesce(direct.directory_id, descendant.directory_id) AS directory_id,
           coalesce(direct.delta, 0) AS direct_delta,
           coalesce(descendant.delta, 0) AS descendant_delta
    FROM direct_deltas direct
    FULL JOIN descendant_deltas descendant
      ON descendant.knowledge_base_id = direct.knowledge_base_id
     AND descendant.directory_id = direct.directory_id
  )
  UPDATE focowiki.source_directory_statistics statistics
  SET direct_file_count = statistics.direct_file_count + deltas.direct_delta,
      descendant_file_count = statistics.descendant_file_count + deltas.descendant_delta,
      updated_at = now()
  FROM deltas
  WHERE statistics.knowledge_base_id = deltas.knowledge_base_id
    AND statistics.directory_id = deltas.directory_id
    AND (deltas.direct_delta <> 0 OR deltas.descendant_delta <> 0);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS source_directories_statistics_insert ON focowiki.source_directories;
CREATE TRIGGER source_directories_statistics_insert
  AFTER INSERT ON focowiki.source_directories
  REFERENCING NEW TABLE AS new_source_directories FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.initialize_source_directory_statistics();

DROP TRIGGER IF EXISTS source_files_directory_statistics_insert ON focowiki.source_files;
DROP TRIGGER IF EXISTS source_files_directory_statistics_update ON focowiki.source_files;
DROP TRIGGER IF EXISTS source_files_directory_statistics_delete ON focowiki.source_files;
CREATE TRIGGER source_files_directory_statistics_insert
  AFTER INSERT ON focowiki.source_files
  REFERENCING NEW TABLE AS new_source_files FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.increment_source_directory_statistics();
CREATE TRIGGER source_files_directory_statistics_update
  AFTER UPDATE ON focowiki.source_files
  REFERENCING OLD TABLE AS old_source_files NEW TABLE AS new_source_files FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.replace_source_directory_statistics();
CREATE TRIGGER source_files_directory_statistics_delete
  AFTER DELETE ON focowiki.source_files
  REFERENCING OLD TABLE AS old_source_files FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.decrement_source_directory_statistics();

CREATE TABLE IF NOT EXISTS focowiki.active_generated_directory_stats (
    knowledge_base_id text NOT NULL,
    path text NOT NULL,
    direct_file_count bigint DEFAULT 0 NOT NULL,
    descendant_file_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT active_generated_directory_stats_pkey PRIMARY KEY (knowledge_base_id, path),
    CONSTRAINT active_generated_directory_stats_counts_check CHECK (
      direct_file_count >= 0 AND descendant_file_count >= 0
    ),
    CONSTRAINT active_generated_directory_stats_knowledge_base_id_fkey
      FOREIGN KEY (knowledge_base_id) REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS active_generated_directory_stats_lookup_idx
  ON focowiki.active_generated_directory_stats (knowledge_base_id, path);

INSERT INTO focowiki.active_generated_directory_stats (
  knowledge_base_id, path, direct_file_count, descendant_file_count, updated_at
)
WITH expanded AS (
  SELECT reference.knowledge_base_id,
         array_to_string(parts[1:depth], '/') AS path,
         (depth = array_length(parts, 1) - 1)::int AS direct_delta
  FROM focowiki.active_object_refs reference
  CROSS JOIN LATERAL (SELECT string_to_array(reference.logical_path, '/') AS parts) parsed
  CROSS JOIN LATERAL generate_series(1, array_length(parts, 1) - 1) depth
  WHERE reference.logical_path IS NOT NULL
    AND (reference.logical_path LIKE '_graph/%' OR reference.logical_path LIKE '_index/%')
)
SELECT knowledge_base_id, path, sum(direct_delta), count(*)::bigint, now()
FROM expanded
GROUP BY knowledge_base_id, path
ON CONFLICT (knowledge_base_id, path) DO UPDATE
SET direct_file_count = EXCLUDED.direct_file_count,
    descendant_file_count = EXCLUDED.descendant_file_count,
    updated_at = EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION focowiki.apply_generated_directory_stat_deltas(
  target_changes jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH changes AS (
    SELECT entry->>'knowledgeBaseId' AS knowledge_base_id,
           entry->>'logicalPath' AS logical_path,
           (entry->>'delta')::bigint AS delta
    FROM jsonb_array_elements(target_changes) entry
    WHERE entry->>'logicalPath' IS NOT NULL
      AND (
        (entry->>'logicalPath') LIKE '_graph/%'
        OR (entry->>'logicalPath') LIKE '_index/%'
      )
  ),
  expanded AS (
    SELECT changes.knowledge_base_id,
           array_to_string(parts[1:depth], '/') AS path,
           sum(changes.delta) FILTER (
             WHERE depth = array_length(parts, 1) - 1
           )::bigint AS direct_delta,
           sum(changes.delta)::bigint AS descendant_delta
    FROM changes
    CROSS JOIN LATERAL (SELECT string_to_array(changes.logical_path, '/') AS parts) parsed
    CROSS JOIN LATERAL generate_series(1, array_length(parts, 1) - 1) depth
    GROUP BY changes.knowledge_base_id, path
  ),
  updated AS (
    UPDATE focowiki.active_generated_directory_stats statistics
    SET direct_file_count = statistics.direct_file_count + coalesce(expanded.direct_delta, 0),
        descendant_file_count = statistics.descendant_file_count + expanded.descendant_delta,
        updated_at = now()
    FROM expanded
    WHERE statistics.knowledge_base_id = expanded.knowledge_base_id
      AND statistics.path = expanded.path
      AND (coalesce(expanded.direct_delta, 0) <> 0 OR expanded.descendant_delta <> 0)
    RETURNING statistics.knowledge_base_id, statistics.path
  )
  INSERT INTO focowiki.active_generated_directory_stats (
    knowledge_base_id, path, direct_file_count, descendant_file_count, updated_at
  )
  SELECT knowledge_base_id, path, coalesce(direct_delta, 0), descendant_delta, now()
  FROM expanded
  WHERE (coalesce(direct_delta, 0) <> 0 OR descendant_delta <> 0)
    AND coalesce(direct_delta, 0) >= 0
    AND descendant_delta >= 0
    AND NOT EXISTS (
      SELECT 1
      FROM updated
      WHERE updated.knowledge_base_id = expanded.knowledge_base_id
        AND updated.path = expanded.path
    )
  ON CONFLICT (knowledge_base_id, path) DO UPDATE
  SET direct_file_count = focowiki.active_generated_directory_stats.direct_file_count
        + EXCLUDED.direct_file_count,
      descendant_file_count = focowiki.active_generated_directory_stats.descendant_file_count
        + EXCLUDED.descendant_file_count,
      updated_at = EXCLUDED.updated_at;

  DELETE FROM focowiki.active_generated_directory_stats
  WHERE direct_file_count = 0 AND descendant_file_count = 0;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.increment_generated_directory_statistics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM focowiki.apply_generated_directory_stat_deltas(
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'knowledgeBaseId', knowledge_base_id,
        'logicalPath', logical_path,
        'delta', 1
      )) FROM new_active_object_refs
    ), '[]'::jsonb)
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.decrement_generated_directory_statistics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM focowiki.apply_generated_directory_stat_deltas(
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'knowledgeBaseId', knowledge_base_id,
        'logicalPath', logical_path,
        'delta', -1
      )) FROM old_active_object_refs
    ), '[]'::jsonb)
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.replace_generated_directory_statistics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM focowiki.apply_generated_directory_stat_deltas(
    coalesce((
      SELECT jsonb_agg(change)
      FROM (
        SELECT jsonb_build_object(
          'knowledgeBaseId', knowledge_base_id,
          'logicalPath', logical_path,
          'delta', -1
        ) AS change FROM old_active_object_refs
        UNION ALL
        SELECT jsonb_build_object(
          'knowledgeBaseId', knowledge_base_id,
          'logicalPath', logical_path,
          'delta', 1
        ) AS change FROM new_active_object_refs
      ) changes
    ), '[]'::jsonb)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS active_object_refs_generated_stats_insert ON focowiki.active_object_refs;
DROP TRIGGER IF EXISTS active_object_refs_generated_stats_update ON focowiki.active_object_refs;
DROP TRIGGER IF EXISTS active_object_refs_generated_stats_delete ON focowiki.active_object_refs;
CREATE TRIGGER active_object_refs_generated_stats_insert
  AFTER INSERT ON focowiki.active_object_refs
  REFERENCING NEW TABLE AS new_active_object_refs FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.increment_generated_directory_statistics();
CREATE TRIGGER active_object_refs_generated_stats_update
  AFTER UPDATE ON focowiki.active_object_refs
  REFERENCING OLD TABLE AS old_active_object_refs NEW TABLE AS new_active_object_refs
  FOR EACH STATEMENT EXECUTE FUNCTION focowiki.replace_generated_directory_statistics();
CREATE TRIGGER active_object_refs_generated_stats_delete
  AFTER DELETE ON focowiki.active_object_refs
  REFERENCING OLD TABLE AS old_active_object_refs FOR EACH STATEMENT
  EXECUTE FUNCTION focowiki.decrement_generated_directory_statistics();

UPDATE focowiki.runtime_generation
SET generation = 'large-scale-ingestion-runtime-v8'
WHERE singleton = true;
