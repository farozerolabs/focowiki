DROP INDEX IF EXISTS focowiki.active_projection_records_tree_idx;

CREATE INDEX active_projection_records_tree_byte_order_idx
  ON focowiki.active_projection_records (
    knowledge_base_id,
    parent_path,
    (coalesce(sort_key, '') COLLATE "C"),
    (record_id COLLATE "C")
  )
  WHERE projection_kind = 'tree';

CREATE INDEX generation_directory_navigation_leaves_byte_order_idx
  ON focowiki.generation_directory_navigation_leaves (
    generation_id,
    directory_path,
    (last_sort_key COLLATE "C"),
    (first_sort_key COLLATE "C"),
    (id COLLATE "C")
  );

UPDATE focowiki.runtime_generation
SET generation = 'directory-order-repair-v14'
WHERE singleton = true;
