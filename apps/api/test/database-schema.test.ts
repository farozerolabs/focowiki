import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeBaseId } from "../src/db/admin-repositories.js";

const migrationPath = resolve(
  import.meta.dirname,
  "../migrations/001_production_admin_web.sql"
);
const repositoryPath = resolve(import.meta.dirname, "../src/db/admin-repositories.ts");

function readMigration(): string {
  return readFileSync(migrationPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

function readRepository(): string {
  return readFileSync(repositoryPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("database schema migration", () => {
  it("creates the focowiki schema and production admin tables", () => {
    const sql = readMigration();

    expect(sql).toContain("create schema if not exists focowiki");
    expect(sql).toContain("drop table if exists focowiki.upload_task_events cascade");
    expect(sql).toContain("drop table if exists focowiki.upload_tasks cascade");
    for (const table of [
      "knowledge_bases",
      "source_files",
      "source_file_events",
      "source_file_retry_attempts",
      "model_invocations",
      "releases",
      "bundle_files",
      "bundle_tree_entries",
      "public_api_keys"
    ]) {
      expect(sql).toContain(`create table if not exists focowiki.${table}`);
    }
  });

  it("keeps raw file bodies out of database records", () => {
    const sql = readMigration();

    expect(sql).not.toMatch(/\b(raw_body|raw_content|markdown_body|json_body|file_body)\b/);
    expect(sql).toContain("object_key");
    expect(sql).toContain("checksum_sha256");
  });

  it("defines constraints for lifecycle, storage, and tree integrity", () => {
    const sql = readMigration();

    expect(sql).toContain("references focowiki.knowledge_bases");
    expect(sql).toContain("references focowiki.source_files");
    expect(sql).toContain("references focowiki.releases");
    expect(sql).toContain("references focowiki.bundle_files");
    expect(sql).toContain("unique (release_id, logical_path)");
    expect(sql).toContain("unique (release_id, parent_path, name)");
    expect(sql).toContain("check (stage_key in");
    expect(sql).toContain("'source_deletion'");
    expect(sql).toContain("check (severity in");
    expect(sql).toContain("check (entry_type in");
  });

  it("defines indexes for cursor pagination and scoped lookups", () => {
    const sql = readMigration();

    for (const index of [
      "knowledge_bases(deleted_at, created_at desc, id)",
      "source_files(knowledge_base_id, created_at desc, id)",
      "source_files(knowledge_base_id, deleted_at, created_at desc, id)",
      "source_files(knowledge_base_id, processing_status, processing_stage, created_at desc, id)",
      "model_invocations(source_file_id, created_at desc, id)",
      "source_file_events(knowledge_base_id, source_file_id, created_at, id)",
      "source_file_retry_attempts(knowledge_base_id, source_file_id, created_at desc, id)",
      "releases(knowledge_base_id, published_at desc, id)",
      "bundle_files(knowledge_base_id, release_id, logical_path, id)",
      "bundle_files(knowledge_base_id, release_id, source_file_id, id)",
      "bundle_tree_entries(knowledge_base_id, release_id, parent_path, name, id)",
      "public_api_keys(created_at desc, id)",
      "public_api_keys(status, created_at desc, id)"
    ]) {
      expect(sql).toContain(index);
    }
  });

  it("removes upload task repository code paths", () => {
    const repository = readRepository();

    expect(repository).not.toContain("upload_tasks");
    expect(repository).not.toContain("upload_task_events");
    expect(repository).not.toContain("createuploadtask");
    expect(repository).not.toContain("processingprogressmap");
  });

  it("defines deletion-aware source, bundle, and file processing metadata", () => {
    const sql = readMigration();

    expect(sql).toContain("deleted_at timestamptz");
    expect(sql).toContain("source_file_id text references focowiki.source_files(id)");
    expect(sql).toContain("processing_status text not null default 'queued'");
    expect(sql).toContain("processing_stage text not null default 'upload_storage'");
    expect(sql).toContain("retry_count integer not null default 0");
    expect(sql).toContain("model_suggestions_json jsonb");
    expect(sql).toContain("'llm_suggestion'");
    expect(sql).toContain("check (status in ('running', 'completed', 'failed', 'skipped'))");
    expect(sql).toContain("check (processing_status in ('queued', 'running', 'completed', 'failed'))");
    expect(sql).toContain("file_kind text not null");
    expect(sql).toContain(
      "check (file_kind in ('page', 'index', 'log', 'schema', 'manifest_index', 'search_index', 'link_index'))"
    );
    expect(sql).toContain("(file_kind = 'page' and source_file_id is not null)");
    expect(sql).toContain("(file_kind <> 'page' and source_file_id is null)");
  });

  it("uses URL-safe opaque knowledge base identifiers", () => {
    const id = createKnowledgeBaseId();

    expect(id).toMatch(/^kb-[a-z0-9-]+$/);
    expect(id).not.toContain("developer");
    expect(id).not.toContain(" ");
  });

  it("enforces non-deleted name uniqueness and soft-delete exclusion", () => {
    const sql = readMigration();
    const repository = readRepository();

    expect(sql).toContain("on focowiki.knowledge_bases(lower(name)) where deleted_at is null");
    expect(repository).toContain("where deleted_at is null");
    expect(repository).toContain("where id = ${id} and deleted_at is null");
    expect(repository).toContain("and deleted_at is null");
    expect(repository).not.toContain("legacy");
    expect(repository).not.toContain("backfill");
  });

  it("stores public OpenAPI keys as hash-only records", () => {
    const sql = readMigration();

    expect(sql).toContain("create table if not exists focowiki.public_api_keys");
    expect(sql).toContain("key_hash text not null unique");
    expect(sql).toContain("key_prefix text not null");
    expect(sql).toContain("key_suffix text not null");
    expect(sql).toContain("check (status in ('active', 'revoked'))");
    expect(sql).toContain("public_api_keys_active_hash_idx");
    expect(sql).not.toMatch(/\b(raw_key|plain_key|api_key_secret|key_value)\b/);
  });

  it("updates active releases in a database transaction", () => {
    const repository = readRepository();

    expect(repository).toContain("await sql.begin");
    expect(repository).toContain("active_release_id = ${input.releaseid}");
    expect(repository).not.toContain("result_release_id = ${input.releaseid}");
  });
});
