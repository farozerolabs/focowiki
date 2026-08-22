CREATE TABLE focowiki.projection_legacy_cleanup_state (
    singleton boolean PRIMARY KEY DEFAULT true,
    state text DEFAULT 'pending' NOT NULL,
    cleaned_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_legacy_cleanup_state_singleton_check
      CHECK (singleton),
    CONSTRAINT projection_legacy_cleanup_state_value_check
      CHECK (state IN ('pending', 'cleaned'))
);

INSERT INTO focowiki.projection_legacy_cleanup_state (singleton, state)
VALUES (true, 'pending')
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION focowiki.initialize_projection_publication_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    initial_writer_mode text;
BEGIN
    SELECT state
    FROM focowiki.projection_legacy_cleanup_state
    WHERE singleton = true
    INTO initial_writer_mode;
    IF initial_writer_mode <> 'cleaned' THEN RETURN NEW; END IF;
    INSERT INTO focowiki.knowledge_base_projection_heads (
      knowledge_base_id, updated_at
    ) VALUES (NEW.public_id, NEW.created_at)
    ON CONFLICT (knowledge_base_id) DO NOTHING;
    INSERT INTO focowiki.projection_cutover_states (
      knowledge_base_id, writer_mode, updated_at
    ) VALUES (NEW.public_id, 'coherent', NEW.created_at)
    ON CONFLICT (knowledge_base_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_bases_projection_publication_owner
ON focowiki.knowledge_bases;

CREATE TRIGGER knowledge_bases_projection_publication_owner
AFTER INSERT ON focowiki.knowledge_bases
FOR EACH ROW EXECUTE FUNCTION focowiki.initialize_projection_publication_owner();

CREATE OR REPLACE FUNCTION focowiki.legacy_projection_object_is_referenced(
    target_object_id text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    referenced boolean;
BEGIN
    IF to_regclass('focowiki.projection_scope_object_refs') IS NULL THEN
      RETURN false;
    END IF;
    EXECUTE $query$
      SELECT EXISTS (
        SELECT 1 FROM focowiki.projection_scope_object_refs reference
        WHERE reference.object_id = $1
      )
    $query$ INTO referenced USING target_object_id;
    RETURN referenced;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.try_cleanup_legacy_projection_schema(
    cleanup_time timestamp with time zone
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    blocked boolean;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'focowiki:legacy-projection-cleanup', 70702));

    SELECT state = 'cleaned'
    FROM focowiki.projection_legacy_cleanup_state
    WHERE singleton = true
    INTO blocked;
    IF blocked THEN RETURN false; END IF;

    SELECT EXISTS (
      SELECT 1
      FROM focowiki.knowledge_bases knowledge_base
      LEFT JOIN focowiki.projection_cutover_states cutover
        ON cutover.knowledge_base_id = knowledge_base.public_id
      WHERE knowledge_base.deleted_at IS NULL
        AND coalesce(cutover.writer_mode, 'legacy') <> 'coherent'
    ) INTO blocked;
    IF blocked THEN RETURN false; END IF;

    IF to_regclass('focowiki.projection_dirty_scopes') IS NOT NULL THEN
      EXECUTE $query$
        SELECT EXISTS (
          SELECT 1 FROM focowiki.projection_dirty_scopes
          WHERE state IN ('waiting', 'running')
        )
      $query$ INTO blocked;
      IF blocked THEN RETURN false; END IF;
    END IF;

    EXECUTE 'DROP TABLE IF EXISTS focowiki.projection_scope_storage_metrics';
    EXECUTE 'DROP TABLE IF EXISTS focowiki.projection_scope_object_refs';
    EXECUTE 'DROP TABLE IF EXISTS focowiki.projection_scope_receipts';
    EXECUTE 'DROP TABLE IF EXISTS focowiki.projection_scope_outputs';
    EXECUTE 'DROP TABLE IF EXISTS focowiki.projection_scope_contributions';
    EXECUTE 'DROP TABLE IF EXISTS focowiki.projection_dirty_scopes';
    EXECUTE 'DROP TABLE IF EXISTS focowiki.scoped_activation_owners';

    UPDATE focowiki.projection_legacy_cleanup_state
    SET state = 'cleaned', cleaned_at = coalesce(cleaned_at, cleanup_time),
        updated_at = cleanup_time
    WHERE singleton = true;
    RETURN true;
END;
$$;

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v15-projection-legacy-cleanup-gate'
WHERE singleton = true
  AND generation = 'storage-vnext-v14-projection-publication-coherence';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
        generation = 'storage-vnext-v15-projection-legacy-cleanup-gate'
    );
