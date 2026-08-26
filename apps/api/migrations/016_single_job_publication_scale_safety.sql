CREATE TABLE focowiki.publication_job_navigation_mutations (
    job_public_id text NOT NULL,
    mutation_order integer NOT NULL,
    directory_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (job_public_id, mutation_order),
    UNIQUE (job_public_id, directory_path),
    FOREIGN KEY (job_public_id)
      REFERENCES focowiki.publication_jobs(public_id) ON DELETE CASCADE,
    CONSTRAINT publication_job_navigation_mutations_value_check CHECK (
      mutation_order >= 0
      AND directory_path <> ''
      AND octet_length(directory_path) <= 4096
      AND directory_path !~ '(^/|(^|/)\.\.(/|$))'
    )
);

CREATE TABLE focowiki.publication_job_navigation_leaves (
    job_public_id text NOT NULL,
    mutation_order integer NOT NULL,
    leaf_order integer NOT NULL,
    leaf_public_id text NOT NULL,
    previous_leaf_public_id text,
    next_leaf_public_id text,
    revision bigint NOT NULL,
    changed_at timestamp with time zone,
    PRIMARY KEY (job_public_id, mutation_order, leaf_order),
    UNIQUE (job_public_id, mutation_order, leaf_public_id),
    FOREIGN KEY (job_public_id, mutation_order)
      REFERENCES focowiki.publication_job_navigation_mutations(
        job_public_id, mutation_order
      ) ON DELETE CASCADE,
    CONSTRAINT publication_job_navigation_leaves_value_check CHECK (
      leaf_order >= 0
      AND leaf_public_id <> '' AND octet_length(leaf_public_id) <= 255
      AND (previous_leaf_public_id IS NULL
        OR octet_length(previous_leaf_public_id) BETWEEN 1 AND 255)
      AND (next_leaf_public_id IS NULL
        OR octet_length(next_leaf_public_id) BETWEEN 1 AND 255)
      AND revision > 0
    )
);

CREATE TABLE focowiki.publication_job_navigation_entries (
    job_public_id text NOT NULL,
    mutation_order integer NOT NULL,
    leaf_order integer NOT NULL,
    entry_order integer NOT NULL,
    entry_public_id text NOT NULL,
    sort_key text NOT NULL,
    name text NOT NULL,
    target_path text NOT NULL,
    evidence_path text,
    entry_kind text NOT NULL,
    PRIMARY KEY (job_public_id, mutation_order, leaf_order, entry_order),
    UNIQUE (job_public_id, mutation_order, entry_public_id),
    FOREIGN KEY (job_public_id, mutation_order, leaf_order)
      REFERENCES focowiki.publication_job_navigation_leaves(
        job_public_id, mutation_order, leaf_order
      ) ON DELETE CASCADE,
    CONSTRAINT publication_job_navigation_entries_value_check CHECK (
      entry_order >= 0
      AND entry_public_id <> '' AND octet_length(entry_public_id) <= 4096
      AND sort_key <> '' AND octet_length(sort_key) <= 8192
      AND name <> '' AND octet_length(name) <= 4096
      AND target_path <> '' AND octet_length(target_path) <= 4096
      AND (evidence_path IS NULL
        OR octet_length(evidence_path) BETWEEN 1 AND 4096)
      AND entry_kind IN ('file', 'directory')
    )
);

CREATE TABLE focowiki.publication_job_navigation_removals (
    job_public_id text NOT NULL,
    mutation_order integer NOT NULL,
    removal_order integer NOT NULL,
    leaf_public_id text NOT NULL,
    PRIMARY KEY (job_public_id, mutation_order, removal_order),
    UNIQUE (job_public_id, mutation_order, leaf_public_id),
    FOREIGN KEY (job_public_id, mutation_order)
      REFERENCES focowiki.publication_job_navigation_mutations(
        job_public_id, mutation_order
      ) ON DELETE CASCADE,
    CONSTRAINT publication_job_navigation_removals_value_check CHECK (
      removal_order >= 0
      AND leaf_public_id <> '' AND octet_length(leaf_public_id) <= 255
    )
);

