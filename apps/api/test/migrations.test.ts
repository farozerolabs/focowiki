import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  applyMigrations,
  assertRuntimeSchemaGeneration,
  MIGRATION_FILES,
  preflightMigrations,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const FIRST_RELEASED_SCHEMA_GENERATION = "incremental-sharded-publication-v1";
const TREE_GRAPH_SCHEMA_GENERATION = "tree-graph-storage-reconciliation-v2";
const BOUNDED_PUBLICATION_SCHEMA_GENERATION = "bounded-publication-recovery-v3";
const IMMUTABLE_CONTENTION_SCHEMA_GENERATION = "immutable-object-contention-recovery-v4";
const RETRY_BUDGET_SCHEMA_GENERATION = "publication-retry-budget-recovery-v5";
const CONTINUATION_SCHEMA_GENERATION = "publication-continuation-recovery-v6";
const WRITE_LIVELOCK_SCHEMA_GENERATION = "publication-write-livelock-recovery-v7";
const LARGE_SCALE_SCHEMA_GENERATION = "large-scale-ingestion-runtime-v8";
const OPTIMIZATION_REBASE_SCHEMA_GENERATION = "optimization-migration-rebase-recovery-v9";
const GENERATION_CONSISTENT_READ_SCHEMA_GENERATION = "generation-consistent-read-repair-v10";
const BODY_SEARCH_SCHEMA_GENERATION = "body-search-projection-v11";
const STORAGE_RECONCILIATION_SCHEMA_GENERATION = "storage-reconciliation-lease-recovery-v12";
const PROJECTION_REPAIR_THROUGHPUT_SCHEMA_GENERATION = "projection-repair-throughput-v13";
const DIRECTORY_ORDER_SCHEMA_GENERATION = "directory-order-repair-v14";
const LEXICAL_REBUILD_SCHEMA_GENERATION = "lexical-rebuild-worker-v15";
const KNOWLEDGE_BASE_MAINTENANCE_SCHEMA_GENERATION =
  "knowledge-base-index-maintenance-v16";
