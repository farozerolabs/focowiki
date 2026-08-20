DROP INDEX focowiki.document_artifact_work_claim_idx;

CREATE INDEX document_artifact_work_claim_idx
    ON focowiki.document_artifact_work (
        work_kind,
        next_eligible_at,
        created_at,
        public_id
    )
    INCLUDE (
        knowledge_base_id,
        document_job_public_id,
        source_revision_public_id,
        attempt_count,
        maximum_attempts
    )
    WHERE state = 'waiting';

CREATE INDEX document_artifact_receipts_work_idx
    ON focowiki.document_artifact_receipts (work_public_id);

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v10-document-indexing-throughput'
WHERE singleton = true
  AND generation = 'storage-vnext-v9-document-indexing-hybrid';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
        generation = 'storage-vnext-v10-document-indexing-throughput'
    );
