import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresProjectionScopeOutputRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-output-repository.js";
import { releasePostgresProjectionScopeOutputsForDocument } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-output-release.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../src/storage-vnext/ownership/postgres-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("projection output object lifecycle", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_projection_object_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    const objectId = `generated-sha256:okf-generated-markdown-v1:${
      "a".repeat(64)}`;
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('lifecycle-kb', 'Lifecycle', 1)
    `;
    await sql`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until
      ) VALUES (
        'lifecycle-scope', 'lifecycle-kb', 'root', 'root',
        1, 1, 'completed', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at,
        zero_owner_since
      ) VALUES (
        ${objectId},
        'generated/lifecycle.md', ${"a".repeat(64)}, 32,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', 'lifecycle-write', '2026-08-20T00:00:00.000Z',
        '2026-08-20T00:00:00.000Z'
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("protects verified page objects until their exact output is released", async () => {
    const objectId = `generated-sha256:okf-generated-markdown-v1:${
      "a".repeat(64)}`;
    const outputs = createPostgresProjectionScopeOutputRepository(
      sql as unknown as DatabaseClient
    );
    const ownership = createPostgresStorageVnextOwnershipRepository(
      sql as unknown as DatabaseClient,
      { zeroOwnerGraceMilliseconds: 1 }
    );
    await outputs.persist({
      scopePublicId: "lifecycle-scope",
      renderedSequence: 1,
      knowledgeBaseId: "lifecycle-kb",
      outputFingerprintSha256: "b".repeat(64),
      pages: [{
        logicalPath: "index.md",
        normalizedPath: "index.md",
        entryKind: "root-index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId,
        checksumSha256: "a".repeat(64),
        byteCount: 32
      }],
      removedNormalizedPaths: [],
      navigationMutations: [],
      activationOwnerVersions: [],
      createdAt: "2026-08-20T00:00:01.000Z"
    });

    await expect(ownership.listZeroOwnerObjects({
      graceElapsedBefore: "2026-08-21T00:00:00.000Z",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({ items: [] });
    await expect(ownership.markDeleting(objectId))
      .rejects.toMatchObject({ code: "owners_present" });

    await sql`
      DELETE FROM focowiki.projection_scope_outputs
      WHERE scope_public_id = 'lifecycle-scope' AND rendered_sequence = 1
    `;
    await expect(ownership.markDeleting(objectId)).resolves.toBeUndefined();
  });

  it("releases terminal output references and queues newly unowned objects", async () => {
    const objectId = `generated-sha256:okf-generated-markdown-v1:${
      "c".repeat(64)}`;
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id, completed_at
        ) VALUES (
          'lifecycle-operation', 'lifecycle-kb', 'source_upload', 'completed',
          'source_file', 'lifecycle-source', now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.document_processing_jobs (
          public_id, knowledge_base_id, operation_public_id,
          source_file_public_id, source_revision_public_id,
          runtime_settings_revision_public_id,
          generation_model_configuration_public_id,
          generation_model_configuration_revision,
          embedding_configuration_revision_public_id,
          semantic_generation_public_id, semantic_contract_version,
          state, maximum_attempts, accepted_at, started_at, terminal_at
        ) VALUES (
          'lifecycle-job', 'lifecycle-kb', 'lifecycle-operation',
          'lifecycle-source', 'lifecycle-revision', 'settings', 'model', 1,
          'embedding', 'semantic', 'contract', 'available', 3,
          now(), now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.projection_dirty_scopes (
          public_id, knowledge_base_id, scope_kind, scope_key,
          required_sequence, completed_sequence, state, next_eligible_at,
          coalesce_until
        ) VALUES (
          'release-scope', 'lifecycle-kb', 'root', 'release-root',
          1, 1, 'completed', now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at,
          zero_owner_since
        ) VALUES (
          ${objectId}, 'generated/release.md', ${"c".repeat(64)}, 48,
          'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
          'verified', 'release-write', now(), now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.projection_scope_contributions (
          public_id, knowledge_base_id, source_file_public_id,
          source_revision_public_id, document_job_public_id,
          scope_public_id, required_sequence, state, acknowledged_at
        ) VALUES (
          'release-contribution', 'lifecycle-kb', 'lifecycle-source',
          'lifecycle-revision', 'lifecycle-job', 'release-scope', 1,
          'acknowledged', now()
        )
      `;
    });
    const outputs = createPostgresProjectionScopeOutputRepository(
      sql as unknown as DatabaseClient
    );
    await outputs.persist({
      scopePublicId: "release-scope",
      renderedSequence: 1,
      knowledgeBaseId: "lifecycle-kb",
      outputFingerprintSha256: "d".repeat(64),
      pages: [{
        logicalPath: "release.md",
        normalizedPath: "release.md",
        entryKind: "root-index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId,
        checksumSha256: "c".repeat(64),
        byteCount: 48
      }],
      removedNormalizedPaths: [],
      navigationMutations: [],
      activationOwnerVersions: [],
      createdAt: "2026-08-20T00:00:02.000Z"
    });
    await sql`
      INSERT INTO focowiki.projection_scope_receipts (
        contribution_public_id, scope_public_id, rendered_sequence,
        output_fingerprint_sha256
      ) VALUES (
        'release-contribution', 'release-scope', 1, ${"d".repeat(64)}
      )
    `;

    await expect(releasePostgresProjectionScopeOutputsForDocument({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "lifecycle-kb",
      documentJobPublicId: "lifecycle-job",
      releasedAt: "2026-08-20T00:00:03.000Z"
    })).resolves.toEqual({ releasedOutputCount: 1, queuedObjectCount: 1 });
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
      FROM focowiki.projection_scope_object_refs
      WHERE object_id = ${objectId}
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql<Array<{ state: string; zero_owner_since: Date | null }>>`
      SELECT state, zero_owner_since
      FROM focowiki.object_registrations WHERE object_id = ${objectId}
    `).resolves.toEqual([{
      state: "verified",
      zero_owner_since: new Date("2026-08-20T00:00:03.000Z")
    }]);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.cleanup_actions
      WHERE resource_public_id = ${objectId}
    `).resolves.toEqual([{ state: "queued" }]);
  });

  it("atomically replaces an exact output whose page object is no longer verified",
    async () => {
      const staleObjectId = `generated-sha256:okf-generated-markdown-v1:${
        "e".repeat(64)}`;
      const replacementObjectId = `generated-sha256:okf-generated-markdown-v1:${
        "f".repeat(64)}`;
      await sql`
        INSERT INTO focowiki.projection_dirty_scopes (
          public_id, knowledge_base_id, scope_kind, scope_key,
          required_sequence, completed_sequence, state, next_eligible_at,
          coalesce_until
        ) VALUES (
          'invalid-exact-scope', 'lifecycle-kb', 'root', 'invalid-exact',
          1, 0, 'waiting', now(), now()
        )
      `;
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${staleObjectId}, 'generated/stale.md', ${"e".repeat(64)}, 32,
          'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
          'deleted', 'stale-write', now()
        ), (
          ${replacementObjectId}, 'generated/replacement.md',
          ${"f".repeat(64)}, 48, 'text/markdown; charset=utf-8',
          'okf-generated-markdown-v1', 'verified', 'replacement-write', now()
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_scope_outputs (
          scope_public_id, rendered_sequence, knowledge_base_id,
          output_fingerprint_sha256, pages, removed_normalized_paths,
          navigation_mutations, activation_owner_versions
        ) VALUES (
          'invalid-exact-scope', 1, 'lifecycle-kb', ${"1".repeat(64)},
          ${sql.json([page(staleObjectId, "e".repeat(64), 32)] as never)},
          ARRAY[]::text[], '[]'::jsonb, '[]'::jsonb
        )
      `;
      const outputs = createPostgresProjectionScopeOutputRepository(
        sql as unknown as DatabaseClient
      );

      await expect(outputs.persist({
        scopePublicId: "invalid-exact-scope",
        renderedSequence: 1,
        knowledgeBaseId: "lifecycle-kb",
        outputFingerprintSha256: "2".repeat(64),
        pages: [page(replacementObjectId, "f".repeat(64), 48)],
        removedNormalizedPaths: [],
        navigationMutations: [],
        activationOwnerVersions: [],
        createdAt: "2026-08-21T00:00:00.000Z"
      })).resolves.toBeUndefined();
      await expect(outputs.read({
        scopePublicId: "invalid-exact-scope",
        renderedSequence: 1
      })).resolves.toMatchObject({
        outputFingerprintSha256: "2".repeat(64),
        pages: [expect.objectContaining({ objectId: replacementObjectId })]
      });
    });

  it("rejects a different replacement while the exact output remains usable",
    async () => {
      const firstObjectId = `generated-sha256:okf-generated-markdown-v1:${
        "1".repeat(64)}`;
      const secondObjectId = `generated-sha256:okf-generated-markdown-v1:${
        "2".repeat(64)}`;
      await sql`
        INSERT INTO focowiki.projection_dirty_scopes (
          public_id, knowledge_base_id, scope_kind, scope_key,
          required_sequence, completed_sequence, state, next_eligible_at,
          coalesce_until
        ) VALUES (
          'valid-exact-scope', 'lifecycle-kb', 'root', 'valid-exact',
          1, 0, 'waiting', now(), now()
        )
      `;
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${firstObjectId}, 'generated/first.md', ${"1".repeat(64)}, 32,
          'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
          'verified', 'first-valid-write', now()
        ), (
          ${secondObjectId}, 'generated/second.md', ${"2".repeat(64)}, 48,
          'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
          'verified', 'second-valid-write', now()
        )
      `;
      const outputs = createPostgresProjectionScopeOutputRepository(
        sql as unknown as DatabaseClient
      );
      await outputs.persist({
        scopePublicId: "valid-exact-scope",
        renderedSequence: 1,
        knowledgeBaseId: "lifecycle-kb",
        outputFingerprintSha256: "3".repeat(64),
        pages: [page(firstObjectId, "1".repeat(64), 32)],
        removedNormalizedPaths: [],
        navigationMutations: [],
        activationOwnerVersions: [],
        createdAt: "2026-08-21T00:00:01.000Z"
      });

      await expect(outputs.persist({
        scopePublicId: "valid-exact-scope",
        renderedSequence: 1,
        knowledgeBaseId: "lifecycle-kb",
        outputFingerprintSha256: "4".repeat(64),
        pages: [page(secondObjectId, "2".repeat(64), 48)],
        removedNormalizedPaths: [],
        navigationMutations: [],
        activationOwnerVersions: [],
        createdAt: "2026-08-21T00:00:02.000Z"
      })).rejects.toMatchObject({ code: "projection_scope_output_conflict" });
    });
});

function page(objectId: string, checksumSha256: string, byteCount: number) {
  return {
    logicalPath: "index.md",
    normalizedPath: "index.md",
    entryKind: "root-index" as const,
    sourceFilePublicId: null,
    sourceRevisionPublicId: null,
    objectId,
    checksumSha256,
    byteCount
  };
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