const INDEXED_STORAGE_OBJECT_SCHEMA_GENERATION =
  "indexed-storage-object-protection-v17";

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

  it("reports pending compatible migrations without mutating the database", async () => {
    const database = createGenerationDatabase(WRITE_LIVELOCK_SCHEMA_GENERATION);

    await expect(preflightMigrations(database.sql)).resolves.toEqual({
      currentGeneration: WRITE_LIVELOCK_SCHEMA_GENERATION,
      pendingFiles: [
        "008_large_scale_ingestion_runtime.sql",
        "009_optimization_migration_rebase_recovery.sql",
        "010_generation_consistent_read_repair.sql",
        "011_body_search_projection.sql",
        "012_storage_reconciliation_lease_recovery.sql",
        "013_projection_repair_throughput.sql",
        "014_directory_order_repair.sql",
        "015_lexical_rebuild_worker.sql",
        "016_knowledge_base_index_maintenance.sql",
        "017_indexed_storage_object_protection.sql",
        "018_meilisearch_search_projection.sql"
      ]
    });
    expect(database.unsafeCalls).toBe(0);
    expect(database.beginCalls).toBe(0);
  });

  it("allows an absent schema without querying runtime work tables", async () => {
    const database = createGenerationDatabase("absent");

    await expect(preflightMigrations(database.sql)).resolves.toEqual({
      currentGeneration: "absent",
      pendingFiles: [...MIGRATION_FILES]
    });
    expect(database.preflightCalls).toBe(0);
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
    expect(database.unsafeCalls).toBe(17);
    expect(database.beginCalls).toBe(17);
  });

  it("upgrades the tree and graph generation without replaying prior migrations", async () => {
    const database = createGenerationDatabase(TREE_GRAPH_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(16);
    expect(database.beginCalls).toBe(16);
  });

  it("upgrades the bounded publication generation without replaying earlier migrations", async () => {
    const database = createGenerationDatabase(BOUNDED_PUBLICATION_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(15);
    expect(database.beginCalls).toBe(15);
  });

  it("upgrades the immutable contention generation without replaying earlier migrations", async () => {
    const database = createGenerationDatabase(IMMUTABLE_CONTENTION_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(14);
    expect(database.beginCalls).toBe(14);
  });

  it("upgrades the retry-budget generation with its pending migrations", async () => {
    const database = createGenerationDatabase(RETRY_BUDGET_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(13);
    expect(database.beginCalls).toBe(13);
  });

  it("upgrades the continuation generation with only the pending migration", async () => {
    const database = createGenerationDatabase(CONTINUATION_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(12);
    expect(database.beginCalls).toBe(12);
  });

  it("upgrades the write-livelock generation with only the optimized migration", async () => {
    const database = createGenerationDatabase(WRITE_LIVELOCK_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(11);
    expect(database.beginCalls).toBe(11);
  });

  it("upgrades the large-scale generation with only the migration recovery", async () => {
    const database = createGenerationDatabase(LARGE_SCALE_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(10);
    expect(database.beginCalls).toBe(10);
  });

  it("upgrades the optimization recovery generation with only the read repair", async () => {
    const database = createGenerationDatabase(OPTIMIZATION_REBASE_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(9);
    expect(database.beginCalls).toBe(9);
  });

  it("upgrades the generation-consistent read schema with only the body-search projection", async () => {
    const database = createGenerationDatabase(GENERATION_CONSISTENT_READ_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(8);
    expect(database.beginCalls).toBe(8);
  });

  it("upgrades the body-search schema with only the reconciliation recovery", async () => {
    const database = createGenerationDatabase(BODY_SEARCH_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(7);
    expect(database.beginCalls).toBe(7);
  });

  it("upgrades the storage reconciliation schema with the pending compatible migrations", async () => {
    const database = createGenerationDatabase(STORAGE_RECONCILIATION_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(6);
    expect(database.beginCalls).toBe(6);
  });

  it("upgrades projection repair throughput with compatible ordering and lexical migrations", async () => {
    const database = createGenerationDatabase(PROJECTION_REPAIR_THROUGHPUT_SCHEMA_GENERATION);

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.unsafeCalls).toBe(5);
    expect(database.beginCalls).toBe(5);
  });

  it("does not require drained work for compatible ordering and lexical upgrades", async () => {
    const database = createGenerationDatabase(
      PROJECTION_REPAIR_THROUGHPUT_SCHEMA_GENERATION,
      { unfinishedWork: true }
    );

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.preflightCalls).toBe(0);
    expect(database.unsafeCalls).toBe(5);
    expect(database.beginCalls).toBe(5);
  });

  it("upgrades directory ordering with only the compatible lexical migration", async () => {
    const database = createGenerationDatabase(DIRECTORY_ORDER_SCHEMA_GENERATION, {
      unfinishedWork: true
    });

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.preflightCalls).toBe(0);
    expect(database.unsafeCalls).toBe(4);
    expect(database.beginCalls).toBe(4);
  });

  it("upgrades lexical rebuild with only the compatible maintenance migration", async () => {
    const database = createGenerationDatabase(LEXICAL_REBUILD_SCHEMA_GENERATION, {
      unfinishedWork: true
    });

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.preflightCalls).toBe(0);
    expect(database.unsafeCalls).toBe(3);
    expect(database.beginCalls).toBe(3);
  });

  it("upgrades knowledge-base maintenance with indexed object and search projections", async () => {
    const database = createGenerationDatabase(
      KNOWLEDGE_BASE_MAINTENANCE_SCHEMA_GENERATION,
      { unfinishedWork: true }
    );

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.preflightCalls).toBe(0);
    expect(database.unsafeCalls).toBe(2);
    expect(database.beginCalls).toBe(2);
  });

  it("upgrades indexed object protection with only the search projection", async () => {
    const database = createGenerationDatabase(
      INDEXED_STORAGE_OBJECT_SCHEMA_GENERATION,
      { unfinishedWork: true }
    );

    await expect(applyMigrations(database.sql)).resolves.toBeUndefined();
    expect(database.preflightCalls).toBe(0);
    expect(database.unsafeCalls).toBe(1);
    expect(database.beginCalls).toBe(1);
  });

  it("still requires drained work when earlier migrations are pending", async () => {
    const database = createGenerationDatabase(
      STORAGE_RECONCILIATION_SCHEMA_GENERATION,
      { unfinishedWork: true }
    );

    await expect(applyMigrations(database.sql)).rejects.toMatchObject({
      name: "MigrationWorkNotDrainedError",
      code: "MIGRATION_WORK_NOT_DRAINED"
    });
    expect(database.preflightCalls).toBe(1);
    expect(database.unsafeCalls).toBe(0);
    expect(database.beginCalls).toBe(0);
  });

  it.each([
    "knowledgeBaseMaintenanceRequests",
    "projectionRepairs",
    "lexicalRebuilds",
    "projectionCompactions",
    "maintenanceCandidateGenerations"
  ] as const)("blocks drain-required migration for %s", async (preflightCategory) => {
    const database = createGenerationDatabase(
      STORAGE_RECONCILIATION_SCHEMA_GENERATION,
      { preflightCategory }
    );

    await expect(applyMigrations(database.sql)).rejects.toMatchObject({
      name: "MigrationWorkNotDrainedError",
      code: "MIGRATION_WORK_NOT_DRAINED",
      snapshot: {
        [preflightCategory]: 1,
        total: 1
      }
    });
    expect(database.unsafeCalls).toBe(0);
    expect(database.beginCalls).toBe(0);
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
    expect(migration).not.toContain("set state = 'building'");
    expect(migration).toContain("set stage = 'pending'");
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
    expect(migration).not.toContain("set state = 'building'");
    expect(migration).toContain("set stage = 'pending'");
    expect(migration).toContain("set status = 'queued'");
    expect(migration).toContain("publication-retry-budget-recovery-v5");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).toContain("count(*) filter (where impact.status = 'completed')");
  });

  it("recovers publication jobs exhausted by continuation-only states", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/006_publication_continuation_recovery.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("publication impacts are pending");
    expect(migration).toContain("publication was interrupted");
    expect(migration).toContain("publication generation state changed");
    expect(migration).toContain("publication activation must be retried");
    expect(migration).toContain("immutable object write is already in progress");
    expect(migration).toContain("status in ('failed', 'cancelled')");
    expect(migration).not.toContain("set state = 'building'");
    expect(migration).toContain("set stage = 'pending'");
    expect(migration).toContain("set status = 'queued'");
    expect(migration).toContain("publication-continuation-recovery-v6");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).toContain("count(*) filter (where impact.status = 'completed')");
  });

  it("recovers publication write livelocks without replaying completed impacts", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/007_publication_write_livelock_recovery.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("projection write will be retried");
    expect(migration).toContain("projection shard exceeds the configured byte budget");
    expect(migration).toContain("delete from focowiki.immutable_objects object");
    expect(migration).toContain("not exists ( select 1 from focowiki.generation_object_refs");
    expect(migration).toContain("not exists ( select 1 from focowiki.active_object_refs");
    expect(migration).toContain("impact.status <> 'completed'");
    expect(migration).toContain("set status = 'queued'");
    expect(migration).not.toContain("set state = 'building'");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).toContain("publication-write-livelock-recovery-v7");
  });

  it("adds the large-scale ingestion structures without replacing business data", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/008_large_scale_ingestion_runtime.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    for (const table of [
      "source_file_graph_term_documents",
      "knowledge_base_incremental_stats",
      "knowledge_base_incremental_stat_shards",
      "knowledge_base_optimization_migrations",
      "projection_segments",
      "generation_projection_segments",
      "publication_subtasks",
      "runtime_pressure_counters",
      "runtime_pressure_counter_shards"
    ]) {
      expect(migration).toContain(`create table if not exists focowiki.${table}`);
    }
    expect(migration).toContain("large-scale-ingestion-runtime-v8");
    expect(migration).toContain("create or replace function focowiki.apply_runtime_pressure_delta");
    expect(migration).toContain("referencing old table as old_rows new table as new_rows");
    expect(migration).toContain("role_jobs_source_pressure_age_idx");
    expect(migration).toContain("early_claim_on_upstream_drain boolean default false not null");
    expect(migration).toContain("role_jobs_kb_upstream_active_idx");
    expect(migration).toContain("upload_sessions_kb_active_idx");
    expect(migration).toContain("publication_change_facts_kb_unassembled_idx");
    expect(migration).toContain("publication_change_facts_pressure_age_idx");
    expect(migration).toContain("publication_impacts_pressure_active_idx");
    expect(migration).toContain("source_dispatch_markers_pressure_active_idx");
    expect(migration).toContain("source_revisions_migration_page_idx");
    expect(migration).not.toContain("runtime_generation set generation = 'large-scale-ingestion-runtime-v8', updated_at");
    expect(migration).not.toContain("delete from focowiki.knowledge_bases");
    expect(migration).not.toContain("delete from focowiki.source_files");
  });

  it("recovers exhausted optimization migrations without replacing business data", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/009_optimization_migration_rebase_recovery.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("last_error_code = 'migration_slice_failed'");
    expect(migration).toContain("attempt_count = 0");
    expect(migration).toContain("prior_active_generation_id = knowledge_base.active_generation_id");
    expect(migration).toContain("optimization-migration-rebase-recovery-v9");
    expect(migration).not.toContain("delete from focowiki.knowledge_bases");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).not.toContain("delete from focowiki.projection_segments");
  });

  it("adds immutable body-search projections without rewriting legacy active projections", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/011_body_search_projection.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    for (const table of [
      "search_projection_documents",
      "search_projection_segments",
      "generation_search_projection_refs",
      "knowledge_base_lexical_rebuilds"
    ]) {
      expect(migration).toContain(`create table focowiki.${table}`);
    }
    expect(migration).toContain("body-search-projection-v11");
    expect(migration).toContain("generation_kind = any (array['normal', 'projection_repair', 'lexical_rebuild']");
    expect(migration).toContain("to_tsvector('simple'::regconfig, token_text)");
    expect(migration).toContain("using gin (lexical_vector)");
    expect(migration).toContain("using gin (lower(normalized_text) focowiki.gin_trgm_ops)");
    expect(migration).toContain("foreign key (knowledge_base_id, source_revision_id, source_file_id)");
    expect(migration).toContain("foreign key (knowledge_base_id, generation_id)");
    expect(migration).not.toContain("update focowiki.active_projection_records");
    expect(migration).not.toContain("delete from focowiki.active_projection_records");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).not.toContain("delete from focowiki.source_revisions");
  });

  it("recovers only stale deletion leases without deleting persisted data", () => {
    const migration = readFileSync(
      resolve(
        import.meta.dirname,
        "../migrations/012_storage_reconciliation_lease_recovery.sql"
      ),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("where state = 'deleting'");
    expect(migration).toContain("state = 'failed'");
    expect(migration).toContain("add column if not exists deletion_lease_token text");
    expect(migration).toContain("stale_deletion_lease_expired");
    expect(migration).toContain("interval '10 minutes'");
    expect(migration).toContain("storage-reconciliation-lease-recovery-v12");
    expect(migration).not.toContain("delete from");
    expect(migration).not.toContain("truncate ");
  });

  it("replaces locale-dependent tree ordering without rewriting business data", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/014_directory_order_repair.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain("active_projection_records_tree_byte_order_idx");
    expect(migration).toContain(
      "generation_directory_navigation_leaves_byte_order_idx"
    );
    expect(migration).toContain("collate \"c\"");
    expect(migration).toContain("directory-order-repair-v14");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).not.toContain("update focowiki.active_projection_records");
    expect(migration).not.toContain("truncate ");
  });

  it("keeps body trigram lookup knowledge-base scoped during lexical worker upgrade", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/015_lexical_rebuild_worker.sql"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain(
      "create extension if not exists btree_gin with schema focowiki"
    );
    expect(migration).toContain(
      "using gin ( knowledge_base_id focowiki.text_ops, lower(normalized_text) focowiki.gin_trgm_ops )"
    );
    expect(migration).not.toContain("delete from focowiki.knowledge_bases");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).not.toContain("delete from focowiki.source_revisions");
  });

  it("adds indexed object protection without running content or storage work", () => {
    const migration = readFileSync(
      resolve(
        import.meta.dirname,
        "../migrations/017_indexed_storage_object_protection.sql"
      ),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    for (const table of [
      "storage_object_protection_index",
      "storage_object_protection_dirty",
      "storage_object_protection_backfills",
      "storage_reconciliation_page_checkpoints",
      "storage_reconciliation_chunk_checkpoints"
    ]) {
      expect(migration).toContain(`create table if not exists focowiki.${table}`);
    }
    expect(migration).toContain("indexed-storage-object-protection-v17");
    expect(migration).toContain(
      "insert into focowiki.storage_object_protection_backfills"
    );
    expect(migration).not.toContain(
      "storage_object_protection_index_checksum_check"
    );
    expect(migration).not.toContain(
      "insert into focowiki.publication_generations"
    );
    expect(migration).not.toContain(
      "insert into focowiki.knowledge_base_maintenance_requests"
    );
    expect(migration).not.toContain("insert into focowiki.role_jobs");
    expect(migration).not.toContain("update focowiki.knowledge_bases");
    expect(migration).not.toContain("update focowiki.source_files");
    expect(migration).not.toContain("update focowiki.publication_generations");
    expect(migration).not.toContain("truncate ");
  });
});

