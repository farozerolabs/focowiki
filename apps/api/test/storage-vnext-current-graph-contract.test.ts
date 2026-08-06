import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const portsPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/graph/ports.ts"
);
const repositoryPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/graph/postgres-repository.ts"
);
const openApiReadPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/api/postgres-openapi-read.ts"
);
const migrationPath = resolve(
  workspaceRoot,
  "apps/api/migrations/001_storage_vnext.sql"
);
const ports = readFileSync(portsPath, "utf8");
const migration = readFileSync(migrationPath, "utf8")
  .replace(/\s+/gu, " ")
  .toLowerCase();

describe("storage vNext one-current-graph contract", () => {
  it("requires source-revision-bound nodes and bounded readable Markdown evidence", () => {
    expect(ports).toMatch(
      /StorageVnextGraphEvidence[\s\S]*publicId:[\s\S]*sourceRevisionPublicId:/u
    );
    expect(ports).toMatch(
      /StorageVnextGraphNodeFact[\s\S]*sourceRevisionPublicId:[\s\S]*logicalPath:/u
    );
    expect(ports).toContain("MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS");
    expect(ports).toMatch(
      /replaceSourceFileGraph[\s\S]*sourceRevisionPublicId:[\s\S]*node:[\s\S]*edges:/u
    );
  });

  it("requires one current node and one accepted edge identity in PostgreSQL", () => {
    expect(migration).toMatch(
      /constraint graph_nodes_source_file_key unique \(\s*knowledge_base_id, source_file_public_id\s*\)/u
    );
    expect(migration).toMatch(
      /constraint graph_edges_relationship_key unique \(\s*knowledge_base_id, from_node_public_id, to_node_public_id, relation\s*\)/u
    );
    expect(migration).toContain(
      "source_revision_public_id text not null"
    );
    expect(migration).toContain(
      "graph_evidence_refs_source_revision_fkey foreign key ( knowledge_base_id, source_file_public_id, source_revision_public_id )"
    );
  });

  it("requires the normalized repository and rejects duplicate graph authorities", () => {
    expect(existsSync(repositoryPath)).toBe(true);
    if (!existsSync(repositoryPath)) return;
    const repository = readFileSync(repositoryPath, "utf8");
    expect(repository).toContain("MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS");
    expect(repository).toContain("source_file_current_revisions");
    expect(repository).toContain("graph_evidence_refs");
    expect(repository).not.toMatch(
      /profile_json|term_documents|term_frequencies|rejectedEdges|\bOFFSET\b/u
    );
  });

  it("keeps graph facts storage-neutral and free of body or provider payloads", () => {
    for (const forbidden of [
      "body:",
      "markdown:",
      "profile:",
      "lexicalText:",
      "exactTerms:",
      "phraseTerms:",
      "postgres",
      "meilisearch",
      "redis",
      "s3"
    ]) {
      expect(ports.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    expect(ports).toMatch(
      /reason:\s*string\s*\|\s*null/u
    );
  });

  it("reads search relationship paths from the current graph without expanding the release catalog", () => {
    const openApiRead = readFileSync(openApiReadPath, "utf8");
    const graphContextRead = openApiRead.match(
      /export async function listStorageVnextSearchGraphContexts[\s\S]*?\n\}\n\nexport async function resolveStorageVnextGraphSeed/u
    )?.[0];

    expect(graphContextRead).toBeDefined();
    expect(graphContextRead).toContain("related.logical_path");
    expect(graphContextRead).not.toContain("resolve_release_catalog(");
    expect(graphContextRead).not.toContain("release_roots");
  });
});
