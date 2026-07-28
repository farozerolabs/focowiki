CREATE TABLE IF NOT EXISTS focowiki.storage_object_protection_index (
    object_key text NOT NULL,
    checksum_sha256 text NOT NULL,
    format_version integer NOT NULL,
    protected boolean DEFAULT true NOT NULL,
    dirty boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    protection_classes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_object_protection_index_pkey PRIMARY KEY (
      object_key, checksum_sha256, format_version
    ),
    CONSTRAINT storage_object_protection_index_object_key_key UNIQUE (object_key),
    CONSTRAINT storage_object_protection_index_format_check CHECK (
      format_version > 0
    ),
    CONSTRAINT storage_object_protection_index_revision_check CHECK (
      revision > 0
    ),
    CONSTRAINT storage_object_protection_index_classes_check CHECK (
      protection_classes <@ ARRAY[
        'active_reference',
        'write_reservation',
        'retained_reference',
        'source',
        'registered',
        'projection_segment'
      ]::text[]
    )
);

CREATE INDEX IF NOT EXISTS storage_object_protection_index_lookup_idx
  ON focowiki.storage_object_protection_index (
    checksum_sha256, format_version, object_key
  )
  WHERE protected OR dirty;

CREATE INDEX IF NOT EXISTS storage_object_protection_index_refresh_idx
  ON focowiki.storage_object_protection_index (
    dirty, updated_at, object_key, checksum_sha256, format_version
  )
  WHERE dirty;

CREATE INDEX IF NOT EXISTS active_object_refs_storage_protection_idx
  ON focowiki.active_object_refs (checksum_sha256, format_version);

CREATE INDEX IF NOT EXISTS publication_generations_root_storage_protection_idx
  ON focowiki.publication_generations (
    root_manifest_checksum_sha256, format_version
  )
  WHERE root_manifest_checksum_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS projection_segments_storage_protection_backfill_idx
  ON focowiki.projection_segments (
    object_key, checksum_sha256, format_version
  )
  WHERE ownership_count > 0
     OR lifecycle_state = ANY (ARRAY['writing', 'active', 'retained']);

CREATE TABLE IF NOT EXISTS focowiki.storage_object_protection_dirty (
    object_key text NOT NULL,
    checksum_sha256 text NOT NULL,
    format_version integer NOT NULL,
    reason text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    lease_token text,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_object_protection_dirty_pkey PRIMARY KEY (
      object_key, checksum_sha256, format_version
    ),
    CONSTRAINT storage_object_protection_dirty_state_check CHECK (
      state = ANY (ARRAY['pending', 'running', 'retry'])
    ),
    CONSTRAINT storage_object_protection_dirty_counts_check CHECK (
      format_version > 0 AND revision > 0 AND attempt_count >= 0
    )
);

CREATE INDEX IF NOT EXISTS storage_object_protection_dirty_claim_idx
  ON focowiki.storage_object_protection_dirty (
    state, next_attempt_at, lease_expires_at,
    object_key, checksum_sha256, format_version
  );

CREATE TABLE IF NOT EXISTS focowiki.storage_object_protection_backfills (
    schema_version integer NOT NULL,
    state text DEFAULT 'pending' NOT NULL,
    phase text DEFAULT 'immutable_objects' NOT NULL,
    cursor_object_key text,
    processed_count bigint DEFAULT 0 NOT NULL,
    expected_count bigint DEFAULT 0 NOT NULL,
    verified_count bigint DEFAULT 0 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    lease_token text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    last_progress_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    recent_objects_per_second numeric,
    rolling_batch_latency_ms bigint,
    estimated_completion_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT storage_object_protection_backfills_pkey PRIMARY KEY (schema_version),
    CONSTRAINT storage_object_protection_backfills_state_check CHECK (
      state = ANY (ARRAY[
        'pending', 'backfilling', 'verifying', 'ready', 'retrying', 'failed'
      ])
    ),
    CONSTRAINT storage_object_protection_backfills_phase_check CHECK (
      phase = ANY (ARRAY[
        'immutable_objects', 'source_files', 'projection_segments',
        'dirty_refresh', 'verify_immutable_objects', 'verify_source_files',
        'verify_projection_segments', 'ready'
      ])
    ),
    CONSTRAINT storage_object_protection_backfills_counts_check CHECK (
      schema_version > 0
      AND processed_count >= 0
      AND expected_count >= 0
      AND verified_count >= 0
      AND retry_count >= 0
      AND revision > 0
      AND (rolling_batch_latency_ms IS NULL OR rolling_batch_latency_ms >= 0)
    )
);

