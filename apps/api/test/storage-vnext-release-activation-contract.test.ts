import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const ports = readFileSync(
  resolve(workspaceRoot, "apps/api/src/storage-vnext/release/ports.ts"),
  "utf8"
);
const repository = readFileSync(
  resolve(workspaceRoot, "apps/api/src/storage-vnext/release/postgres-repository.ts"),
  "utf8"
);
const migration = readFileSync(
  resolve(workspaceRoot, "apps/api/migrations/001_storage_vnext.sql"),
  "utf8"
).replace(/\s+/gu, " ").toLowerCase();

describe("storage vNext validated CAS activation contract", () => {
  it("binds one successful validation receipt to candidate manifest and search", () => {
    expect(ports).toMatch(
      /StorageVnextCandidateValidationReceipt[\s\S]*manifestChecksum:[\s\S]*searchProjectionPublicId:[\s\S]*objectValidationPassed:[\s\S]*searchValidationPassed:[\s\S]*graphValidationPassed:[\s\S]*linkValidationPassed:[\s\S]*countValidationPassed:[\s\S]*pathValidationPassed:/u
    );
    expect(ports).toMatch(
      /recordCandidateValidation\(input:\s*StorageVnextCandidateValidationReceipt\):\s*Promise<boolean>/u
    );
    expect(migration).toContain("create table focowiki.release_candidate_validations");
    for (const column of [
      "object_validation_passed boolean not null",
      "search_validation_passed boolean not null",
      "graph_validation_passed boolean not null",
      "link_validation_passed boolean not null",
      "count_validation_passed boolean not null",
      "path_validation_passed boolean not null"
    ]) {
      expect(migration, column).toContain(column);
    }
  });

  it("requires the receipt and exact expected pointer inside activation", () => {
    expect(repository).toContain("release_candidate_validations");
    expect(repository).toContain("search_projection_public_id");
    expect(repository).toContain("manifest_checksum_sha256");
    expect(repository).toContain("FOR UPDATE");
    expect(repository).toContain("RETURNING knowledge_base_id");
    expect(repository).not.toMatch(
      /copyForward|cloneActive|generation_projection_records|active_projection_records/u
    );
  });

  it("keeps rollback cleanup outside the pointer-swap transaction", () => {
    expect(ports).toMatch(/outcome:\s*"rollback_pending"/u);
    const activationStart = repository.indexOf("async activateCandidate(input)");
    const activationEnd = repository.indexOf("async terminateCandidate(input)");
    const activation = repository.slice(activationStart, activationEnd);
    expect(activation).not.toContain("deleteRootAndReleaseObjects");
    expect(activation).not.toMatch(/release_catalog_entries[\s\S]*INSERT|release_root_shards[\s\S]*INSERT/u);
  });
});
