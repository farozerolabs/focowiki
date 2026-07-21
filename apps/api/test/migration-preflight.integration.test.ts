import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectMigrationWork } from "../src/db/migration-preflight.js";
import { applyMigrations } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("migration preflight integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_preflight_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 3 });
  const knowledgeBaseId = "kb-migration-preflight";
  const sourceFileId = "source-file-migration-preflight";
  const revisionId = "source-revision-migration-preflight";
  const generationId = "generation-migration-preflight";

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("reports every supported unfinished work class without record details", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedAllUnfinishedWork();
    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot).toMatchObject({
      sourceFiles: baseline.sourceFiles + 1,
      dispatchMarkers: baseline.dispatchMarkers + 1,
      roleJobs: baseline.roleJobs + 1,
      publicationImpacts: baseline.publicationImpacts + 1,
      frozenGenerations: baseline.frozenGenerations + 1,
      resourceOperations: baseline.resourceOperations + 1,
      deletionIntents: baseline.deletionIntents + 1,
      uploadSessions: baseline.uploadSessions + 1,
      cleanupObjects: baseline.cleanupObjects + 1
    });
  });

  async function seedAllUnfinishedWork(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'Migration preflight')
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'sources/preflight.md',
          'text/markdown; charset=utf-8', 12, ${"c".repeat(64)},
          'queued', 'upload_storage', 'pending', 'preflight.md',
          'preflight.md', 'preflight.md', ${revisionId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'sources/preflight.md', 'text/markdown; charset=utf-8', 12,
          ${"c".repeat(64)}, 'queued'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_dispatch_markers (
          id, knowledge_base_id, source_file_id, source_revision_id, status
        ) VALUES (
          'dispatch-migration-preflight', ${knowledgeBaseId}, ${sourceFileId},
          ${revisionId}, 'pending'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version
        ) VALUES (${generationId}, ${knowledgeBaseId}, 'frozen', 2)
      `;
      await transaction`
        INSERT INTO focowiki.role_jobs (
          id, role, kind, knowledge_base_id, source_file_id,
          source_revision_id, status
        ) VALUES (
          'role-job-migration-preflight', 'source', 'source_processing',
          ${knowledgeBaseId}, ${sourceFileId}, ${revisionId}, 'queued'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_change_facts (
          id, knowledge_base_id, source_file_id, source_revision_id,
          generation_id, kind, resource_revision, path
        ) VALUES (
          'fact-migration-preflight', ${knowledgeBaseId}, ${sourceFileId},
          ${revisionId}, ${generationId}, 'source_created', 1, 'preflight.md'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_impacts (
          id, knowledge_base_id, generation_id, projection_kind,
          projection_key, record_identity, action, status
        ) VALUES (
          'impact-migration-preflight', ${knowledgeBaseId}, ${generationId},
          'search', 'search/v2/preflight', ${sourceFileId}, 'upsert', 'pending'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
        VALUES ('impact-migration-preflight', 'fact-migration-preflight')
      `;
      await transaction`
        INSERT INTO focowiki.resource_operations (
          id, knowledge_base_id, operation_kind, state, idempotency_key,
          request_fingerprint, candidate_catalog_generation
        ) VALUES (
          'operation-migration-preflight', ${knowledgeBaseId},
          'source_file_move', 'processing', 'migration-preflight',
          ${"d".repeat(64)}, 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id,
          catalog_generation, state
        ) VALUES (
          'deletion-migration-preflight', ${knowledgeBaseId}, 'source_file',
          ${sourceFileId}, 1, 'accepted'
        )
      `;
      await transaction`
        INSERT INTO focowiki.upload_sessions (
          id, knowledge_base_id, state, idempotency_key,
          declared_file_count, declared_byte_count, expires_at
        ) VALUES (
          'upload-session-migration-preflight', ${knowledgeBaseId}, 'draft',
          'migration-preflight', 1, 12, now() + interval '1 hour'
        )
      `;
      await transaction`
        INSERT INTO focowiki.cleanup_object_deletions (
          job_id, knowledge_base_id, object_key, status
        ) VALUES (
          'cleanup-migration-preflight', ${knowledgeBaseId},
          'generated/preflight.json', 'pending'
        )
      `;
    });
  }

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM focowiki.cleanup_object_deletions
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