ALTER TABLE focowiki.storage_object_protection_backfills
  ADD COLUMN IF NOT EXISTS revision bigint DEFAULT 1 NOT NULL;
ALTER TABLE focowiki.storage_object_protection_backfills
  DROP CONSTRAINT IF EXISTS storage_object_protection_backfills_counts_check;
ALTER TABLE focowiki.storage_object_protection_backfills
  ADD CONSTRAINT storage_object_protection_backfills_counts_check CHECK (
    schema_version > 0
    AND processed_count >= 0
    AND expected_count >= 0
    AND verified_count >= 0
    AND retry_count >= 0
    AND revision > 0
    AND (rolling_batch_latency_ms IS NULL OR rolling_batch_latency_ms >= 0)
  );

INSERT INTO focowiki.storage_object_protection_backfills (schema_version)
VALUES (1)
ON CONFLICT (schema_version) DO NOTHING;

CREATE INDEX IF NOT EXISTS storage_object_protection_backfills_claim_idx
  ON focowiki.storage_object_protection_backfills (
    state, next_attempt_at, lease_expires_at, schema_version
  )
  WHERE state = ANY (ARRAY['pending', 'backfilling', 'verifying', 'retrying']);

CREATE TABLE IF NOT EXISTS focowiki.storage_reconciliation_page_checkpoints (
    prefix text NOT NULL,
    cycle_id text NOT NULL,
    page_id text NOT NULL,
    continuation_token text,
    next_continuation_token text,
    expected_chunk_count integer NOT NULL,
    listed_count integer NOT NULL,
    database_chunk_size integer DEFAULT 100 NOT NULL,
    protected_count integer DEFAULT 0 NOT NULL,
    pending_count integer DEFAULT 0 NOT NULL,
    quarantined_count integer DEFAULT 0 NOT NULL,
    resolved_count integer DEFAULT 0 NOT NULL,
    committed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_reconciliation_page_checkpoints_pkey PRIMARY KEY (
      prefix, cycle_id, page_id
    ),
    CONSTRAINT storage_reconciliation_page_checkpoints_counts_check CHECK (
      expected_chunk_count >= 0
      AND listed_count >= 0
      AND database_chunk_size > 0
      AND protected_count >= 0
      AND pending_count >= 0
      AND quarantined_count >= 0
      AND resolved_count >= 0
    )
);

ALTER TABLE focowiki.storage_reconciliation_page_checkpoints
  ADD COLUMN IF NOT EXISTS database_chunk_size integer DEFAULT 100 NOT NULL;
ALTER TABLE focowiki.storage_reconciliation_page_checkpoints
  DROP CONSTRAINT IF EXISTS storage_reconciliation_page_checkpoints_counts_check;
ALTER TABLE focowiki.storage_reconciliation_page_checkpoints
  ADD CONSTRAINT storage_reconciliation_page_checkpoints_counts_check CHECK (
    expected_chunk_count >= 0
    AND listed_count >= 0
    AND database_chunk_size > 0
    AND protected_count >= 0
    AND pending_count >= 0
    AND quarantined_count >= 0
    AND resolved_count >= 0
  );

CREATE TABLE IF NOT EXISTS focowiki.storage_reconciliation_chunk_checkpoints (
    prefix text NOT NULL,
    cycle_id text NOT NULL,
    page_id text NOT NULL,
    chunk_ordinal integer NOT NULL,
    object_offset integer NOT NULL,
    object_count integer NOT NULL,
    protected_count integer DEFAULT 0 NOT NULL,
    pending_count integer DEFAULT 0 NOT NULL,
    quarantined_count integer DEFAULT 0 NOT NULL,
    resolved_count integer DEFAULT 0 NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_reconciliation_chunk_checkpoints_pkey PRIMARY KEY (
      prefix, cycle_id, page_id, chunk_ordinal
    ),
    CONSTRAINT storage_reconciliation_chunk_checkpoints_page_fkey FOREIGN KEY (
      prefix, cycle_id, page_id
    ) REFERENCES focowiki.storage_reconciliation_page_checkpoints (
      prefix, cycle_id, page_id
    ) ON DELETE CASCADE,
    CONSTRAINT storage_reconciliation_chunk_checkpoints_counts_check CHECK (
      chunk_ordinal >= 0
      AND object_offset >= 0
      AND object_count >= 0
      AND protected_count >= 0
      AND pending_count >= 0
      AND quarantined_count >= 0
      AND resolved_count >= 0
    )
);

