ALTER TABLE focowiki.release_roots
  ADD COLUMN navigation_profile_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT release_roots_navigation_profile_check CHECK (
    navigation_profile_version IN (0, 1)
  );

ALTER TABLE focowiki.release_candidate_validations
  ADD COLUMN navigation_profile_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT release_candidate_validations_navigation_profile_check CHECK (
    navigation_profile_version IN (0, 1)
  );

CREATE INDEX release_catalog_entries_root_path_c_idx
  ON focowiki.release_catalog_entries (
    release_root_public_id,
    logical_path COLLATE "C"
  );

CREATE INDEX release_catalog_tombstones_root_path_c_idx
  ON focowiki.release_catalog_tombstones (
    release_root_public_id,
    logical_path COLLATE "C"
  );

CREATE OR REPLACE FUNCTION focowiki.public_generated_file_id(
  knowledge_base_public_id text,
  generated_logical_path text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT 'generated-' || md5(
    knowledge_base_public_id || ':' || generated_logical_path
  )
$$;

CREATE OR REPLACE FUNCTION focowiki.public_generated_directory_id(
  knowledge_base_public_id text,
  generated_logical_path text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT 'generated-directory-' || md5(
    knowledge_base_public_id || ':' || generated_logical_path
  )
$$;

CREATE OR REPLACE FUNCTION focowiki.resolve_release_shards(
  requested_root_public_id text
)
RETURNS TABLE (
  public_id text,
  logical_kind text,
  first_logical_path text,
  last_logical_path text,
  record_count bigint,
  byte_count bigint,
  checksum_sha256 text,
  object_id text,
  ordinal bigint,
  root_owned boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT root.public_id, root.base_root_public_id, 0 AS depth,
           ARRAY[root.public_id]::text[] AS visited
    FROM focowiki.release_roots root
    WHERE root.public_id = requested_root_public_id
    UNION ALL
    SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
           lineage.visited || base.public_id
    FROM lineage
    JOIN focowiki.release_roots base
      ON base.public_id = lineage.base_root_public_id
    WHERE lineage.depth < 63
      AND NOT base.public_id = ANY(lineage.visited)
  ), effective AS (
    SELECT DISTINCT ON (
             shard.logical_kind COLLATE "C",
             CASE
               WHEN shard.logical_kind IN (
                 'directory_navigation', 'extension_navigation'
               )
                 THEN length(shard.first_logical_path)::text || ':'
                   || shard.first_logical_path || ':' || attached.ordinal::text
               ELSE attached.ordinal::text
             END COLLATE "C"
           )
           shard.public_id, shard.logical_kind, shard.first_logical_path,
           shard.last_logical_path, shard.record_count, shard.byte_count,
           shard.checksum_sha256, shard.object_id, attached.ordinal,
           lineage.depth
    FROM lineage
    JOIN focowiki.release_root_shards attached
      ON attached.release_root_public_id = lineage.public_id
    JOIN focowiki.release_shards shard
      ON shard.knowledge_base_id = attached.knowledge_base_id
     AND shard.public_id = attached.release_shard_public_id
    ORDER BY shard.logical_kind COLLATE "C",
             CASE
               WHEN shard.logical_kind IN (
                 'directory_navigation', 'extension_navigation'
               )
                 THEN length(shard.first_logical_path)::text || ':'
                   || shard.first_logical_path || ':' || attached.ordinal::text
               ELSE attached.ordinal::text
             END COLLATE "C",
             lineage.depth
  )
  SELECT effective.public_id, effective.logical_kind,
         effective.first_logical_path, effective.last_logical_path,
         effective.record_count, effective.byte_count,
         effective.checksum_sha256, effective.object_id,
         effective.ordinal, effective.depth = 0
  FROM effective
$$;

CREATE OR REPLACE FUNCTION focowiki.resolve_release_directory_summaries(
  requested_root_public_id text
)
RETURNS TABLE (
  directory_public_id text,
  logical_path text,
  first_leaf_path text,
  direct_file_count bigint,
  descendant_file_count bigint,
  ordinal bigint,
  root_owned boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT root.public_id, root.base_root_public_id, 0 AS depth,
           ARRAY[root.public_id]::text[] AS visited
    FROM focowiki.release_roots root
    WHERE root.public_id = requested_root_public_id
    UNION ALL
    SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
           lineage.visited || base.public_id
    FROM lineage
    JOIN focowiki.release_roots base
      ON base.public_id = lineage.base_root_public_id
    WHERE lineage.depth < 63
      AND NOT base.public_id = ANY(lineage.visited)
  ), identity_effective AS (
    SELECT DISTINCT ON (
             coalesce(
               summary.directory_public_id,
               'generated:' || summary.logical_path
             )
           )
           summary.directory_public_id, summary.logical_path,
           summary.first_leaf_path, summary.direct_file_count,
           summary.descendant_file_count, summary.ordinal, lineage.depth
    FROM lineage
    JOIN focowiki.directory_summaries summary
      ON summary.release_root_public_id = lineage.public_id
    ORDER BY coalesce(
               summary.directory_public_id,
               'generated:' || summary.logical_path
             ),
             lineage.depth
  ), effective AS (
    SELECT DISTINCT ON (summary.logical_path COLLATE "C")
           summary.directory_public_id, summary.logical_path,
           summary.first_leaf_path, summary.direct_file_count,
           summary.descendant_file_count, summary.ordinal, summary.depth
    FROM identity_effective summary
    ORDER BY summary.logical_path COLLATE "C", summary.depth
  )
  SELECT effective.directory_public_id, effective.logical_path,
         effective.first_leaf_path, effective.direct_file_count,
         effective.descendant_file_count, effective.ordinal,
         effective.depth = 0
  FROM effective
$$;

ALTER TABLE focowiki.runtime_generation
  DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v2'
WHERE singleton = true
  AND generation = 'storage-vnext-v1';

ALTER TABLE focowiki.runtime_generation
  ADD CONSTRAINT runtime_generation_value_check CHECK (
    generation = 'storage-vnext-v2'
  );