CREATE INDEX publication_job_navigation_entries_read_idx
    ON focowiki.publication_job_navigation_entries (
      job_public_id, mutation_order, leaf_order, entry_order
    );

CREATE INDEX publication_job_navigation_removals_read_idx
    ON focowiki.publication_job_navigation_removals (
      job_public_id, mutation_order, removal_order
    );

UPDATE focowiki.publication_jobs
SET attempt_owner = NULL,
    attempt_token = NULL,
    attempt_started_at = NULL,
    attempt_deadline = NULL,
    attempt_count = 0,
    manifest_fingerprint_sha256 = NULL,
    manifest_attempt_token = NULL,
    next_eligible_at = now(),
    safe_error_code = NULL,
    updated_at = now()
WHERE outcome = 'pending';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
), recoverable_operations AS (
  SELECT DISTINCT operation.public_id, operation.knowledge_base_id
  FROM recoverable_jobs recoverable
  JOIN focowiki.publication_job_items membership
    ON membership.job_public_id = recoverable.public_id
  JOIN focowiki.publication_items item
    ON item.public_id = membership.item_public_id
  JOIN focowiki.document_processing_jobs document_job
    ON document_job.public_id = item.document_job_public_id
  JOIN focowiki.operations operation
    ON operation.knowledge_base_id = document_job.knowledge_base_id
   AND operation.public_id = document_job.operation_public_id
  JOIN focowiki.operation_results result
    ON result.knowledge_base_id = operation.knowledge_base_id
   AND result.public_id = operation.public_id
   AND result.result_code = 'publication_navigation_mutations_invalid'
  WHERE operation.state = 'failed'
)
UPDATE focowiki.operations operation
SET state = 'processing', completed_at = NULL, updated_at = now()
FROM recoverable_operations recoverable
WHERE operation.knowledge_base_id = recoverable.knowledge_base_id
  AND operation.public_id = recoverable.public_id;

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
), recoverable_operations AS (
  SELECT DISTINCT operation.public_id, operation.knowledge_base_id
  FROM recoverable_jobs recoverable
  JOIN focowiki.publication_job_items membership
    ON membership.job_public_id = recoverable.public_id
  JOIN focowiki.publication_items item
    ON item.public_id = membership.item_public_id
  JOIN focowiki.document_processing_jobs document_job
    ON document_job.public_id = item.document_job_public_id
  JOIN focowiki.operations operation
    ON operation.knowledge_base_id = document_job.knowledge_base_id
   AND operation.public_id = document_job.operation_public_id
)
DELETE FROM focowiki.operation_results result
USING recoverable_operations recoverable
WHERE result.knowledge_base_id = recoverable.knowledge_base_id
  AND result.public_id = recoverable.public_id
  AND result.result_code = 'publication_navigation_mutations_invalid';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
), recoverable_deletions AS (
  SELECT DISTINCT item.knowledge_base_id,
         item.affected_evidence->>'deletionOperationPublicId'
           AS operation_public_id
  FROM recoverable_jobs recoverable
  JOIN focowiki.publication_job_items membership
    ON membership.job_public_id = recoverable.public_id
  JOIN focowiki.publication_items item
    ON item.public_id = membership.item_public_id
  WHERE item.affected_evidence ? 'deletionOperationPublicId'
)
UPDATE focowiki.cleanup_actions action
SET state = 'retry', attempt_count = greatest(action.attempt_count - 1, 0),
    lease_owner = NULL, lease_expires_at = NULL, safe_error_code = NULL,
    not_before = now(), completed_at = NULL, updated_at = now()
FROM recoverable_deletions recoverable
WHERE action.knowledge_base_id = recoverable.knowledge_base_id
  AND action.operation_public_id = recoverable.operation_public_id
  AND action.action_kind = 'document_resource_deletion'
  AND action.state = 'failed'
  AND action.safe_error_code = 'publication_navigation_mutations_invalid';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
)
UPDATE focowiki.document_artifact_work work
SET state = 'waiting_on_projection', lease_owner = NULL,
    lease_expires_at = NULL, next_eligible_at = now(),
    safe_error_code = NULL, safe_error_message = NULL, retryable = false,
    ended_at = NULL, updated_at = now()
