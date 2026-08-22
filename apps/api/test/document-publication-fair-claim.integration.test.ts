import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentScopeGenerationRepository } from
  "../src/document-indexing/infrastructure/postgres-document-scope-generation-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document publication fair scope claim", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_publication_fair_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 4 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('fair-hot', 'Hot', 1), ('fair-quiet', 'Quiet', 1),
             ('fair-deleted', 'Deleted', 1)
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = '2026-08-21T15:59:00.000Z'
      WHERE public_id = 'fair-deleted'
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_heads (
        knowledge_base_id, updated_at
      ) VALUES
        ('fair-hot', '2026-08-21T16:00:00.000Z'),
        ('fair-quiet', '2026-08-21T16:00:00.000Z'),
        ('fair-deleted', '2026-08-21T16:00:00.000Z')
    `;
    await sql`
      INSERT INTO focowiki.projection_cutover_states (
        knowledge_base_id, writer_mode, updated_at
      ) VALUES
        ('fair-hot', 'coherent', '2026-08-21T16:00:00.000Z'),
        ('fair-quiet', 'coherent', '2026-08-21T16:00:00.000Z'),
        ('fair-deleted', 'coherent', '2026-08-21T16:00:00.000Z')
    `;
    for (const knowledgeBaseId of ["fair-hot", "fair-quiet", "fair-deleted"]) {
      await sql`
        INSERT INTO focowiki.projection_publication_generations (
          public_id, knowledge_base_id, target_fact_epoch,
          renderer_contract_version, deterministic_changed_at,
          input_fingerprint_sha256, state
        ) VALUES (
          ${`${knowledgeBaseId}-generation`}, ${knowledgeBaseId}, 1,
          'portable-okf-v2', '2026-08-21T16:00:00.000Z',
          ${knowledgeBaseId === "fair-hot" ? "a".repeat(64) : "b".repeat(64)},
          'rendering'
        )
      `;
    }
    for (let index = 0; index < 4; index += 1) {
      await seedScope("fair-hot", index);
    }
    await seedScope("fair-quiet", 0);
    await seedScope("fair-deleted", 0);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("claims one eligible scope per knowledge base before a hot sibling", async () => {
    const repository = createPostgresDocumentScopeGenerationRepository(database);
    const claims = await repository.claim({
      workerId: "fair-worker",
      now: "2026-08-21T16:00:01.000Z",
      leaseDurationMs: 30_000,
      limit: 2
    });
    const rows = await sql<Array<{ knowledge_base_id: string }>>`
      SELECT knowledge_base_id
      FROM focowiki.projection_scope_generations
      WHERE public_id IN ${sql(claims.map((claim) => claim.publicId))}
      ORDER BY knowledge_base_id
    `;
    expect(rows).toEqual([
      { knowledge_base_id: "fair-hot" },
      { knowledge_base_id: "fair-quiet" }
    ]);
    await expect(sql<Array<{
      knowledge_base_id: string;
      waiting_count: number | string;
    }>>`
      SELECT knowledge_base_id, waiting_count
      FROM focowiki.projection_scheduler_credits
      ORDER BY knowledge_base_id
    `).resolves.toEqual([
      { knowledge_base_id: "fair-hot", waiting_count: "3" },
      { knowledge_base_id: "fair-quiet", waiting_count: "0" }
    ]);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.projection_scope_generations
      WHERE knowledge_base_id = 'fair-deleted'
    `).resolves.toEqual([{ state: "waiting" }]);
  });

  async function seedScope(knowledgeBaseId: string, index: number) {
    await sql`
      INSERT INTO focowiki.projection_scope_generations (
        public_id, publication_generation_public_id, knowledge_base_id,
        scope_identity, scope_kind, scope_key, scope_generation,
        input_snapshot_fingerprint_sha256, state, created_at, updated_at
      ) VALUES (
        ${`${knowledgeBaseId}-scope-${index}`},
        ${`${knowledgeBaseId}-generation`}, ${knowledgeBaseId},
        ${`source:${knowledgeBaseId}-${index}`}, 'source',
        ${`${knowledgeBaseId}-${index}`}, 1, ${"c".repeat(64)}, 'waiting',
        '2026-08-21T16:00:00.000Z', '2026-08-21T16:00:00.000Z'
      )
    `;
  }
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
