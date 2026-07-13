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
    expect(database.unsafeCalls).toBe(2);
    expect(database.beginCalls).toBe(2);
  });

  it("upgrades the retained-source generation through the destructive generated-output reset", async () => {
    const database = createGenerationDatabase("admin-resource-editing-v3");

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(1);
    expect(database.beginCalls).toBe(1);
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

  it("defines a bounded retained-source reset and durable rebuild contract", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/002_okf_google_v0_1_reset.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("create table focowiki.generated_output_resets");
    expect(migration).toContain("create table focowiki.generated_output_reset_prefixes");
    expect(migration).toContain("update focowiki.knowledge_bases set active_release_id = null");
    expect(migration).toContain("delete from focowiki.bundle_files");
    expect(migration).toContain("delete from focowiki.releases");
    expect(migration).toContain("generated_output_status = 'pending'");
    expect(migration).toContain("generated_bundle_file_id = null");
    expect(migration).toContain("generated_bundle_file_path = null");
    expect(migration).toContain("'generated_output_reset', reset.knowledge_base_id");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).not.toContain("delete from focowiki.source_file_revisions");
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
    generation = unsafeCalls === 1 && initialGeneration === "absent"
      ? "admin-resource-editing-v3"
      : RUNTIME_SCHEMA_GENERATION;
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
