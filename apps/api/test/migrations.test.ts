import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  applyMigrations,
  assertRuntimeSchemaGeneration,
  MIGRATION_FILES,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const FIRST_RELEASED_SCHEMA_GENERATION = "incremental-sharded-publication-v1";
const TREE_GRAPH_SCHEMA_GENERATION = "tree-graph-storage-reconciliation-v2";
const BOUNDED_PUBLICATION_SCHEMA_GENERATION = "bounded-publication-recovery-v3";
const LATEST_RELEASED_SCHEMA_GENERATION = "immutable-object-contention-recovery-v4";

describe("runtime schema generation guard", () => {
  it("accepts the current runtime generation", async () => {
    const database = createGenerationDatabase(RUNTIME_SCHEMA_GENERATION);

    await expect(assertRuntimeSchemaGeneration(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(0);
  });

  it("skips baseline replay after the current generation is initialized", async () => {
    const database = createGenerationDatabase(RUNTIME_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(0);
  });

  it("initializes an absent schema exactly once and verifies its marker", async () => {
    const database = createGenerationDatabase("absent");

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(MIGRATION_FILES.length);
    expect(database.beginCalls).toBe(MIGRATION_FILES.length);
  });

  it("upgrades the first released generation without replaying the baseline", async () => {
    const database = createGenerationDatabase(FIRST_RELEASED_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(4);
    expect(database.beginCalls).toBe(4);
  });

  it("upgrades the tree and graph generation without replaying prior migrations", async () => {
    const database = createGenerationDatabase(TREE_GRAPH_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(3);
    expect(database.beginCalls).toBe(3);
  });

  it("upgrades the bounded publication generation without replaying earlier migrations", async () => {
    const database = createGenerationDatabase(BOUNDED_PUBLICATION_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(2);
    expect(database.beginCalls).toBe(2);
  });

  it("upgrades the latest released generation with only the pending migration", async () => {
    const database = createGenerationDatabase(LATEST_RELEASED_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(1);
    expect(database.beginCalls).toBe(1);
  });

  it("rejects unmarked and incompatible schemas", async () => {
    for (const generation of [null, "file-graph-v1", "folder-aware-v2", "unknown-v9"] as const) {
      const database = createGenerationDatabase(generation);

      await expect(applyMigrations(database.sql)).rejects.toMatchObject({
        name: "RuntimeSchemaGenerationError",
        message: expect.stringContaining("cannot be upgraded automatically")
      });
      expect(database.unsafeCalls).toBe(0);
    }
  });

  it("defines only the incremental generation and active-projection schema", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    for (const table of [
      "source_revisions",
      "source_dispatch_markers",
      "publication_change_facts",
      "publication_generations",
      "publication_impacts",
      "projection_shards",
      "generation_object_refs",
      "generation_projection_records",
      "active_object_refs",
      "active_projection_records",
      "publication_progress",
      "role_jobs",
      "cleanup_checkpoints"
    ]) {
      expect(migration).toContain(`create table focowiki.${table}`);
    }
    for (const legacyTable of ["releases", "bundle_files", "worker_jobs", "publication_jobs"]) {
      expect(migration).not.toContain(`create table focowiki.${legacyTable} `);
    }
    expect(migration).toContain("incremental-sharded-publication-v1");
    expect(migration).not.toContain("generated_bundle_file_id");
    expect(migration).not.toContain("publication_dirty_at");
  });

  it("recovers stalled publication state without replacing active generations", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/003_bounded_publication_recovery.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("create temp table focowiki_migration_failed_generations");
    expect(migration).toContain("status = 'cancelled'");
    expect(migration).toContain("status = 'queued'");
    expect(migration).toContain("generation.state = 'open'");
    expect(migration).toContain("bounded-publication-recovery-v3");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).not.toContain("update focowiki.publication_generations generation set state = 'active'");
  });

  it("recovers immutable-object contention without replaying completed impacts", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/004_immutable_object_contention_recovery.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("immutable object write is already in progress");
    expect(migration).toContain("status in ('failed', 'cancelled')");
    expect(migration).toContain("set state = 'building'");
    expect(migration).toContain("set status = 'queued'");
    expect(migration).toContain("immutable-object-contention-recovery-v4");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).toContain("count(*) filter (where impact.status = 'completed')");
  });

  it("recovers publication jobs whose outer retry budget ended before their impacts", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/005_publication_retry_budget_recovery.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("publication_retries_exhausted");
    expect(migration).toContain("projection write will be retried");
    expect(migration).toContain("status in ('failed', 'cancelled')");
    expect(migration).toContain("set state = 'building'");
    expect(migration).toContain("set status = 'queued'");
    expect(migration).toContain("publication-retry-budget-recovery-v5");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).toContain("count(*) filter (where impact.status = 'completed')");
  });
});

function createGenerationDatabase(initialGeneration: string | "absent" | null) {
  let generation = initialGeneration;
  let unsafeCalls = 0;
  let beginCalls = 0;
  const tagged = async (segments: TemplateStringsArray) => {
    const statement = segments.join(" ");
    if (statement.includes("to_regnamespace")) {
      return [{ schema_exists: generation !== "absent" }];
    }
    if (statement.includes("to_regclass")) {
      return [{ marker_exists: generation !== null }];
    }
    if (statement.includes("FROM focowiki.runtime_generation")) {
      return generation && generation !== "absent" ? [{ generation }] : [];
    }
    throw new Error(`Unexpected SQL in generation test: ${statement}`);
  };
  const sql = tagged as unknown as DatabaseClient;
  sql.unsafe = (async (statement: string) => {
    unsafeCalls += 1;
    if (statement.includes(RUNTIME_SCHEMA_GENERATION)) {
      generation = RUNTIME_SCHEMA_GENERATION;
    }
    return [];
  }) as unknown as DatabaseClient["unsafe"];
  sql.begin = (async (callback: (transaction: DatabaseClient) => Promise<unknown>) => {
    beginCalls += 1;
    return callback(sql);
  }) as unknown as DatabaseClient["begin"];

  return {
    sql,
    get unsafeCalls() {
      return unsafeCalls;
    },
    get beginCalls() {
      return beginCalls;
    }
  };
}
