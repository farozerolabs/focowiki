import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable search planning migration integration", () => {
  const connectionUrl =
    databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_durable_search_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-durable-search', 'Durable search')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version, generation_kind
      ) VALUES (
        'generation-durable-search', 'kb-durable-search',
        'active', 2, 'normal'
      )
    `;
    await sql`
      INSERT INTO focowiki.search_projection_work (
        id, knowledge_base_id, epoch, generation_id,
        index_kind, work_kind, batch_ordinal, payload_checksum,
        document_count, compressed_bytes, task_correlation, max_attempts
      ) VALUES (
        'search-work-existing', 'kb-durable-search', 1,
        'generation-durable-search', 'content', 'documents', 0,
        ${createHash("sha256").update("existing").digest("hex")},
        1, 100, 'search-work-existing', 5
      )
    `;
    await sql`
      UPDATE focowiki.runtime_generation
      SET generation = 'meilisearch-search-projection-v18'
      WHERE singleton = true
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end({ timeout: 5 });
  });

  it("preserves existing work while enabling resumable planning", async () => {
    await expect(applyMigrations(sql)).resolves.toBeUndefined();

    const existing = await sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.search_projection_work
      WHERE id = 'search-work-existing'
    `;
    expect(existing).toEqual([{ state: "queued" }]);

    await expect(sql`
      INSERT INTO focowiki.search_projection_work (
        id, knowledge_base_id, epoch, generation_id,
        index_kind, work_kind, batch_ordinal, payload_checksum,
        document_count, compressed_bytes, task_correlation, max_attempts
      ) VALUES (
        'search-work-planner', 'kb-durable-search', 1,
        'generation-durable-search', 'content', 'plan_documents', 0,
        ${createHash("sha256").update("planner").digest("hex")},
        0, 0, 'search-work-planner', 5
      )
    `).resolves.toBeDefined();

    const generation = await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `;
    expect(generation[0]?.generation)
      .toBe("durable-search-projection-planning-v19");
  });
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
