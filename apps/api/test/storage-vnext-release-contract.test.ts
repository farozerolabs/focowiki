import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const portsPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/release/ports.ts"
);
const repositoryPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/release/postgres-repository.ts"
);
const migrationPath = resolve(
  workspaceRoot,
  "apps/api/migrations/001_storage_vnext.sql"
);
const ports = readFileSync(portsPath, "utf8");
const migration = readFileSync(migrationPath, "utf8")
  .replace(/\s+/gu, " ")
  .replace(/\(\s+/gu, "(")
  .replace(/\s+\)/gu, ")")
  .toLowerCase();

describe("storage vNext bounded release contract", () => {
  it("models bounded candidate facts, dependencies, shards, and rollback lifetime", () => {
    for (const required of [
      "MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS",
      "MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES",
      "MAX_STORAGE_VNEXT_CANDIDATE_SHARDS",
      "StorageVnextCandidateChangedFact",
      "StorageVnextCandidateDependency",
      "StorageVnextReleaseCatalogEntry",
      "StorageVnextDirectorySummary",
      "StorageVnextKnowledgeBaseSummary"
    ]) {
      expect(ports, required).toContain(required);
    }
    expect(ports).toMatch(
      /StorageVnextReleaseRoot[\s\S]*role:[\s\S]*expiresAt:/u
    );
  });

  it("creates one candidate against an expected active root without full copy-forward", () => {
    expect(ports).toMatch(
      /createCandidate\(input:[\s\S]*operationPublicId:[\s\S]*candidateRootPublicId:[\s\S]*expectedActiveRootPublicId:[\s\S]*expectedActiveRevision:[\s\S]*changedFacts:[\s\S]*dependencies:/u
    );
    expect(ports).not.toMatch(
      /copyForward|cloneActive|fullGeneration|projectionRecords|activeRecords|activeObjectRefs/u
    );
  });

  it("requires a small compare-and-swap activation and explicit terminal convergence", () => {
    expect(ports).toMatch(
      /activateCandidate\(input:[\s\S]*candidatePublicId:[\s\S]*expectedActiveRootPublicId:[\s\S]*expectedActiveRevision:[\s\S]*activatedAt:/u
    );
    expect(ports).toContain("StorageVnextCandidateActivationResult");
    expect(ports).toMatch(/outcome:\s*"activated"/u);
    expect(ports).toMatch(/outcome:\s*"stale"/u);
    expect(ports).toMatch(
      /terminateCandidate\(input:[\s\S]*outcome:[\s\S]*failed[\s\S]*cancelled[\s\S]*superseded[\s\S]*timed_out/u
    );
    expect(ports).toMatch(
      /expireRollbackRoot\(input:[\s\S]*knowledgeBaseId:[\s\S]*expiredBefore:/u
    );
  });

  it("enforces one role root, one candidate, bounded rollback, and shared shards in PostgreSQL", () => {
    for (const constraint of [
      "release_roots_role_key unique (knowledge_base_id, root_slot)",
      "release_roots_base_fkey foreign key (knowledge_base_id, base_root_public_id)",
      "release_roots_expiry_check check",
      "release_candidates_knowledge_base_key unique (knowledge_base_id)",
      "release_candidate_changed_facts_candidate_fkey foreign key (knowledge_base_id, candidate_public_id)",
      "release_candidate_dependencies_candidate_fkey foreign key (knowledge_base_id, candidate_public_id)",
      "release_root_shards_shard_fkey foreign key (knowledge_base_id, release_shard_public_id)"
    ]) {
      expect(migration, constraint).toContain(constraint);
    }
    expect(migration).toContain("manifest_checksum_sha256 text,");
    expect(migration).toContain(
      "(root_role = 'candidate' or manifest_checksum_sha256 is not null)"
    );
  });

  it("implements a normalized repository with structural sharing and no legacy history authority", () => {
    expect(existsSync(repositoryPath)).toBe(true);
    if (!existsSync(repositoryPath)) return;
    const repository = readFileSync(repositoryPath, "utf8");
    for (const required of [
      "release_candidate_changed_facts",
      "release_candidate_dependencies",
      "release_root_shards",
      "active_snapshots",
      "object_owners",
      "FOR UPDATE"
    ]) {
      expect(repository, required).toContain(required);
    }
    expect(repository).not.toMatch(
      /publication_generations|generation_projection_records|generation_object_refs|active_projection_records|active_object_refs|\bOFFSET\b/u
    );
  });

  it("exposes only bounded release summaries instead of complete Generation history", () => {
    expect(ports).toContain("StorageVnextReleaseEventSummary");
    expect(ports).toMatch(
      /listReleaseEvents\(input:[\s\S]*knowledgeBaseId:[\s\S]*limit:[\s\S]*cursor:/u
    );
    expect(ports).not.toMatch(
      /listGenerations|getGenerationHistory|historicalProjection|historicalObject/u
    );
  });
});
