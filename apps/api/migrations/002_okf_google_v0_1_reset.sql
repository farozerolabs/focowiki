CREATE TABLE focowiki.generated_output_resets (
    knowledge_base_id text PRIMARY KEY REFERENCES focowiki.knowledge_bases(id) ON DELETE CASCADE,
    state text DEFAULT 'pending' NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_output_resets_state_check CHECK (
      state = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])
    ),
    CONSTRAINT generated_output_resets_attempt_count_check CHECK (attempt_count >= 0)
);

CREATE TABLE focowiki.generated_output_reset_prefixes (
    knowledge_base_id text NOT NULL REFERENCES focowiki.generated_output_resets(knowledge_base_id) ON DELETE CASCADE,
    prefix text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (knowledge_base_id, prefix)
);

CREATE INDEX generated_output_resets_pending_idx
ON focowiki.generated_output_resets (updated_at, knowledge_base_id)
WHERE state IN ('pending', 'running', 'failed');

CREATE INDEX generated_output_reset_prefixes_pending_idx
ON focowiki.generated_output_reset_prefixes (knowledge_base_id, prefix)
WHERE deleted_at IS NULL;

ALTER TABLE focowiki.worker_jobs
DROP CONSTRAINT worker_jobs_kind_check;

ALTER TABLE focowiki.worker_jobs
ADD CONSTRAINT worker_jobs_kind_check CHECK (
  kind = ANY (ARRAY[
    'upload_session_finalization'::text,
    'source_file_processing'::text,
    'resource_operation'::text,
    'publication'::text,
    'hard_delete'::text,
    'generated_output_reset'::text
  ])
);

ALTER TABLE focowiki.worker_queue_summaries
DROP CONSTRAINT worker_queue_summaries_kind_check;

ALTER TABLE focowiki.worker_queue_summaries
ADD CONSTRAINT worker_queue_summaries_kind_check CHECK (
  kind = ANY (ARRAY[
    'upload_session_finalization'::text,
    'source_file_processing'::text,
    'resource_operation'::text,
    'publication'::text,
    'hard_delete'::text,
    'generated_output_reset'::text
  ])
);

INSERT INTO focowiki.generated_output_resets (knowledge_base_id)
SELECT id
FROM focowiki.knowledge_bases
WHERE deleted_at IS NULL;

INSERT INTO focowiki.generated_output_reset_prefixes (knowledge_base_id, prefix)
SELECT release.knowledge_base_id, release.bundle_root_key
FROM focowiki.releases release
JOIN focowiki.generated_output_resets reset
  ON reset.knowledge_base_id = release.knowledge_base_id
ON CONFLICT (knowledge_base_id, prefix) DO NOTHING;

UPDATE focowiki.worker_jobs
SET status = 'cancelled',
    locked_by = NULL,
    locked_at = NULL,
    heartbeat_at = NULL,
    completed_at = now(),
    last_error_code = 'GENERATED_OUTPUT_RESET',
    last_error_message = 'Legacy publication work was replaced by the canonical OKF rebuild.',
    updated_at = now()
WHERE kind = 'publication'
  AND status IN ('queued', 'running');

UPDATE focowiki.publication_jobs
SET status = 'failed',
    release_id = NULL,
    ended_at = now(),
    error_code = 'GENERATED_OUTPUT_RESET',
    error_message = 'Legacy publication output was reset for canonical regeneration.',
    updated_at = now()
WHERE status IN ('queued', 'running');

UPDATE focowiki.publication_jobs
SET release_id = NULL,
    updated_at = now()
WHERE release_id IS NOT NULL;

UPDATE focowiki.knowledge_bases
SET active_release_id = NULL,
    updated_at = now()
WHERE deleted_at IS NULL;

UPDATE focowiki.source_files
SET generated_output_status = 'pending',
    generated_bundle_file_id = NULL,
    generated_bundle_file_path = NULL,
    publication_dirty_at = now(),
    publication_visible_at = NULL,
    publication_error_code = NULL,
    publication_error_message = NULL
WHERE deleted_at IS NULL
  AND task_deleted_at IS NULL
  AND processing_status = 'completed';

DELETE FROM focowiki.bundle_files;
DELETE FROM focowiki.releases;

INSERT INTO focowiki.worker_jobs (
  id,
  kind,
  knowledge_base_id,
  source_file_id,
  payload_json,
  run_after,
  max_attempts
)
SELECT
  'worker-job-okf-reset-' || md5(reset.knowledge_base_id),
  'generated_output_reset',
  reset.knowledge_base_id,
  NULL,
  jsonb_build_object('reason', 'okf_google_v0_1_reset'),
  now(),
  3
FROM focowiki.generated_output_resets reset
ON CONFLICT (id) DO NOTHING;

UPDATE focowiki.runtime_generation
SET generation = 'okf-google-v0-1-v4'
WHERE singleton = true;
