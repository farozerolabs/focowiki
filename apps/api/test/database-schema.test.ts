import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrapPath = resolve(
  import.meta.dirname,
  "../migrations/001_storage_vnext.sql"
);

function readNormalized(): string {
  return readFileSync(bootstrapPath, "utf8").replace(/\s+/gu, " ").toLowerCase();
}

describe("storage vNext database baseline", () => {
  it("creates each named authority and lifecycle family", () => {
    const sql = readNormalized();

    for (const table of [
      "knowledge_bases",
      "source_directories",
      "source_files",
      "source_event_summaries",
      "source_revisions",
      "source_file_current_revisions",
      "runtime_setting_revisions",
      "runtime_setting_current",
      "model_configs",
      "public_api_keys",
      "webhook_subscriptions",
      "graph_nodes",
      "graph_edges",
      "graph_evidence_refs",
      "release_roots",
      "release_shards",
      "release_root_shards",
      "release_catalog_entries",
      "directory_summaries",
      "knowledge_base_summaries",
      "object_registrations",
      "object_owners",
      "search_projections",
      "active_snapshots",
      "release_candidates",
      "release_candidate_changed_facts",
      "release_candidate_dependencies",
      "release_candidate_validations",
      "operations",
      "operation_work_items",
      "operation_dependencies",
      "operation_idempotency",
      "cleanup_actions",
      "upload_sessions",
      "upload_entries",
      "webhook_deliveries",
      "operation_results",
      "security_audit_events",
      "diagnostic_events",
      "deployment_scopes",
      "deployment_states",
      "rebuild_checkpoints",
      "validation_evidence",
      "rollback_evidence",
      "retirement_evidence",
      "runtime_generation"
    ]) {
      expect(sql, table).toContain(`create table focowiki.${table}`);
    }
  });

  it("stores source bodies and searchable documents outside PostgreSQL", () => {
    const sql = readNormalized();

    expect(sql).not.toMatch(
      /\b(raw_body|raw_content|markdown_body|json_body|file_body|search_body)\b/u
    );
    expect(sql).not.toContain("to_tsvector");
    expect(sql).not.toContain("tsvector");
    expect(sql).not.toContain("gin_trgm_ops");
    expect(sql).toContain("source_revisions");
    expect(sql).toContain("object_id text not null");
    expect(sql).toContain("checksum_sha256 text not null");
  });

  it("writes the schema marker only after all vNext relations", () => {
    const sql = readNormalized();
    const markerTable = sql.indexOf("create table focowiki.runtime_generation");
    const markerInsert = sql.indexOf("insert into focowiki.runtime_generation");

    expect(markerTable).toBeGreaterThan(sql.indexOf("create table focowiki.retirement_evidence"));
    expect(markerInsert).toBeGreaterThan(markerTable);
    expect(sql).toContain("values (true, 'storage-vnext-v1')");
  });
});
