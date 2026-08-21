DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM focowiki.knowledge_bases)
       OR EXISTS (SELECT 1 FROM focowiki.document_processing_jobs)
       OR EXISTS (SELECT 1 FROM focowiki.operations) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Database schema is incompatible with this Focowiki release. Perform a clean reset of the Focowiki PostgreSQL database before starting services.';
    END IF;
END
$$;

ALTER TABLE focowiki.document_processing_jobs
    ADD COLUMN processing_generation text
    DEFAULT 'document-indexing-v13' NOT NULL;

ALTER TABLE focowiki.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_generation_check CHECK (
        processing_generation <> ''
        AND octet_length(processing_generation) <= 255
    );

CREATE INDEX document_processing_jobs_generation_reset_idx
    ON focowiki.document_processing_jobs (
      processing_generation, state, readiness_sequence
    )
    WHERE state IN ('waiting', 'processing', 'error');

CREATE TABLE focowiki.upload_operation_summaries (
    operation_public_id text PRIMARY KEY,
    knowledge_base_id text NOT NULL,
    session_public_id text NOT NULL,
    expected_entry_count integer NOT NULL,
    expected_byte_count bigint NOT NULL,
    received_entry_count integer NOT NULL,
    received_byte_count bigint NOT NULL,
    skipped_existing_count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_operation_summaries_operation_fkey
      FOREIGN KEY (knowledge_base_id, operation_public_id)
      REFERENCES focowiki.operations (knowledge_base_id, public_id)
      ON DELETE CASCADE,
    CONSTRAINT upload_operation_summaries_identity_check CHECK (
      operation_public_id <> ''
      AND session_public_id <> ''
      AND octet_length(operation_public_id) <= 255
      AND octet_length(session_public_id) <= 255
    ),
    CONSTRAINT upload_operation_summaries_count_check CHECK (
      expected_entry_count >= 0
      AND expected_byte_count >= 0
      AND received_entry_count >= 0
      AND received_byte_count >= 0
      AND skipped_existing_count >= 0
      AND received_entry_count + skipped_existing_count = expected_entry_count
    )
);

CREATE INDEX upload_operation_summaries_expiry_idx
    ON focowiki.upload_operation_summaries (expires_at, operation_public_id);

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v13-clean-document-indexing'
WHERE singleton = true
  AND generation = 'storage-vnext-v12-projection-object-lifecycle';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
        generation = 'storage-vnext-v13-clean-document-indexing'
    );
