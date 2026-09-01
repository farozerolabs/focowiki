ALTER TABLE focowiki.source_revision_presentations
  ADD COLUMN IF NOT EXISTS metadata_parsed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS metadata_repair_started_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS source_revision_presentations_metadata_repair_idx
ON focowiki.source_revision_presentations (
  metadata_repair_started_at,
  created_at,
  source_revision_public_id
)
WHERE metadata_parsed_at IS NULL;

ALTER TABLE focowiki.runtime_generation
  DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v29-source-metadata-persistence-repair'
WHERE singleton = true
  AND generation = 'storage-vnext-v28-navigation-leaf-identity-recovery';

ALTER TABLE focowiki.runtime_generation
  ADD CONSTRAINT runtime_generation_value_check CHECK (
    generation = 'storage-vnext-v29-source-metadata-persistence-repair'
  );
