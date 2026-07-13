import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresHardDeleteRepository } from "../src/db/hard-delete-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("hard delete repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresHardDeleteRepository(sql);
  const knowledgeBaseId = "kb-hard-delete-empty-directory";
  const oldReleaseId = "release-hard-delete-old";
  const activeReleaseId = "release-hard-delete-active";
  const jobId = "worker-job-hard-delete-empty-directory";
  const deletionIntentId = "deletion-intent-empty-directory";
  const knowledgeBasePurgeId = "kb-hard-delete-complete-purge";
  const knowledgeBasePurgeJobId = "worker-job-hard-delete-knowledge-base";

  beforeAll(async () => {
    await cleanupFixture();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Hard delete empty directory')
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES
        ('source-directory-hard-delete-root', ${knowledgeBaseId}, NULL, 'root', 'root', 'root', 1),
        ('source-directory-hard-delete-empty', ${knowledgeBaseId}, 'source-directory-hard-delete-root', 'empty', 'root/empty', 'root/empty', 2)
    `;
    await sql`
      INSERT INTO focowiki.releases (
        id, knowledge_base_id, bundle_root_key, generated_at,
        file_count, manifest_checksum_sha256, catalog_generation
      ) VALUES
        (${oldReleaseId}, ${knowledgeBaseId}, 'bundles/old', now(), 1, 'old', 1),
        (${activeReleaseId}, ${knowledgeBaseId}, 'bundles/active', now(), 1, 'active', 2)
    `;
    await sql`
      INSERT INTO focowiki.release_source_directories (
        release_id, knowledge_base_id, source_directory_id,
        parent_source_directory_id, name, relative_path, path_key, depth, resource_revision
      ) VALUES
        (${oldReleaseId}, ${knowledgeBaseId}, 'source-directory-hard-delete-root', NULL, 'root', 'root', 'root', 1, 1),
        (${oldReleaseId}, ${knowledgeBaseId}, 'source-directory-hard-delete-empty', 'source-directory-hard-delete-root', 'empty', 'root/empty', 'root/empty', 2, 1),
        (${activeReleaseId}, ${knowledgeBaseId}, 'source-directory-hard-delete-root', NULL, 'root', 'root', 'root', 1, 1)
    `;
    await sql`
      INSERT INTO focowiki.bundle_files (
        id, knowledge_base_id, release_id, source_file_id, file_kind,
        logical_path, object_key, content_type, size_bytes, checksum_sha256,
        navigation_only, source_directory_id
      ) VALUES
        ('bundle-hard-delete-old-directory', ${knowledgeBaseId}, ${oldReleaseId}, NULL,
          'directory_index', 'pages/root/empty/index.md', 'bundles/old/pages/root/empty/index.md',
          'text/markdown; charset=utf-8', 10, 'old-directory', true, 'source-directory-hard-delete-empty'),
        ('bundle-hard-delete-active-root', ${knowledgeBaseId}, ${activeReleaseId}, NULL,
          'directory_index', 'pages/root/index.md', 'bundles/active/pages/root/index.md',
          'text/markdown; charset=utf-8', 10, 'active-root', true, 'source-directory-hard-delete-root')
    `;
    await sql`
      INSERT INTO focowiki.release_markdown_links (
        release_id, knowledge_base_id, from_path, to_path, label, navigation_only
      ) VALUES (
        ${oldReleaseId}, ${knowledgeBaseId}, 'pages/root/index.md',
        'pages/root/empty/index.md', 'Empty', true
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_release_id = ${activeReleaseId}, catalog_generation = 2
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.deletion_intents (
        id, knowledge_base_id, target_kind, target_id, catalog_generation, state
      ) VALUES (
        ${deletionIntentId}, ${knowledgeBaseId}, 'source_directory',
        'source-directory-hard-delete-empty', 2, 'running'
      )
    `;
    await sql`
      UPDATE focowiki.source_directories
      SET deletion_intent_id = ${deletionIntentId}, deleted_at = now()
      WHERE id = 'source-directory-hard-delete-empty'
    `;
    await sql`
      INSERT INTO focowiki.worker_jobs (
        id, kind, status, knowledge_base_id, payload_json
      ) VALUES (
        ${jobId}, 'hard_delete', 'running', ${knowledgeBaseId},
        ${sql.json({
          targetKind: "source_directory",
          sourceDirectoryId: "source-directory-hard-delete-empty",
          deletionIntentId
        })}
      )
    `;
  });

  afterAll(async () => {
    await cleanupFixture();
    await cleanupKnowledgeBaseFixture();
    await sql.end({ timeout: 5 });
  });

  it("tracks and purges obsolete releases for an empty deleted directory", async () => {
    await repository.prepareSourceDirectoryObjectDeletions({
      jobId,
      knowledgeBaseId,
      deletionIntentId
    });
    await expect(repository.listPendingObjectKeys({ jobId, limit: 10 })).resolves.toEqual([
      "bundles/old/pages/root/empty/index.md"
    ]);

    await repository.markObjectKeysDeleted({
      jobId,
      objectKeys: ["bundles/old/pages/root/empty/index.md"],
      deletedAt: new Date().toISOString()
    });
    await repository.purgeSourceDirectoryReleaseData({
      jobId,
      knowledgeBaseId,
      deletionIntentId,
      batchSize: 1
    });
    await repository.clearObjectDeletionTracking({ jobId, batchSize: 1 });
    await repository.completeSourceDirectoryDeletion({
      knowledgeBaseId,
      deletionIntentId,
      completedAt: new Date().toISOString()
    });

    const remaining = await sql<Array<{
      old_release_count: number;
      directory_count: number;
      old_link_count: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.releases WHERE id = ${oldReleaseId}) AS old_release_count,
        (SELECT count(*)::int FROM focowiki.source_directories
          WHERE id = 'source-directory-hard-delete-empty') AS directory_count,
        (SELECT count(*)::int FROM focowiki.release_markdown_links
          WHERE release_id = ${oldReleaseId}) AS old_link_count
    `;
    expect(remaining).toEqual([{ old_release_count: 0, directory_count: 0, old_link_count: 0 }]);
    const activeObjects = await sql<Array<{ object_key: string }>>`
      SELECT object_key FROM focowiki.bundle_files WHERE release_id = ${activeReleaseId}
    `;
    expect(activeObjects).toEqual([{ object_key: "bundles/active/pages/root/index.md" }]);
    const objectTracking = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.hard_delete_object_deletions
      WHERE job_id = ${jobId}
    `;
    expect(objectTracking).toEqual([{ count: 0 }]);
  });

  it("purges all rebuilt knowledge-base resources by knowledge-base ID", async () => {
    await cleanupKnowledgeBaseFixture();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBasePurgeId}, 'Complete knowledge-base purge')
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES (
        'source-directory-complete-purge', ${knowledgeBasePurgeId}, NULL,
        'docs', 'docs', 'docs', 1
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES (
          'source-file-complete-purge', ${knowledgeBasePurgeId}, 'guide.md',
          'docs/guide.md', 'docs/guide.md', 'source-directory-complete-purge',
          'sources/complete-purge.md', 'text/markdown', 10, 'source-complete-purge',
          'source-revision-complete-purge'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES (
          'source-revision-complete-purge', ${knowledgeBasePurgeId},
          'source-file-complete-purge', 1, 'sources/complete-purge.md',
          'text/markdown', 10, 'source-complete-purge'
        )
      `;
    });
    await sql`
      INSERT INTO focowiki.upload_sessions (
        id, knowledge_base_id, idempotency_key, declared_file_count,
        declared_byte_count, expires_at
      ) VALUES (
        'upload-session-complete-purge', ${knowledgeBasePurgeId}, 'purge-session',
        1, 10, now() + interval '1 hour'
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_session_entries (
        id, session_id, knowledge_base_id, sequence_number, relative_path,
        path_key, directory_path, name, declared_size, checksum_sha256,
        generated_path, source_directory_id, source_file_id
      ) VALUES (
        'upload-entry-complete-purge', 'upload-session-complete-purge',
        ${knowledgeBasePurgeId}, 1, 'docs/guide.md', 'docs/guide.md', 'docs',
        'guide.md', 10, 'source-complete-purge', 'pages/docs/guide.md',
        'source-directory-complete-purge', 'source-file-complete-purge'
      )
    `;
    await sql`
      INSERT INTO focowiki.releases (
        id, knowledge_base_id, bundle_root_key, generated_at,
        file_count, manifest_checksum_sha256, catalog_generation
      ) VALUES (
        'release-complete-purge', ${knowledgeBasePurgeId}, 'bundles/complete-purge',
        now(), 1, 'release-complete-purge', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.release_source_directories (
        release_id, knowledge_base_id, source_directory_id,
        parent_source_directory_id, name, relative_path, path_key, depth, resource_revision
      ) VALUES (
        'release-complete-purge', ${knowledgeBasePurgeId},
        'source-directory-complete-purge', NULL, 'docs', 'docs', 'docs', 1, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.release_source_files (
        release_id, knowledge_base_id, source_file_id, source_revision_id,
        source_directory_id, name, relative_path, path_key, generated_path,
        object_key, content_type, size_bytes, checksum_sha256,
        resource_revision, content_revision
      ) VALUES (
        'release-complete-purge', ${knowledgeBasePurgeId},
        'source-file-complete-purge', 'source-revision-complete-purge',
        'source-directory-complete-purge', 'guide.md', 'docs/guide.md',
        'docs/guide.md', 'pages/docs/guide.md', 'sources/complete-purge.md',
        'text/markdown', 10, 'source-complete-purge', 1, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.bundle_files (
        id, knowledge_base_id, release_id, source_file_id, file_kind,
        logical_path, object_key, content_type, size_bytes, checksum_sha256,
        source_directory_id
      ) VALUES (
        'bundle-file-complete-purge', ${knowledgeBasePurgeId},
        'release-complete-purge', 'source-file-complete-purge', 'page',
        'pages/docs/guide.md', 'bundles/complete-purge/pages/docs/guide.md',
        'text/markdown', 10, 'bundle-complete-purge', 'source-directory-complete-purge'
      )
    `;
    await sql`
      INSERT INTO focowiki.release_markdown_links (
        release_id, knowledge_base_id, source_file_id,
        from_path, to_path, label, navigation_only
      ) VALUES (
        'release-complete-purge', ${knowledgeBasePurgeId}, 'source-file-complete-purge',
        'pages/docs/guide.md', 'pages/docs/guide.md', 'Guide', false
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_release_id = 'release-complete-purge', catalog_generation = 1
      WHERE id = ${knowledgeBasePurgeId}
    `;
    await sql`
      INSERT INTO focowiki.worker_jobs (
        id, kind, status, knowledge_base_id, payload_json
      ) VALUES (
        ${knowledgeBasePurgeJobId}, 'hard_delete', 'running', ${knowledgeBasePurgeId},
        ${sql.json({ targetKind: "knowledge_base" })}
      )
    `;

    await repository.purgeKnowledgeBaseData({
      jobId: knowledgeBasePurgeJobId,
      knowledgeBaseId: knowledgeBasePurgeId,
      batchSize: 1
    });

    const remaining = await sql<Array<{
      knowledge_bases: number;
      source_directories: number;
      source_files: number;
      source_revisions: number;
      upload_sessions: number;
      release_snapshots: number;
      releases: number;
      markdown_links: number;
      bundle_files: number;
      worker_jobs: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.knowledge_bases WHERE id = ${knowledgeBasePurgeId}) AS knowledge_bases,
        (SELECT count(*)::int FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS source_directories,
        (SELECT count(*)::int FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS source_files,
        (SELECT count(*)::int FROM focowiki.source_revisions WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS source_revisions,
        (SELECT count(*)::int FROM focowiki.upload_sessions WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS upload_sessions,
        (SELECT count(*)::int FROM focowiki.release_source_files WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS release_snapshots,
        (SELECT count(*)::int FROM focowiki.releases WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS releases,
        (SELECT count(*)::int FROM focowiki.release_markdown_links WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS markdown_links,
        (SELECT count(*)::int FROM focowiki.bundle_files WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS bundle_files,
        (SELECT count(*)::int FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBasePurgeId}) AS worker_jobs
    `;
    expect(remaining).toEqual([{
      knowledge_bases: 0,
      source_directories: 0,
      source_files: 0,
      source_revisions: 0,
      upload_sessions: 0,
      release_snapshots: 0,
      releases: 0,
      markdown_links: 0,
      bundle_files: 0,
      worker_jobs: 0
    }]);
  });

  async function cleanupFixture(): Promise<void> {
    await sql`UPDATE focowiki.knowledge_bases SET active_release_id = NULL WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.hard_delete_object_deletions WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.bundle_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.releases WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }

  async function cleanupKnowledgeBaseFixture(): Promise<void> {
    await sql`UPDATE focowiki.knowledge_bases SET active_release_id = NULL WHERE id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.hard_delete_object_deletions WHERE knowledge_base_id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.bundle_files WHERE knowledge_base_id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.releases WHERE knowledge_base_id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.upload_sessions WHERE knowledge_base_id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBasePurgeId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBasePurgeId}`;
  }
});
