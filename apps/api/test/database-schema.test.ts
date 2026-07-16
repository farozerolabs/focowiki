import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeBaseId } from "../src/db/admin-repositories.js";

const migrationPath = resolve(import.meta.dirname, "../migrations/001_production_admin_web.sql");
const repositoryPath = resolve(import.meta.dirname, "../src/db/admin-repositories.ts");
const fileGraphRepositoryPath = resolve(import.meta.dirname, "../src/db/file-graph-repository.ts");

function readNormalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("resource-editing database baseline", () => {
  it("creates one clean relation-search-publication schema", () => {
    const sql = readNormalized(migrationPath);

    expect(sql).toContain("create schema focowiki");
    expect(sql).toContain("create extension pg_trgm with schema focowiki");
    expect(sql).toContain("values (true, 'relation-search-publication-v1')");
    for (const table of [
      "knowledge_bases",
      "source_directories",
      "source_files",
      "source_revisions",
      "upload_sessions",
      "upload_session_entries",
      "source_path_reservations",
      "deletion_intents",
      "resource_operations",
      "resource_operation_targets",
      "resource_path_reservations",
      "releases",
      "release_source_directories",
      "release_source_files",
      "release_resource_operations",
      "release_markdown_links",
      "bundle_files",
      "bundle_file_search_documents",
      "knowledge_file_tree_nodes",
      "knowledge_graph_nodes",
      "knowledge_graph_edges",
      "knowledge_graph_search_documents",
      "knowledge_graph_insights",
      "release_read_summaries",
      "source_file_graph_nodes",
      "source_file_graph_edges",
      "worker_jobs",
      "worker_queue_summaries",
      "hard_delete_object_deletions",
      "runtime_generation"
    ]) {
      expect(sql).toContain(`create table focowiki.${table}`);
    }
  });

  it("removes every previous flat-file and compatibility artifact", () => {
    const sql = readNormalized(migrationPath);
    const repository = readNormalized(repositoryPath);

    for (const removed of [
      "knowledge_files",
      "original_name",
      "internal_migration_markers",
      "upload_tasks",
      "upload_task_events",
      "add column if not exists",
      "drop column if exists",
      "legacy",
      "backfill"
    ]) {
      expect(sql).not.toContain(removed);
    }
    expect(repository).not.toContain("createSourceFiles");
    expect(repository).not.toContain("hasActiveSourceFileNames");
    expect(repository).not.toContain("focowiki.knowledge_files");
  });

  it("keeps raw Markdown bodies in object storage", () => {
    const sql = readNormalized(migrationPath);

    expect(sql).not.toMatch(/\b(raw_body|raw_content|markdown_body|json_body|file_body)\b/);
    expect(sql).toContain("object_key text not null");
    expect(sql).toContain("checksum_sha256 text not null");
  });

  it("defines nested source identity and immutable revisions", () => {
    const sql = readNormalized(migrationPath);

    for (const field of [
      "parent_id text",
      "name text not null",
      "relative_path text not null",
      "path_key text not null",
      "directory_id text",
      "active_revision_id text not null",
      "resource_revision integer default 1 not null",
      "content_revision integer default 1 not null",
      "candidate_operation_id text",
      "candidate_relative_path text",
      "candidate_revision_id text"
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain("source_files_active_revision_id_fkey");
    expect(sql).toContain("deferrable initially deferred");
    expect(sql).toContain("source_revisions_source_file_id_fkey");
    expect(sql).toContain("source_files_active_path_key_idx");
    expect(sql).toContain("source_directories_active_path_key_idx");
    expect(sql).toContain("source_directories_parent_cursor_idx");
    expect(sql).toContain("source_files_directory_cursor_idx");
    expect(sql).toContain("source_files_resource_cursor_idx");
    expect(sql).toContain("source_files_resource_processing_idx");
    expect(sql).toContain("source_files_resource_id_prefix_idx");
    expect(sql).toContain("source_files_resource_relative_path_trgm_idx");
  });

  it("defines resumable upload sessions and durable path reservations", () => {
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
      "upload_required",
      "skipped_existing",
      "waiting_reservation",
      "rejected_deleting",
      "upload_sessions_state_expiry_idx",
      "upload_session_entries_resume_idx",
      "upload_session_entries_path_disposition_idx",
      "upload_session_entries_finalization_idx",
      "source_path_reservations_expiry_idx"
    ]) {
      expect(sql).toContain(value);
    }
  });

  it("defines durable mutations, deletion ownership, and bounded cleanup state", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "create table focowiki.deletion_intents",
      "create table focowiki.resource_operations",
      "create table focowiki.resource_operation_targets",
      "create table focowiki.release_resource_operations",
      "request_fingerprint text not null",
      "expected_resource_revision integer",
      "candidate_catalog_generation bigint not null",
      "source_directory_delete",
      "knowledge_base_delete",
      "hard_delete_stage text",
      "hard_delete_cursor_json jsonb",
      "hard_delete_object_deletions_job_pending_idx",
      "deletion_intents_owner_idx",
      "resource_operations_fingerprint_idx"
    ]) {
      expect(sql).toContain(value);
    }
  });

  it("defines nested release, navigation, search, and graph projections", () => {
    const sql = readNormalized(migrationPath);
    const graphRepository = readNormalized(fileGraphRepositoryPath);

    for (const value of [
      "unique (release_id, logical_path)",
      "navigation_only boolean default false not null",
      "source_directory_id text",
      "direct_file_count integer default 0 not null",
      "descendant_file_count integer default 0 not null",
      "bundle_files_release_logical_cursor_idx",
      "release_source_directories_path_cursor_idx",
      "release_source_files_path_cursor_idx",
      "release_resource_operations_operation_idx",
      "release_markdown_links_cursor_idx",
      "release_markdown_links_source_idx",
      "bundle_file_search_documents_search_text_trgm_idx",
      "bundle_file_search_documents_metadata_text_trgm_idx",
      "bundle_file_search_documents_path_text_trgm_idx",
      "bundle_file_search_documents_release_cursor_idx",
      "knowledge_file_tree_nodes_source_directory_idx",
      "knowledge_file_tree_nodes_search_text_trgm_idx",
      "knowledge_file_tree_nodes_search_cursor_idx",
      "knowledge_graph_search_documents_search_text_trgm_idx",
      "knowledge_graph_search_documents_neighbor_text_trgm_idx",
      "knowledge_graph_search_documents_release_cursor_idx",
      "release_read_summaries_knowledge_base_idx"
    ]) {
      expect(sql).toContain(value);
    }
    expect(graphRepository).toContain("focowiki.bundle_files");
    expect(graphRepository).toContain("focowiki.knowledge_graph_nodes");
    expect(graphRepository).toContain("focowiki.knowledge_graph_edges");
    expect(graphRepository).not.toContain("focowiki.knowledge_files");
  });

  it("keeps queue, audit, key, webhook, and runtime-setting constraints", () => {
    const sql = readNormalized(migrationPath);

    for (const value of [
      "source_file_processing",
      "upload_session_finalization",
      "resource_operation",
      "publication",
      "hard_delete",
      "dead_letter",
      "worker_jobs_claim_idx",
      "worker_jobs_running_heartbeat_idx",
      "worker_jobs_upload_finalization_active_idx",
      "key_hash text not null",
      "public_api_keys_active_hash_idx",
      "runtime_settings",
      "model_configs",
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

  it("activates releases and candidate source mappings atomically", () => {
    const repository = readNormalized(repositoryPath);
    const activeReadProjection = repository.slice(
      repository.indexOf("const source_file_select_columns"),
      repository.indexOf("const source_file_processing_select_columns")
    );

    expect(repository).toContain("await sql.begin");
    expect(repository).toContain("active_release_id = ${input.releaseid}");
    expect(repository).toContain("candidate_operation_id = null");
    expect(repository).toContain("active_revision_id = coalesce(source.candidate_revision_id");
    expect(repository).toContain("object_key = coalesce(source.candidate_object_key, source.object_key)");
    expect(activeReadProjection).not.toContain(
      "coalesce(source.candidate_object_key, source.object_key) as object_key"
    );
  });
});
