import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8")
    .replace(/\s+/gu, " ")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")");
}

describe("storage vNext unified search index contract", () => {
  it("keeps one active and one live candidate while retaining failed cleanup owners", () => {
    const migration = read("apps/api/migrations/001_storage_vnext.sql").toLowerCase();

    expect(migration).not.toContain("search_kind");
    expect(migration).toContain(
      "create unique index search_projections_active_role_uniq_idx on focowiki.search_projections (knowledge_base_id) where projection_role = 'active'"
    );
    expect(migration).toContain(
      "create unique index search_projections_live_candidate_uniq_idx on focowiki.search_projections (knowledge_base_id) where projection_role = 'candidate' and state in ('preparing', 'indexing', 'validating', 'ready')"
    );
  });

  it("shares the projection lifecycle across content and graph-seed documents", () => {
    const ports = read("apps/api/src/storage-vnext/search/ports.ts");
    const documents = read("apps/api/src/storage-vnext/search/documents.ts");

    expect(documents).toContain(
      "StorageVnextSearchDocument = | StorageVnextContentDocument | StorageVnextGraphSeedDocument"
    );
    expect(ports).toContain("documents: readonly StorageVnextSearchDocument[]");
    expect(ports).not.toContain("activateCandidate");
  });

  it("does not put a document kind into the provider index identity", () => {
    const identity = read(
      "apps/api/src/storage-vnext/search/candidate-identity.ts"
    );

    expect(identity).toContain("knowledgeBaseId: string");
    expect(identity).toContain("candidatePublicId: string");
    expect(identity).not.toContain("documentKind");
    expect(identity).not.toContain("searchKind");
    expect(identity).not.toContain("graph_seed");
  });

  it("uses the release CAS as the sole atomic public index switch", () => {
    const repository = read(
      "apps/api/src/storage-vnext/release/postgres-repository.ts"
    );

    expect(repository).toContain(
      "search_projection_public_id = EXCLUDED.search_projection_public_id"
    );
    expect(repository).toContain("projection_role = 'active'");
    expect(repository).not.toContain("swapIndexes");
  });
});