ALTER TABLE focowiki.storage_reconciliation_cycles
  ADD COLUMN IF NOT EXISTS resolved_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS pending_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS database_chunk_size integer,
  ADD COLUMN IF NOT EXISTS recent_objects_per_second numeric,
  ADD COLUMN IF NOT EXISTS rolling_batch_latency_ms bigint,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS safe_error_message text;

ALTER TABLE focowiki.storage_reconciliation_cycles
  DROP CONSTRAINT IF EXISTS storage_reconciliation_cycles_extended_counts_check;
ALTER TABLE focowiki.storage_reconciliation_cycles
  ADD CONSTRAINT storage_reconciliation_cycles_extended_counts_check CHECK (
    resolved_count >= 0
    AND pending_count >= 0
    AND (database_chunk_size IS NULL OR database_chunk_size > 0)
    AND (rolling_batch_latency_ms IS NULL OR rolling_batch_latency_ms >= 0)
  );

CREATE OR REPLACE FUNCTION focowiki.protect_storage_object_identity(
  input_object_key text,
  input_checksum_sha256 text,
  input_format_version integer,
  input_protection_class text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF input_object_key IS NULL
     OR input_checksum_sha256 IS NULL
     OR input_format_version IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO focowiki.storage_object_protection_index (
    object_key, checksum_sha256, format_version, protected, dirty,
    revision, protection_classes, refreshed_at, updated_at
  ) VALUES (
    input_object_key, input_checksum_sha256, input_format_version,
    true, false, 1, ARRAY[input_protection_class], now(), now()
  )
  ON CONFLICT (object_key, checksum_sha256, format_version) DO UPDATE
  SET protected = true,
      dirty = false,
      revision = focowiki.storage_object_protection_index.revision + 1,
      protection_classes = ARRAY(
        SELECT DISTINCT value
        FROM unnest(
          CASE input_protection_class
            WHEN 'registered' THEN array_remove(
              focowiki.storage_object_protection_index.protection_classes,
              'write_reservation'
            )
            WHEN 'write_reservation' THEN array_remove(
              focowiki.storage_object_protection_index.protection_classes,
              'registered'
            )
            ELSE focowiki.storage_object_protection_index.protection_classes
          END
          || EXCLUDED.protection_classes
        ) AS value
        ORDER BY value
      ),
      refreshed_at = now(),
      updated_at = now();

  DELETE FROM focowiki.storage_object_protection_dirty
  WHERE object_key = input_object_key
    AND checksum_sha256 = input_checksum_sha256
    AND format_version = input_format_version;
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.mark_storage_object_identity_dirty(
  input_object_key text,
  input_checksum_sha256 text,
  input_format_version integer,
  input_reason text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF input_object_key IS NULL
     OR input_checksum_sha256 IS NULL
     OR input_format_version IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO focowiki.storage_object_protection_index (
    object_key, checksum_sha256, format_version, protected, dirty,
    revision, protection_classes, updated_at
  ) VALUES (
    input_object_key, input_checksum_sha256, input_format_version,
    true, true, 1, ARRAY[]::text[], now()
  )
  ON CONFLICT (object_key, checksum_sha256, format_version) DO UPDATE
  SET dirty = true,
      revision = focowiki.storage_object_protection_index.revision + 1,
      updated_at = now();

  INSERT INTO focowiki.storage_object_protection_dirty (
    object_key, checksum_sha256, format_version, reason,
    revision, state, next_attempt_at, updated_at
  ) VALUES (
    input_object_key, input_checksum_sha256, input_format_version,
    input_reason, 1, 'pending', now(), now()
  )
  ON CONFLICT (object_key, checksum_sha256, format_version) DO UPDATE
  SET reason = EXCLUDED.reason,
      revision = focowiki.storage_object_protection_dirty.revision + 1,
      state = 'pending',
      lease_token = NULL,
      lease_expires_at = NULL,
      next_attempt_at = now(),
      last_error_code = NULL,
      updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION focowiki.sync_source_file_storage_protection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM focowiki.mark_storage_object_identity_dirty(
      OLD.object_key, OLD.checksum_sha256, 1, 'source_removed'
    );
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.object_key IS DISTINCT FROM NEW.object_key
       OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
       OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
     ) THEN
    PERFORM focowiki.mark_storage_object_identity_dirty(
      OLD.object_key, OLD.checksum_sha256, 1, 'source_changed'
    );
  END IF;

  IF NEW.deleted_at IS NULL THEN
    PERFORM focowiki.protect_storage_object_identity(
      NEW.object_key, NEW.checksum_sha256, 1, 'source'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS source_files_storage_protection_trigger
  ON focowiki.source_files;
CREATE TRIGGER source_files_storage_protection_trigger
AFTER INSERT OR UPDATE OF object_key, checksum_sha256, deleted_at OR DELETE
ON focowiki.source_files
FOR EACH ROW EXECUTE FUNCTION focowiki.sync_source_file_storage_protection();

CREATE OR REPLACE FUNCTION focowiki.sync_immutable_object_storage_protection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM focowiki.mark_storage_object_identity_dirty(
      OLD.object_key, OLD.checksum_sha256, OLD.format_version,
      'immutable_object_removed'
    );
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.object_key IS DISTINCT FROM NEW.object_key
       OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
       OR OLD.format_version IS DISTINCT FROM NEW.format_version
     ) THEN
    PERFORM focowiki.mark_storage_object_identity_dirty(
      OLD.object_key, OLD.checksum_sha256, OLD.format_version,
      'immutable_object_changed'
    );
  END IF;

  PERFORM focowiki.protect_storage_object_identity(
    NEW.object_key,
    NEW.checksum_sha256,
    NEW.format_version,
    CASE
      WHEN NEW.lifecycle_state = 'writing' THEN 'write_reservation'
      ELSE 'registered'
    END
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS immutable_objects_storage_protection_trigger
  ON focowiki.immutable_objects;
CREATE TRIGGER immutable_objects_storage_protection_trigger
AFTER INSERT OR UPDATE OF object_key, checksum_sha256, format_version, lifecycle_state OR DELETE
ON focowiki.immutable_objects
FOR EACH ROW EXECUTE FUNCTION focowiki.sync_immutable_object_storage_protection();

CREATE OR REPLACE FUNCTION focowiki.sync_projection_segment_storage_protection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_is_protected boolean;
  old_is_protected boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM focowiki.mark_storage_object_identity_dirty(
      OLD.object_key, OLD.checksum_sha256, OLD.format_version,
      'projection_segment_removed'
    );
    RETURN OLD;
  END IF;

  new_is_protected :=
    NEW.ownership_count > 0
    OR NEW.lifecycle_state = ANY (ARRAY['writing', 'active', 'retained']);

  IF TG_OP = 'UPDATE' THEN
    old_is_protected :=
      OLD.ownership_count > 0
      OR OLD.lifecycle_state = ANY (ARRAY['writing', 'active', 'retained']);
    IF (
      OLD.object_key IS DISTINCT FROM NEW.object_key
      OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
      OR OLD.format_version IS DISTINCT FROM NEW.format_version
      OR (old_is_protected AND NOT new_is_protected)
    ) THEN
      PERFORM focowiki.mark_storage_object_identity_dirty(
        OLD.object_key, OLD.checksum_sha256, OLD.format_version,
        'projection_segment_changed'
      );
    END IF;
  END IF;

  IF new_is_protected THEN
    PERFORM focowiki.protect_storage_object_identity(
      NEW.object_key, NEW.checksum_sha256, NEW.format_version,
      'projection_segment'
    );
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM focowiki.mark_storage_object_identity_dirty(
      NEW.object_key, NEW.checksum_sha256, NEW.format_version,
      'projection_segment_unreferenced'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projection_segments_storage_protection_trigger
  ON focowiki.projection_segments;
CREATE TRIGGER projection_segments_storage_protection_trigger
AFTER INSERT OR UPDATE OF
  object_key, checksum_sha256, format_version, lifecycle_state, ownership_count
OR DELETE
ON focowiki.projection_segments
FOR EACH ROW EXECUTE FUNCTION focowiki.sync_projection_segment_storage_protection();

UPDATE focowiki.runtime_generation
SET generation = 'indexed-storage-object-protection-v17'
WHERE singleton = true
  AND generation = 'knowledge-base-index-maintenance-v16';
