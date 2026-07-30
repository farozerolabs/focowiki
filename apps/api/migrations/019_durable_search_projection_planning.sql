ALTER TABLE focowiki.search_projection_work
  DROP CONSTRAINT IF EXISTS search_projection_work_work_kind_check;

ALTER TABLE focowiki.search_projection_work
  ADD CONSTRAINT search_projection_work_work_kind_check
  CHECK (
    work_kind IN (
      'prepare_index', 'plan_documents', 'documents', 'delete_documents',
      'validate', 'activate', 'cleanup'
    )
  );

CREATE INDEX IF NOT EXISTS generation_search_projection_refs_revision_idx
  ON focowiki.generation_search_projection_refs (
    knowledge_base_id,
    generation_id,
    source_revision_id,
    source_file_id
  );

UPDATE focowiki.runtime_generation
SET generation = 'durable-search-projection-planning-v19'
WHERE singleton = true;
