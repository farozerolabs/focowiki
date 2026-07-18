import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeBaseId } from "../src/db/admin-repositories.js";

const migrationPath = resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql");
const generationRepositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/publication-generation-repository.ts"
);
const activeReadRepositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-generation-read-repository.ts"
);

function readNormalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("incremental publication database baseline", () => {
  it("creates one destructive generation and active-projection schema", () => {
    const sql = readNormalized(migrationPath);

    expect(sql).toContain("create schema focowiki");
    expect(sql).toContain("create extension if not exists pg_trgm with schema focowiki");
    expect(sql).toContain("incremental-sharded-publication-v1");
    for (const table of [
      "knowledge_bases",
      "source_directories",
      "source_files",
      "source_revisions",
      "upload_sessions",
      "upload_session_entries",
      "source_path_reservations",
      "source_dispatch_markers",
      "publication_change_facts",
      "publication_generations",
      "publication_impacts",
      "publication_impact_causes",
      "publication_progress",
      "projection_shards",
      "generation_object_refs",
      "generation_projection_records",
      "active_object_refs",
      "active_projection_records",
      "directory_navigation_leaves",
      "directory_navigation_summaries",
      "role_jobs",
      "role_heartbeats",
      "deletion_intents",
      "cleanup_checkpoints",
      "cleanup_object_deletions",
      "immutable_objects",
      "runtime_generation"
    ]) {
      expect(sql).toContain(`create table focowiki.${table}`);
    }
  });

  it("removes release copies, shared workers, and compatibility artifacts", () => {
    const sql = readNormalized(migrationPath);

    for (const table of [
      "releases",
      "release_source_files",
      "release_source_directories",
      "bundle_files",
      "bundle_file_search_documents",
      "knowledge_file_tree_nodes",
      "knowledge_graph_nodes",
      "knowledge_graph_edges",
      "release_read_summaries",
      "worker_jobs",
      "publication_jobs"
    ]) {
      expect(sql).not.toContain(`create table focowiki.${table} `);
    }
    for (const removed of [
      "generated_bundle_file_id",
      "generated_bundle_file_path",
      "publication_dirty_at",
      "publication_visible_at",
      "add column if not exists",
      "drop column if exists",
      "legacy",
      "backfill"
    ]) {
      expect(sql).not.toContain(removed);
    }
  });

  it("keeps source bodies in object storage and revisions idempotent", () => {
    const sql = readNormalized(migrationPath);

    expect(sql).not.toMatch(/\b(raw_body|raw_content|markdown_body|json_body|file_body)\b/);
    expect(sql).toContain("object_key text not null");
    expect(sql).toContain("checksum_sha256 text not null");
    expect(sql).toContain("source_revisions_source_file_id_revision_key");
    expect(sql).toContain("source_dispatch_markers_source_revision_id_key");
    expect(sql).toContain("source_revisions_file_revision_idx");
    expect(sql).toContain("source_dispatch_markers_claim_idx");
  });

  it("indexes source revision references for bounded inverse deletion", () => {
    const sql = readNormalized(migrationPath);

    expect(sql).toContain("source_files_active_revision_idx");
    expect(sql).toContain("source_files_candidate_revision_idx");
  });

  it("defines resumable upload sessions without product admission quotas", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "idempotency_key text not null",
      "manifest_fingerprint text",
      "declared_file_count integer not null",
      "declared_byte_count bigint not null",
      "relative_path text not null",
      "sequence_number bigint not null",
      "staging_object_key text",
      "finalized_at timestamp with time zone",
      "upload_sessions_state_expiry_idx",
      "upload_session_entries_resume_idx",
      "upload_session_entries_finalization_idx"
    ]) {
      expect(sql).toContain(value);
    }
    expect(sql).not.toContain("max_upload_bytes");
    expect(sql).not.toContain("max_upload_files");
    expect(sql).not.toContain("upload_storage_concurrency");
  });

  it("constrains one active, one building, and one successor generation", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "publication_generations_one_active_idx",
      "publication_generations_one_frozen_idx",
      "publication_generations_one_open_successor_idx",
      "publication_generations_error_check",
      "publication_impacts_generation_id_projection_kind_projectio_key",
      "publication_impacts_claim_idx",
      "publication_impacts_dirty_shard_idx",
      "publication_progress_counts_check"
    ]) {
      expect(sql).toContain(value);
    }
  });

  it("defines immutable objects, structural sharing, and stable projection shards", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "immutable_objects_pkey primary key (checksum_sha256, format_version)",
      "immutable_objects_key_idx",
      "immutable_objects_gc_idx",
      "active_object_refs_knowledge_base_id_fkey foreign key (knowledge_base_id) references focowiki.knowledge_bases(id) on delete cascade",
      "generation_object_refs_pkey primary key (generation_id, ref_kind, ref_key)",
      "generation_projection_records_pkey primary key (generation_id, projection_kind, record_id)",
      "projection_shards_knowledge_base_id_projection_kind_shard_k_key",
      "projection_shards_lookup_idx",
      "directory_navigation_leaves_knowledge_base_id_directory_pat_key",
      "directory_navigation_summaries_pkey"
    ]) {
      expect(sql).toContain(value);
    }
  });

  it("indexes active file, tree, search, graph, and related-file reads", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "active_object_refs_path_idx",
      "active_object_refs_source_idx",
      "active_projection_records_path_idx",
      "active_projection_records_tree_idx",
      "active_projection_records_tree_search_trgm_idx",
      "active_projection_records_search_fts_idx",
      "active_projection_records_search_trgm_idx",
      "active_projection_records_graph_idx",
      "active_projection_records_graph_search_fts_idx",
      "active_projection_records_graph_search_trgm_idx"
    ]) {
      expect(sql).toContain(value);
    }
  });

  it("separates source, publication, and maintenance role claims", () => {
    const sql = readNormalized(migrationPath);

    expect(sql).toContain("role_jobs_role_check");
    expect(sql).toContain("'source'::text, 'publication'::text, 'maintenance'::text");
    expect(sql).toContain("role_jobs_claim_idx");
    expect(sql).toContain("role_jobs_publication_generation_active_idx");
    expect(sql).toContain("role_jobs_publication_generation_idx");
    expect(sql).toContain("role_jobs_source_revision_idx");
  });

  it("defines bounded inverse cleanup and deletion fences", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "deletion_intents_target_kind_check",
      "cleanup_checkpoints_phase_check",
      "cleanup_checkpoints_scope_idx",
      "cleanup_object_deletions_pending_idx",
      "source_files_deletion_intent_id_fkey",
      "source_directories_deletion_intent_id_fkey",
      "on delete cascade"
    ]) {
      expect(sql).toContain(value);
    }
  });

  it("cascades every knowledge-base-owned source and model record", () => {
    const sql = readNormalized(migrationPath);

    for (const constraint of [
      "model_invocations_knowledge_base_id_fkey",
      "source_file_events_knowledge_base_id_fkey",
      "source_file_graph_edges_knowledge_base_id_fkey",
      "source_file_graph_jobs_knowledge_base_id_fkey",
      "source_file_graph_nodes_knowledge_base_id_fkey",
      "source_file_retry_attempts_knowledge_base_id_fkey",
      "source_files_knowledge_base_id_fkey"
    ]) {
      expect(sql).toMatch(new RegExp(
        `add constraint ${constraint} foreign key \\(knowledge_base_id\\) `
        + "references focowiki\\.knowledge_bases\\(id\\) on delete cascade"
      ));
    }
  });

  it("keeps terminal failure, key, webhook, model, and settings contracts", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "source_files_terminal_failure_check",
      "source_files_terminal_failure_stage_check",
      "source_files_terminal_failure_retry_kind_check",
      "public_api_keys_active_hash_idx",
      "runtime_settings_key_check",
      "model_configs_api_mode_check",
      "webhook_subscriptions",
      "webhook_deliveries"
    ]) {
      expect(sql).toContain(value);
    }
    expect(sql).not.toMatch(/\b(raw_key|plain_key|api_key_secret|key_value)\b/);
  });

  it("uses URL-safe opaque knowledge-base identifiers", () => {
    const id = createKnowledgeBaseId();

    expect(id).toMatch(/^kb-[a-z0-9-]+$/);
    expect(id).not.toContain("developer");
    expect(id).not.toContain(" ");
  });

  it("resolves one active generation per request and activates with a locked CAS", () => {
    const generationRepository = readNormalized(generationRepositoryPath);
    const activeReads = readNormalized(activeReadRepositoryPath);

    expect(activeReads).toContain("select active_generation_id");
    expect(activeReads).toContain("const generationid = rows[0]?.active_generation_id");
    expect(generationRepository).toContain("select active_generation_id");
    expect(generationRepository).toContain("for update");
    expect(generationRepository).toContain("active_generation_id !== input.expectedpredecessorgenerationid");
    expect(generationRepository).toContain("set active_generation_id = ${input.generationid}");
  });
});
