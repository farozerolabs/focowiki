import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const migration = read("apps/api/migrations/001_storage_vnext.sql")
  .replace(/\s+/gu, " ")
  .toLowerCase();
const sourceRevision = read(
  "apps/api/src/storage-vnext/catalog/source-revision-service.ts"
);
const release = read("apps/api/src/storage-vnext/release/postgres-repository.ts");
const searchDocuments = read("apps/api/src/storage-vnext/search/documents.ts");
const searchRepository = read("apps/api/src/storage-vnext/search/postgres-repository.ts");
const workflow = read("apps/api/src/storage-vnext/workflow/postgres-repository.ts");

describe("storage vNext retry nonmultiplication contract", () => {
  it("binds one source revision to the file and content checksum", () => {
    expect(sourceRevision).toContain("createStorageVnextSourceRevisionPublicId");
    expect(sourceRevision).toContain("sourceFilePublicId");
    expect(sourceRevision).toContain("checksum");
    expect(migration).toContain(
      "source_revisions_content_key unique ( knowledge_base_id, source_file_public_id, checksum_sha256 )"
    );
  });

  it("allows only one candidate root per knowledge base and reuses its identity", () => {
    expect(migration).toContain(
      "release_candidates_knowledge_base_key unique (knowledge_base_id)"
    );
    expect(migration).toContain(
      "release_roots_role_key unique (knowledge_base_id, root_slot)"
    );
    expect(release).toContain("existing.public_id === input.publicId");
  });

  it("deduplicates object registrations and owner identities", () => {
    expect(migration).toContain("object_id text primary key");
    expect(migration).toContain(
      "object_registrations_write_attempt_key unique (write_attempt_public_id)"
    );
    expect(migration).toContain(
      "object_owners_identity_key unique (object_id, owner_kind, owner_public_id)"
    );
  });

  it("uses stable document IDs and completes each unified-index batch ordinal once", () => {
    expect(searchDocuments).toContain('id: "content-" + digest');
    expect(searchDocuments).toContain('id: "graph-seed-" + digest');
    expect(searchRepository).toContain("last_batch_ordinal = ${input.batchOrdinal}");
    expect(searchRepository).toContain(
      "AND next_batch_ordinal = ${input.batchOrdinal}"
    );
  });

  it("deduplicates graph relationships independently of public ID", () => {
    expect(migration).toContain(
      "graph_edges_relationship_key unique ( knowledge_base_id, from_node_public_id, to_node_public_id, relation )"
    );
  });

  it("rechecks the bounded result after a concurrent terminal delete loses the row", () => {
    const completion = workflow.slice(
      workflow.indexOf("async complete(input)"),
      workflow.indexOf("async listResults(input)")
    );
    expect(completion.match(/readResult\(transaction, input\.publicId\)/gu))
      .toHaveLength(2);
    expect(completion).toContain("sameStorageVnextResult(concurrent, input.result)");
  });

  it("keeps exactly one terminal row for each operation", () => {
    expect(migration).toContain("create table focowiki.operation_results ( public_id text primary key");
    expect(workflow).toMatch(/DELETE FROM focowiki\.operation_work_items/u);
    expect(workflow).toMatch(/INSERT INTO focowiki\.operation_results/u);
  });

  it("replaces user-visible summary counts instead of incrementing them", () => {
    const summaries = release.slice(
      release.indexOf("async replaceCandidateSummaries(input)"),
      release.indexOf("async markCandidateValidating(input)")
    );
    expect(summaries).toContain("ON CONFLICT (release_root_public_id) DO UPDATE");
    expect(summaries).toContain("source_file_count = EXCLUDED.source_file_count");
    expect(summaries).toContain("generated_entry_count = EXCLUDED.generated_entry_count");
    expect(summaries).not.toMatch(/\w+_count\s*=\s*\w+_count\s*\+/u);
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}
