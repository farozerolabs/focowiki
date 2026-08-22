ALTER TABLE focowiki.projection_scope_navigation_mutations
    DROP CONSTRAINT projection_scope_navigation_mutations_value_check;

ALTER TABLE focowiki.projection_scope_navigation_mutations
    ADD CONSTRAINT projection_scope_navigation_mutations_value_check CHECK (
      octet_length(directory_path) <= 4096
      AND directory_path = lower(directory_path)
      AND owner_scope_identity <> ''
      AND octet_length(owner_scope_identity) <= 2048
      AND mutation_order BETWEEN 0 AND 999999
      AND action IN ('upsert', 'delete')
      AND jsonb_typeof(mutation) = 'object'
      AND octet_length(mutation::text) <= 21500000
    );

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v16-projection-navigation-capacity'
WHERE singleton = true
  AND generation = 'storage-vnext-v15-projection-legacy-cleanup-gate';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v16-projection-navigation-capacity'
    );