function createGenerationDatabase(
  initialGeneration: string | "absent" | null,
  options: {
    unfinishedWork?: boolean;
    preflightCategory?:
      | "knowledgeBaseMaintenanceRequests"
      | "projectionRepairs"
      | "lexicalRebuilds"
      | "projectionCompactions"
      | "maintenanceCandidateGenerations";
  } = {}
) {
  let generation = initialGeneration;
  let unsafeCalls = 0;
  let beginCalls = 0;
  let preflightCalls = 0;
  const tagged = async (segments: TemplateStringsArray) => {
    const statement = segments.join(" ");
    if (statement.includes("to_regnamespace")) {
      return [{ schema_exists: generation !== "absent" }];
    }
    if (statement.includes("migration_capabilities")) {
      return [{
        maintenance_requests:
          options.preflightCategory === "knowledgeBaseMaintenanceRequests",
        projection_repairs: options.preflightCategory === "projectionRepairs",
        projection_repair_subtasks: false,
        lexical_rebuilds: options.preflightCategory === "lexicalRebuilds",
        lexical_rebuild_work_items: false,
        projection_compactions:
          options.preflightCategory === "projectionCompactions"
      }];
    }
    if (statement.includes("to_regclass")) {
      return [{ marker_exists: generation !== null }];
    }
    if (statement.includes("FROM focowiki.runtime_generation")) {
      return generation && generation !== "absent" ? [{ generation }] : [];
    }
    if (statement.includes("counts AS (")) {
      preflightCalls += 1;
      return [{
        source_files: 0,
        dispatch_markers: 0,
        role_jobs: options.unfinishedWork ? 1 : 0,
        publication_impacts: 0,
        frozen_generations: options.unfinishedWork ? 1 : 0,
        resource_operations: options.unfinishedWork ? 1 : 0,
        deletion_intents: options.unfinishedWork ? 1 : 0,
        upload_sessions: 0,
        cleanup_objects: 0,
        maintenance_candidate_generations:
          options.preflightCategory === "maintenanceCandidateGenerations" ? 1 : 0,
        capped: false
      }];
    }
    if (
      statement.includes("active_maintenance_requests")
      || statement.includes("active_projection_repairs")
      || statement.includes("active_lexical_rebuilds")
      || statement.includes("active_projection_compactions")
    ) {
      return [{ count: 1, capped: false }];
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
    get preflightCalls() {
      return preflightCalls;
    }
  };
}
