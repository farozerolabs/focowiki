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
    for (const table of [
      "knowledge_bases",
      "upload_tasks",
      "upload_task_events",
      "source_files",
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
    expect(sql).toContain("references focowiki.upload_tasks");
    expect(sql).toContain("references focowiki.releases");
    expect(sql).toContain("references focowiki.bundle_files");
    expect(sql).toContain("unique (release_id, logical_path)");
    expect(sql).toContain("unique (release_id, parent_path, name)");
    expect(sql).toContain("unique (task_id, phase_key)");
    expect(sql).toContain("check (phase_key in");
    expect(sql).toContain("'source_deletion'");
    expect(sql).toContain("check (severity in");
    expect(sql).toContain("check (entry_type in");
  });

  it("defines indexes for cursor pagination and scoped lookups", () => {
    const sql = readMigration();

    for (const index of [
      "knowledge_bases(deleted_at, created_at desc, id)",
      "upload_tasks(knowledge_base_id, started_at desc, id)",
      "upload_tasks(knowledge_base_id, operation, started_at desc, id)",
      "source_files(knowledge_base_id, task_id, created_at desc, id)",
      "source_files(knowledge_base_id, created_at desc, id)",
      "source_files(knowledge_base_id, deleted_at, created_at desc, id)",
      "upload_task_events(task_id, created_at, id)",
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

  it("defines deletion-aware source, bundle, and task metadata", () => {
    const sql = readMigration();

    expect(sql).toContain("deleted_at timestamptz");
    expect(sql).toContain("operation text not null default 'upload'");
    expect(sql).toContain("check (operation in ('upload', 'delete_source', 'delete_knowledge_base'))");
    expect(sql).toContain("source_file_id text references focowiki.source_files(id)");
    expect(sql).toContain("file_kind text not null");
    expect(sql).toContain(
      "check (file_kind in ('page', 'index', 'schema', 'manifest_index', 'search_index', 'link_index'))"
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
    expect(repository).toContain("result_release_id = ${input.releaseid}");
  });
});
