import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  applyMigrations,
  assertRuntimeSchemaGeneration,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

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
    expect(database.unsafeCalls).toBe(1);
    expect(database.beginCalls).toBe(1);
  });

  it("rejects the former runtime generation after the destructive schema reset", async () => {
    const database = createGenerationDatabase("admin-resource-editing-v3");

    await expect(applyMigrations(database.sql)).rejects.toMatchObject({
      name: "RuntimeSchemaGenerationError",
      message: expect.stringContaining("empty database")
    });
    expect(database.unsafeCalls).toBe(0);
    expect(database.beginCalls).toBe(0);
  });

  it("rejects unmarked and incompatible schemas", async () => {
    for (const generation of [null, "file-graph-v1", "folder-aware-v2", "unknown-v9"] as const) {
      const database = createGenerationDatabase(generation);

      await expect(applyMigrations(database.sql)).rejects.toMatchObject({
        name: "RuntimeSchemaGenerationError",
        message: expect.stringContaining("empty database")
      });
      expect(database.unsafeCalls).toBe(0);
    }
  });

  it("defines only the final read-model and publication schema", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("create table focowiki.bundle_file_search_documents");
    expect(migration).toContain("create table focowiki.release_read_summaries");
    expect(migration).toContain("worker_jobs_publication_queued_unique_idx");
    expect(migration).toContain("relation-search-publication-v1");
    expect(migration).not.toContain("generated_output_reset");
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
  sql.unsafe = (async () => {
    unsafeCalls += 1;
    generation = RUNTIME_SCHEMA_GENERATION;
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
