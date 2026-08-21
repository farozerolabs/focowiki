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
      expect.stringContaining("document_processing_jobs"),
      expect.stringContaining("document_artifact_work"),
      expect.stringContaining("document_artifact_receipts"),
      expect.stringContaining("generated_page_heads"),
      expect.stringContaining("unresolved_file_references"),
      expect.stringContaining("knowledge_base_sequences"),
      expect.stringContaining("document_artifact_work_claim_idx"),
      expect.stringContaining("generated_page_heads_path_idx"),
      expect.stringContaining("unresolved_file_references_reverse_idx"),
      expect.stringContaining("upload_operation_summaries"),
      expect.stringContaining("upload_operation_summaries_expiry_idx"),
      expect.stringContaining("document_processing_jobs_source_revision_key"),
      expect.stringContaining("release_candidates"),
      expect.stringContaining("release_roots"),
      expect.stringContaining("knowledge_base_activation_revisions")
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
    expect(database.beginCalls).toBe(1);
  });

  it("rejects persisted generations before executing migration SQL", async () => {
    for (const generation of [
      "storage-vnext-v9-document-indexing-hybrid",
      "storage-vnext-v10-document-indexing-throughput",
      "storage-vnext-v11-projection-throughput",
      "storage-vnext-v12-projection-object-lifecycle",
      "storage-vnext-v13-active-projection-output-repair"
    ]) {
      const database = createGenerationDatabase(generation);
      await expect(preflightMigrations(database.sql)).rejects.toMatchObject({
        name: "RuntimeSchemaGenerationError",
        message: expect.stringMatching(/clean reset/iu)
      });
      expect(database.unsafeCalls).toBe(0);
      expect(database.beginCalls).toBe(0);
    }
  });

  it("leaves an absent schema retryable when the bootstrap fails", async () => {
    const database = createGenerationDatabase("absent", { failUnsafeAt: 1 });

    await expect(applyMigrations(database.sql))
      .rejects.toThrow("simulated migration failure");
    await expect(preflightMigrations(database.sql)).resolves.toEqual({
      currentGeneration: "absent",
      pendingFiles: [...MIGRATION_FILES]
    });

    database.setFailUnsafeAt(null);
    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    await expect(preflightMigrations(database.sql)).resolves.toEqual({
      currentGeneration: RUNTIME_SCHEMA_GENERATION,
      pendingFiles: []
    });
  });

  it("rejects unmarked, historical, and unknown schemas without writing", async () => {
    for (const generation of [
      null,
      "storage-vnext-v1",
      "storage-vnext-v2",
      "storage-vnext-v4-continuous-pipeline",
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
  options: {
    providerSchemaCompatible?: boolean;
    failUnsafeAt?: number;
  } = {}
) {
  let generation = initialGeneration;
  let unsafeCalls = 0;
  let beginCalls = 0;
  let failUnsafeAt = options.failUnsafeAt ?? null;
  const schemaSignatureSql: string[] = [];
  const tagged = async (segments: TemplateStringsArray) => {
    const statement = segments.join(" ");
    if (statement.includes("to_regnamespace")) {
      return [{ schema_exists: generation !== "absent" }];
    }
    if (statement.includes("runtime_schema_compatible")) {
      schemaSignatureSql.push(statement);
      return [{
        runtime_schema_compatible: options.providerSchemaCompatible ?? true
      }];
    }
    if (statement.includes("upgrade_source_compatible")) {
      return [{
        upgrade_source_compatible: options.providerSchemaCompatible ?? true
      }];
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
    if (unsafeCalls === failUnsafeAt) {
      throw new Error("simulated migration failure");
    }
    if (statement.includes(RUNTIME_SCHEMA_GENERATION)) {
      generation = RUNTIME_SCHEMA_GENERATION;
    } else if (statement.includes("storage-vnext-v2")) {
      generation = "storage-vnext-v2";
    } else if (statement.includes("storage-vnext-v1")) {
      generation = "storage-vnext-v1";
    }
    return [];
  }) as unknown as DatabaseClient["unsafe"];
  sql.begin = (async (callback: (transaction: DatabaseClient) => Promise<unknown>) => {
    beginCalls += 1;
    const before = generation;
    try {
      return await callback(sql);
    } catch (error) {
      generation = before;
      throw error;
    }
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
    },
    setFailUnsafeAt(value: number | null) {
      failUnsafeAt = value;
    }
  };
}
