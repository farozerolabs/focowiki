import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentPublicationCutoverPreflight } from
  "../src/document-indexing/infrastructure/postgres-document-publication-cutover-preflight.js";
import { createPostgresDocumentPublicationShadowMigration } from
  "../src/document-indexing/infrastructure/postgres-document-publication-shadow-migration.js";
import { createPostgresDocumentPublicationShadowParity } from
  "../src/document-indexing/infrastructure/postgres-document-publication-shadow-parity.js";
import { createPostgresProjectionDirtyScopeRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-dirty-scope-repository.js";
import { createPostgresDocumentPublicationCutover } from
  "../src/document-indexing/infrastructure/postgres-document-publication-cutover.js";
import { createProductionDocumentPublicationCutoverRuntime } from
  "../src/document-indexing/infrastructure/production-document-publication-cutover-runtime.js";
import { createPostgresDocumentProjectionLegacyCleanup } from
  "../src/document-indexing/infrastructure/postgres-document-projection-legacy-cleanup.js";
import {
  MIGRATION_FILES,
  RUNTIME_SCHEMA_GENERATION,
  applyMigrations,
  preflightMigrations,
  readMigrationSql
} from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document publication migration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_publication_migration_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  });

  it("upgrades released schema, recovers transaction interruption, and repeats",
    async () => {
      const publicationFoundationIndex = MIGRATION_FILES.indexOf(
        "006_projection_publication_foundation.sql"
      );
      const releasedFiles = MIGRATION_FILES.slice(0, publicationFoundationIndex);
      await sql.begin(async (transaction) => {
        for (const file of releasedFiles) {
          await transaction.unsafe(readMigrationSql(file));
        }
      });
      await expect(preflightMigrations(database)).resolves.toEqual({
        currentGeneration: "storage-vnext-v13-clean-document-indexing",
        pendingFiles: [
          "006_projection_publication_foundation.sql",
          "007_projection_legacy_cleanup_gate.sql",
          "008_projection_navigation_capacity.sql",
          "009_projection_resource_recovery.sql",
          "010_projection_large_directory_deltas.sql",
          "011_projection_delta_lease_safety.sql"
        ]
      });
      await expect(sql.begin(async (transaction) => {
        await transaction.unsafe(readMigrationSql(
          "006_projection_publication_foundation.sql"
        ));
        throw new Error("INJECTED_MIGRATION_INTERRUPTION");
      })).rejects.toThrow("INJECTED_MIGRATION_INTERRUPTION");
      await expect(preflightMigrations(database)).resolves.toMatchObject({
        currentGeneration: "storage-vnext-v13-clean-document-indexing"
      });
      await expect(applyMigrations(database)).resolves.toBeUndefined();
      await expect(applyMigrations(database)).resolves.toBeUndefined();
      await expect(preflightMigrations(database)).resolves.toEqual({
        currentGeneration: RUNTIME_SCHEMA_GENERATION,
        pendingFiles: []
      });
    }, 120_000);

  it("enumerates active legacy paths and cutover eligibility without writes",
    async () => {
      await sql`
        INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
        VALUES ('preflight-kb', 'Preflight', 1)
      `;
      for (const [index, path] of ["index.md", "pages/guides/index.md"]
        .entries()) {
        const objectId = `preflight-object-${index}`;
        const checksum = String(index + 1).repeat(64);
        await sql`
          INSERT INTO focowiki.object_registrations (
            object_id, storage_key, checksum_sha256, byte_count,
            content_type, object_format, state, write_attempt_public_id,
            verified_at
          ) VALUES (
            ${objectId}, ${`objects/${objectId}`}, ${checksum}, 10,
            'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
            'verified', ${`${objectId}-attempt`},
            '2026-08-21T12:00:00.000Z'
          )
        `;
        await sql`
          INSERT INTO focowiki.generated_page_heads (
            knowledge_base_id, logical_path, normalized_path, entry_kind,
            source_file_public_id, source_revision_public_id,
            page_candidate_public_id, object_id, checksum_sha256,
            byte_count, activation_revision
          ) VALUES (
            'preflight-kb', ${path}, ${path}, 'navigation', NULL, NULL,
            NULL, ${objectId}, ${checksum}, 10, 1
          )
        `;
      }
      const preflight = createPostgresDocumentPublicationCutoverPreflight(
        database
      );
      const first = await preflight.inspect({
        knowledgeBaseId: "preflight-kb", cursor: null, limit: 1
      });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBe("index.md");
      expect(first.summary).toMatchObject({
        activePathCount: 2,
        ownerCandidateCount: 2,
        duplicateProducerPathCount: 0,
        unfinishedWorkCount: 0,
        referencedObjectCount: 2,
        unverifiedObjectCount: 0,
        activeSearchOwnerCount: 0,
        searchOwnerMismatchCount: 0
      });
      expect(first.eligibility).toEqual({ eligible: true, blockers: [] });
      const second = await preflight.inspect({
        knowledgeBaseId: "preflight-kb", cursor: first.nextCursor, limit: 1
      });
      expect(second.items.map((item) => item.normalizedPath))
        .toEqual(["pages/guides/index.md"]);
      expect(second.nextCursor).toBeNull();
    });

  it("constructs and resumes a bounded shadow generation without new objects",
    async () => {
      const migration = createPostgresDocumentPublicationShadowMigration(
        database
      );
      const started = await migration.start({
        knowledgeBaseId: "preflight-kb",
        now: "2026-08-21T12:10:00.000Z"
      });
      expect(started).toMatchObject({
        expectedPathCount: 2,
        processedPathCount: 0,
        cursor: null
      });
      const first = await migration.buildNextPage({
        knowledgeBaseId: "preflight-kb",
        now: "2026-08-21T12:10:01.000Z",
        limit: 1
      });
      expect(first).toMatchObject({
        state: "building",
        processedPathCount: 1,
        cursor: "index.md"
      });
      await expect(migration.start({
        knowledgeBaseId: "preflight-kb",
        now: "2026-08-21T12:10:02.000Z"
      })).resolves.toMatchObject({
        generationPublicId: started.generationPublicId,
        processedPathCount: 1,
        cursor: "index.md"
      });
      const completed = await migration.buildNextPage({
        knowledgeBaseId: "preflight-kb",
        now: "2026-08-21T12:10:03.000Z",
        limit: 1
      });
      expect(completed).toEqual({
        state: "complete",
        processedPathCount: 2,
        cursor: null
      });
      const rows = await sql<Array<{
        page_count: number | string;
        object_count: number | string;
        completed_scope_count: number | string;
      }>>`
        SELECT
          (SELECT count(*)
           FROM focowiki.projection_scope_generation_pages
           WHERE publication_generation_public_id
                   = ${started.generationPublicId}) page_count,
          (SELECT count(*) FROM focowiki.object_registrations
           WHERE object_id LIKE 'preflight-object-%') object_count,
          (SELECT count(*) FROM focowiki.projection_scope_generations
           WHERE publication_generation_public_id
                   = ${started.generationPublicId}
             AND state = 'completed') completed_scope_count
      `;
      expect(rows[0]).toMatchObject({
        page_count: "2",
        object_count: "2",
        completed_scope_count: "2"
      });

      const parity = createPostgresDocumentPublicationShadowParity(database);
      await expect(parity.compareNextPage({
        knowledgeBaseId: "preflight-kb",
        now: "2026-08-21T12:10:04.000Z",
        limit: 1
      })).resolves.toMatchObject({ state: "building", processedPathCount: 1 });
      await expect(parity.compareNextPage({
        knowledgeBaseId: "preflight-kb",
        now: "2026-08-21T12:10:05.000Z",
        limit: 1
      })).resolves.toEqual({
        state: "complete", processedPathCount: 2, cursor: null
      });
      const parityRows = await sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.projection_shadow_parity_results
        WHERE generation_public_id = ${started.generationPublicId}
      `;
      expect(parityRows).toHaveLength(7);
      expect(parityRows.every((row) => row.state === "passed")).toBe(true);
      const generations = await sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.projection_publication_generations
        WHERE public_id = ${started.generationPublicId}
      `;
      expect(generations[0]?.state).toBe("ready");
    });

  it("fences only legacy projection claims for a paused cutover", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('unrelated-kb', 'Unrelated', 1)
    `;
    const dirty = createPostgresProjectionDirtyScopeRepository(database);
    await dirty.mark({ knowledgeBaseId: "preflight-kb", kind: "root",
      key: "index", requiredSequence: 1,
      nextEligibleAt: "2026-08-21T12:11:00.000Z" });
    await dirty.mark({ knowledgeBaseId: "unrelated-kb", kind: "root",
      key: "index", requiredSequence: 1,
      nextEligibleAt: "2026-08-21T12:11:00.000Z" });
    await sql`
      UPDATE focowiki.projection_cutover_states
      SET writer_mode = 'paused'
      WHERE knowledge_base_id = 'preflight-kb'
    `;
    const claims = await dirty.claim({
      workerId: "migration-worker",
      now: "2026-08-21T12:11:01.000Z",
      leaseDurationMs: 30_000,
      limit: 2
    });
    expect(claims.map((claim) => claim.knowledgeBaseId))
      .toEqual(["unrelated-kb"]);
    await sql`
      UPDATE focowiki.projection_cutover_states
      SET writer_mode = 'shadow'
      WHERE knowledge_base_id = 'preflight-kb'
    `;
  });

  it("cuts over only metadata and supports a pre-mutation rollback", async () => {
    await sql`
      DELETE FROM focowiki.projection_dirty_scopes
      WHERE knowledge_base_id = 'preflight-kb'
    `;
    const before = await sql<Array<{
      normalized_path: string;
      object_id: string;
      checksum_sha256: string;
    }>>`
      SELECT normalized_path, object_id, checksum_sha256
      FROM focowiki.generated_page_heads
      WHERE knowledge_base_id = 'preflight-kb'
      ORDER BY normalized_path COLLATE "C"
    `;
    const cutover = createPostgresDocumentPublicationCutover(database);
    const activated = await cutover.cutover({
      knowledgeBaseId: "preflight-kb",
      now: "2026-08-21T12:12:00.000Z"
    });
    expect(activated.state).toBe("active");
    const active = await sql<Array<{
      writer_mode: string;
      active_generation_public_id: string | null;
      owned_count: number | string;
    }>>`
      SELECT cutover.writer_mode, head.active_generation_public_id,
             (SELECT count(*) FROM focowiki.projection_artifact_owners owner
              WHERE owner.knowledge_base_id = cutover.knowledge_base_id)
                owned_count
      FROM focowiki.projection_cutover_states cutover
      JOIN focowiki.knowledge_base_projection_heads head
        ON head.knowledge_base_id = cutover.knowledge_base_id
      WHERE cutover.knowledge_base_id = 'preflight-kb'
    `;
    expect(active[0]).toMatchObject({ writer_mode: "coherent",
      active_generation_public_id: activated.generationPublicId,
      owned_count: "2" });
    const after = await sql<Array<{
      normalized_path: string;
      object_id: string;
      checksum_sha256: string;
    }>>`
      SELECT normalized_path, object_id, checksum_sha256
      FROM focowiki.generated_page_heads
      WHERE knowledge_base_id = 'preflight-kb'
      ORDER BY normalized_path COLLATE "C"
    `;
    expect(after).toEqual(before);
    await expect(cutover.rollbackBeforeMutation({
      knowledgeBaseId: "preflight-kb",
      now: "2026-08-21T12:12:01.000Z"
    })).resolves.toBe(true);
    const rolledBack = await sql<Array<{
      writer_mode: string;
      active_generation_public_id: string | null;
    }>>`
      SELECT cutover.writer_mode, head.active_generation_public_id
      FROM focowiki.projection_cutover_states cutover
      JOIN focowiki.knowledge_base_projection_heads head
        ON head.knowledge_base_id = cutover.knowledge_base_id
      WHERE cutover.knowledge_base_id = 'preflight-kb'
    `;
    expect(rolledBack[0]).toEqual({ writer_mode: "legacy",
      active_generation_public_id: null });
  });

  it("resumes durable canaries with empty knowledge bases first", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('empty-canary', 'Empty canary', 1)
    `;
    const runtime = createProductionDocumentPublicationCutoverRuntime({
      sql: database
    });
    for (let index = 0; index < 4; index += 1) {
      await expect(runtime.runOne(
        `2026-08-21T12:13:0${index}.000Z`
      )).resolves.toBe(true);
    }
    const rows = await sql<Array<{
      writer_mode: string;
      active_generation_public_id: string | null;
      active_path_count: number | string;
    }>>`
      SELECT cutover.writer_mode, head.active_generation_public_id,
             (SELECT count(*) FROM focowiki.generated_page_heads page
              WHERE page.knowledge_base_id = cutover.knowledge_base_id)
                active_path_count
      FROM focowiki.projection_cutover_states cutover
      JOIN focowiki.knowledge_base_projection_heads head
        ON head.knowledge_base_id = cutover.knowledge_base_id
      WHERE cutover.knowledge_base_id = 'empty-canary'
    `;
    expect(rows[0]).toMatchObject({ writer_mode: "coherent",
      active_path_count: "0" });
    expect(rows[0]?.active_generation_public_id).toMatch(
      /^projection-shadow-/u
    );
  });

  it("keeps the old public head on parity failure and preserves retry evidence",
    async () => {
      await sql`
        INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
        VALUES ('parity-failure-kb', 'Parity failure', 1)
      `;
      for (const [objectId, checksum] of [
        ["parity-object-old", "3".repeat(64)],
        ["parity-object-new", "4".repeat(64)]
      ] as const) {
        await sql`
          INSERT INTO focowiki.object_registrations (
            object_id, storage_key, checksum_sha256, byte_count,
            content_type, object_format, state, write_attempt_public_id,
            verified_at
          ) VALUES (
            ${objectId}, ${`objects/${objectId}`}, ${checksum}, 10,
            'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
            'verified', ${`${objectId}-attempt`},
            '2026-08-21T12:20:00.000Z'
          )
        `;
      }
      await sql`
        INSERT INTO focowiki.generated_page_heads (
          knowledge_base_id, logical_path, normalized_path, entry_kind,
          page_candidate_public_id, object_id, checksum_sha256,
          byte_count, activation_revision
        ) VALUES (
          'parity-failure-kb', 'index.md', 'index.md', 'navigation', NULL,
          'parity-object-old', ${"3".repeat(64)}, 10, 1
        )
      `;
      const migration = createPostgresDocumentPublicationShadowMigration(
        database
      );
      const first = await migration.start({
        knowledgeBaseId: "parity-failure-kb",
        now: "2026-08-21T12:20:01.000Z"
      });
      await migration.buildNextPage({ knowledgeBaseId: "parity-failure-kb",
        now: "2026-08-21T12:20:02.000Z", limit: 10 });
      await sql`
        UPDATE focowiki.generated_page_heads
        SET object_id = 'parity-object-new',
            checksum_sha256 = ${"4".repeat(64)}
        WHERE knowledge_base_id = 'parity-failure-kb'
          AND normalized_path = 'index.md'
      `;
      const parity = createPostgresDocumentPublicationShadowParity(database);
      await expect(parity.compareNextPage({
        knowledgeBaseId: "parity-failure-kb",
        now: "2026-08-21T12:20:03.000Z", limit: 10
      })).resolves.toMatchObject({ state: "failed" });
      const failed = await sql<Array<{
        writer_mode: string;
        safe_error_code: string | null;
        object_id: string;
        generation_state: string;
      }>>`
        SELECT cutover.writer_mode, cutover.safe_error_code, head.object_id,
               generation.state generation_state
        FROM focowiki.projection_cutover_states cutover
        JOIN focowiki.generated_page_heads head
          ON head.knowledge_base_id = cutover.knowledge_base_id
        JOIN focowiki.projection_publication_generations generation
          ON generation.public_id = cutover.shadow_generation_public_id
        WHERE cutover.knowledge_base_id = 'parity-failure-kb'
      `;
      expect(failed[0]).toEqual({ writer_mode: "legacy",
        safe_error_code: "shadow_page_parity_failed",
        object_id: "parity-object-new", generation_state: "quarantined" });
      await expect(migration.retryFailed({
        knowledgeBaseId: "parity-failure-kb",
        now: "2026-08-21T12:20:04.000Z"
      })).resolves.toBe(true);
      const restarted = await migration.start({
        knowledgeBaseId: "parity-failure-kb",
        now: "2026-08-21T12:20:05.000Z"
      });
      expect(restarted.generationPublicId).not.toBe(first.generationPublicId);
      const retained = await sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.projection_publication_generations
        WHERE public_id = ${first.generationPublicId}
      `;
      expect(retained[0]?.state).toBe("quarantined");
    });

  it("fails a cutover race without changing the old public head", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('cutover-race-kb', 'Cutover race', 1)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count,
        content_type, object_format, state, write_attempt_public_id,
        verified_at
      ) VALUES (
        'cutover-race-object', 'objects/cutover-race-object',
        ${"5".repeat(64)}, 10, 'text/markdown; charset=utf-8',
        'okf-generated-markdown-v1', 'verified',
        'cutover-race-attempt', '2026-08-21T12:21:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        page_candidate_public_id, object_id, checksum_sha256,
        byte_count, activation_revision
      ) VALUES (
        'cutover-race-kb', 'index.md', 'index.md', 'navigation', NULL,
        'cutover-race-object', ${"5".repeat(64)}, 10, 1
      )
    `;
    const migration = createPostgresDocumentPublicationShadowMigration(
      database
    );
    const started = await migration.start({ knowledgeBaseId: "cutover-race-kb",
      now: "2026-08-21T12:21:01.000Z" });
    await migration.buildNextPage({ knowledgeBaseId: "cutover-race-kb",
      now: "2026-08-21T12:21:02.000Z", limit: 10 });
    await createPostgresDocumentPublicationShadowParity(database)
      .compareNextPage({ knowledgeBaseId: "cutover-race-kb",
        now: "2026-08-21T12:21:03.000Z", limit: 10 });
    await sql`
      INSERT INTO focowiki.projection_fact_epochs (
        knowledge_base_id, fact_epoch, mutation_public_id,
        mutation_group_public_id, fact_kind, state, created_at
      ) VALUES (
        'cutover-race-kb', 1, 'cutover-race-mutation',
        'cutover-race-mutation', 'repair', 'ready',
        '2026-08-21T12:21:04.000Z'
      )
    `;
    await expect(createPostgresDocumentPublicationCutover(database).cutover({
      knowledgeBaseId: "cutover-race-kb",
      now: "2026-08-21T12:21:05.000Z"
    })).resolves.toMatchObject({ state: "failed",
      generationPublicId: started.generationPublicId });
    const rows = await sql<Array<{
      writer_mode: string;
      object_id: string;
      projection_generation_public_id: string | null;
    }>>`
      SELECT cutover.writer_mode, head.object_id,
             head.projection_generation_public_id
      FROM focowiki.projection_cutover_states cutover
      JOIN focowiki.generated_page_heads head
        ON head.knowledge_base_id = cutover.knowledge_base_id
      WHERE cutover.knowledge_base_id = 'cutover-race-kb'
    `;
    expect(rows[0]).toEqual({ writer_mode: "legacy",
      object_id: "cutover-race-object",
      projection_generation_public_id: null });
  });

  it("drops superseded projection schema only after the drain gate", async () => {
    const cleanup = createPostgresDocumentProjectionLegacyCleanup(database);
    await expect(cleanup.tryCleanup("2026-08-21T12:30:00.000Z"))
      .resolves.toBe(false);
    await sql`
      INSERT INTO focowiki.projection_cutover_states (
        knowledge_base_id, writer_mode, updated_at
      )
      SELECT public_id, 'coherent', '2026-08-21T12:30:01.000Z'
      FROM focowiki.knowledge_bases
      WHERE deleted_at IS NULL
      ON CONFLICT (knowledge_base_id) DO UPDATE
      SET writer_mode = 'coherent', safe_error_code = NULL,
          updated_at = excluded.updated_at
    `;
    await sql`
      UPDATE focowiki.projection_dirty_scopes
      SET state = 'completed', completed_sequence = required_sequence,
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
    `;
    await expect(cleanup.tryCleanup("2026-08-21T12:30:02.000Z"))
      .resolves.toBe(true);
    const [tables] = await sql<Array<{
      dirty: string | null;
      outputs: string | null;
      owners: string | null;
      state: string;
    }>>`
      SELECT to_regclass('focowiki.projection_dirty_scopes')::text dirty,
             to_regclass('focowiki.projection_scope_outputs')::text outputs,
             to_regclass('focowiki.scoped_activation_owners')::text owners,
             cleanup.state
      FROM focowiki.projection_legacy_cleanup_state cleanup
      WHERE cleanup.singleton = true
    `;
    expect(tables).toEqual({
      dirty: null,
      outputs: null,
      owners: null,
      state: "cleaned"
    });
    await expect(cleanup.tryCleanup("2026-08-21T12:30:03.000Z"))
      .resolves.toBe(false);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('post-cleanup-kb', 'Post cleanup', 1)
    `;
    await expect(sql<Array<{ writer_mode: string }>>`
      SELECT writer_mode FROM focowiki.projection_cutover_states
      WHERE knowledge_base_id = 'post-cleanup-kb'
    `).resolves.toEqual([{ writer_mode: "coherent" }]);
  });
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