FROM recoverable_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
JOIN focowiki.publication_items item
  ON item.public_id = membership.item_public_id
WHERE item.document_job_public_id = work.document_job_public_id
  AND work.work_kind = 'knowledge_projection'
  AND work.state = 'error'
  AND work.safe_error_code = 'publication_navigation_mutations_invalid';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
)
UPDATE focowiki.document_processing_jobs document_job
SET state = 'processing', active_work_kinds = '{}'::text[],
    blocking_work_kind = 'knowledge_projection', retrying_work_kind = NULL,
    next_attempt_at = NULL, safe_error_code = NULL,
    safe_error_message = NULL, retryable = false,
    failure_count = greatest(document_job.failure_count - 1, 0),
    terminal_at = NULL, revision = document_job.revision + 1,
    updated_at = now()
FROM recoverable_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
JOIN focowiki.publication_items item
  ON item.public_id = membership.item_public_id
WHERE item.document_job_public_id = document_job.public_id
  AND document_job.state = 'error'
  AND document_job.safe_error_code = 'publication_navigation_mutations_invalid';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
)
UPDATE focowiki.publication_items item
SET outcome = 'pending', safe_error_code = NULL, terminal_at = NULL,
    updated_at = now()
FROM recoverable_jobs recoverable
JOIN focowiki.publication_job_items membership
  ON membership.job_public_id = recoverable.public_id
WHERE membership.item_public_id = item.public_id
  AND item.outcome = 'failed'
  AND item.safe_error_code = 'publication_navigation_mutations_invalid';

WITH recoverable_jobs AS (
  SELECT job.public_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
)
DELETE FROM focowiki.publication_job_items membership
USING recoverable_jobs recoverable
WHERE membership.job_public_id = recoverable.public_id;

WITH recoverable_knowledge_bases AS (
  SELECT DISTINCT job.knowledge_base_id
  FROM focowiki.publication_jobs job
  WHERE job.outcome = 'failed'
    AND job.safe_error_code = 'publication_navigation_mutations_invalid'
), pending AS (
  SELECT item.knowledge_base_id, count(*)::integer AS item_count,
         min(item.created_at) AS oldest_at,
         max(item.created_at) AS latest_at,
         max(item.readiness_sequence) AS latest_sequence
  FROM focowiki.publication_items item
  JOIN recoverable_knowledge_bases recoverable
    ON recoverable.knowledge_base_id = item.knowledge_base_id
  WHERE item.outcome = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM focowiki.publication_job_items membership
      WHERE membership.item_public_id = item.public_id
    )
  GROUP BY item.knowledge_base_id
)
UPDATE focowiki.knowledge_base_publication_heads head
SET pending_item_count = coalesce(pending.item_count, 0),
    oldest_pending_at = pending.oldest_at,
    latest_pending_at = pending.latest_at,
    latest_readiness_sequence = greatest(
      head.latest_readiness_sequence,
      coalesce(pending.latest_sequence, head.latest_readiness_sequence)
    ),
    updated_at = now()
FROM recoverable_knowledge_bases recoverable
LEFT JOIN pending ON pending.knowledge_base_id = recoverable.knowledge_base_id
WHERE head.knowledge_base_id = recoverable.knowledge_base_id;

ALTER TABLE focowiki.runtime_generation
    DROP CONSTRAINT runtime_generation_value_check;

UPDATE focowiki.runtime_generation
SET generation = 'storage-vnext-v24-single-job-publication-scale-safety'
WHERE singleton = true
  AND generation = 'storage-vnext-v23-single-job-publication-retry-recovery';

ALTER TABLE focowiki.runtime_generation
    ADD CONSTRAINT runtime_generation_value_check CHECK (
      generation = 'storage-vnext-v24-single-job-publication-scale-safety'
    );
