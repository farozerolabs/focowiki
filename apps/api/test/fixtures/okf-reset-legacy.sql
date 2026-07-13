BEGIN;
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO focowiki.knowledge_bases (id, name)
VALUES ('kb-reset-test', 'Reset test');

INSERT INTO focowiki.source_files (
  id,
  knowledge_base_id,
  object_key,
  content_type,
  size_bytes,
  checksum_sha256,
  metadata_json,
  processing_status,
  processing_stage,
  generated_output_status,
  generated_bundle_file_id,
  generated_bundle_file_path,
  name,
  relative_path,
  path_key,
  active_revision_id
) VALUES (
  'source-reset-test',
  'kb-reset-test',
  'sources/retained.md',
  'text/markdown',
  12,
  'source-checksum',
  '{"title":"Retained"}'::jsonb,
  'completed',
  'release_activation',
  'visible',
  'bundle-reset-test',
  'pages/retained.md',
  'retained.md',
  'retained.md',
  'retained.md',
  'revision-reset-test'
);

INSERT INTO focowiki.source_revisions (
  id,
  knowledge_base_id,
  source_file_id,
  revision,
  object_key,
  content_type,
  size_bytes,
  checksum_sha256,
  metadata_json,
  processing_status
) VALUES (
  'revision-reset-test',
  'kb-reset-test',
  'source-reset-test',
  1,
  'sources/revisions/retained.md',
  'text/markdown',
  12,
  'revision-checksum',
  '{"title":"Retained"}'::jsonb,
  'completed'
);

INSERT INTO focowiki.source_file_events (
  id,
  knowledge_base_id,
  source_file_id,
  stage_key,
  message_key,
  started_at,
  ended_at,
  severity
) VALUES (
  'event-reset-test',
  'kb-reset-test',
  'source-reset-test',
  'release_activation',
  'source_file.processing.completed',
  now(),
  now(),
  'info'
);

INSERT INTO focowiki.releases (
  id,
  knowledge_base_id,
  bundle_root_key,
  generated_at,
  published_at,
  file_count,
  manifest_checksum_sha256
) VALUES (
  'release-reset-test',
  'kb-reset-test',
  'generated/releases/reset/',
  now(),
  now(),
  1,
  'manifest-checksum'
);

INSERT INTO focowiki.bundle_files (
  id,
  knowledge_base_id,
  release_id,
  source_file_id,
  file_kind,
  logical_path,
  object_key,
  content_type,
  size_bytes,
  checksum_sha256,
  okf_type,
  title
) VALUES (
  'bundle-reset-test',
  'kb-reset-test',
  'release-reset-test',
  'source-reset-test',
  'page',
  'pages/retained.md',
  'generated/releases/reset/pages/retained.md',
  'text/markdown',
  12,
  'bundle-checksum',
  'page',
  'Retained'
);

UPDATE focowiki.knowledge_bases
SET active_release_id = 'release-reset-test'
WHERE id = 'kb-reset-test';

INSERT INTO focowiki.publication_jobs (
  id,
  knowledge_base_id,
  mode,
  reason,
  status,
  release_id,
  started_at
) VALUES (
  'publication-reset-test',
  'kb-reset-test',
  'manual',
  'manual',
  'running',
  'release-reset-test',
  now()
);

INSERT INTO focowiki.worker_jobs (
  id,
  kind,
  status,
  knowledge_base_id,
  payload_json,
  started_at,
  locked_by,
  locked_at
) VALUES (
  'worker-publication-reset-test',
  'publication',
  'running',
  'kb-reset-test',
  '{}'::jsonb,
  now(),
  'legacy-worker',
  now()
);

COMMIT;
