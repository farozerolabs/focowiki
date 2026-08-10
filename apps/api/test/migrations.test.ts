import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  applyMigrations,
  assertRuntimeSchemaGeneration,
  MIGRATION_FILES,
  preflightMigrations,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

describe("storage vNext runtime schema guard", () => {
  it("accepts the current runtime generation without replay", async () => {
    const database = createGenerationDatabase(RUNTIME_SCHEMA_GENERATION);

    await expect(assertRuntimeSchemaGeneration(database.sql)).resolves.toBeUndefined();
    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.schemaSignatureSql).toEqual(expect.arrayContaining([
      expect.stringContaining("source_event_summaries_stage_check"),
      expect.stringContaining("graphrag_processing"),
      expect.stringContaining("semantic_reconciliation"),
      expect.stringContaining("embedding_generation"),
      expect.stringContaining("affected_projection"),
      expect.stringContaining("search_publication"),
      expect.stringContaining("semantic_maintenance_required"),
      expect.stringContaining("semantic_source_reconciliations_pkey"),
      expect.stringContaining(
        "primarykey(semantic_generation_public_id,source_file_public_id,source_revision_public_id)"
      )
    ]));
    expect(database.unsafeCalls).toBe(0);
    expect(database.beginCalls).toBe(0);
  });

  it("reports one clean bootstrap for an absent schema", async () => {
    const database = createGenerationDatabase("absent");

    await expect(preflightMigrations(database.sql)).resolves.toEqual({
      currentGeneration: "absent",
      pendingFiles: [...MIGRATION_FILES]
    });
    expect(database.unsafeCalls).toBe(0);
    expect(database.beginCalls).toBe(0);
  });

  it("initializes an absent schema exactly once", async () => {
    const database = createGenerationDatabase("absent");

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(MIGRATION_FILES.length);
    expect(database.beginCalls).toBe(MIGRATION_FILES.length);
  });

  it("rejects unmarked, historical, and unknown schemas without writing", async () => {
    for (const generation of [
      null,
      "storage-vnext-v1",
      "storage-vnext-v2",
      "incremental-sharded-publication-v1",
      "durable-search-projection-planning-v19",
      "unknown-v99"
    ] as const) {
      const database = createGenerationDatabase(generation);

      await expect(applyMigrations(database.sql)).rejects.toMatchObject({
        name: "RuntimeSchemaGenerationError"
      });
      expect(database.unsafeCalls).toBe(0);
      expect(database.beginCalls).toBe(0);
    }
  });

  it("rejects the provider-unaware schema before mutation with clean-reset guidance", async () => {
    const database = createGenerationDatabase(
      RUNTIME_SCHEMA_GENERATION,
      { providerSchemaCompatible: false }
    );

    await expect(preflightMigrations(database.sql)).rejects.toMatchObject({
      name: "RuntimeSchemaSignatureError",
      message: expect.stringMatching(/clean reset/iu)
    });
    await expect(assertRuntimeSchemaGeneration(database.sql)).rejects.toMatchObject({
      name: "RuntimeSchemaSignatureError"
    });
    await expect(applyMigrations(database.sql)).rejects.toMatchObject({
      name: "RuntimeSchemaSignatureError"
    });
    expect(database.unsafeCalls).toBe(0);
    expect(database.beginCalls).toBe(0);
  });
});

function createGenerationDatabase(
  initialGeneration: string | "absent" | null,
  options: { providerSchemaCompatible?: boolean } = {}
) {
  let generation = initialGeneration;
  let unsafeCalls = 0;
  let beginCalls = 0;
  const schemaSignatureSql: string[] = [];
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
    if (statement.includes("provider_schema_compatible")) {
      schemaSignatureSql.push(statement);
      return [{
        provider_schema_compatible: options.providerSchemaCompatible ?? true
      }];
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
    },
    get schemaSignatureSql() {
      return schemaSignatureSql;
    }
  };
}
