import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const migration = read("apps/api/migrations/001_storage_vnext.sql");
const repositoryPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/maintenance/postgres-repository.ts"
);

describe("storage vNext maintenance owner contract", () => {
  it("enforces one live maintenance owner per knowledge base", () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX operations_live_maintenance_owner_idx"
    );
    expect(migration).toMatch(
      /ON focowiki\.operations \(knowledge_base_id\)[\s\S]*operation_kind = 'maintenance'[\s\S]*state IN \('accepted', 'validating', 'processing', 'publishing'\)/u
    );
  });

  it("serializes admission and defers to foreground work", () => {
    expect(existsSync(repositoryPath)).toBe(true);
    if (!existsSync(repositoryPath)) return;
    const repository = read(
      "apps/api/src/storage-vnext/maintenance/postgres-repository.ts"
    );
    expect(repository).toContain("FOR UPDATE OF knowledge_base");
    expect(repository).toMatch(
      /work\.work_kind IN \('upload', 'mutation', 'publication', 'deletion'\)/u
    );
    expect(repository).toContain('work_kind, state, operation_revision');
    expect(repository).not.toMatch(
      /maintenance_(?:subtasks|work_items|plans)|lexical_rebuild_work_items|projection_repair_subtasks/u
    );
  });

  it("claims and recovers the same bounded work checkpoint", () => {
    expect(existsSync(repositoryPath)).toBe(true);
    if (!existsSync(repositoryPath)) return;
    const repository = read(
      "apps/api/src/storage-vnext/maintenance/postgres-repository.ts"
    );
    expect(repository).toContain("FOR UPDATE OF work SKIP LOCKED");
    expect(repository).toContain("checkpoint = ${transaction.json(input.checkpoint)}");
    expect(repository).toMatch(
      /SET state = 'retry',[\s\S]*lease_owner = NULL,[\s\S]*lease_expires_at = NULL/u
    );
    expect(repository).toContain("MAINTENANCE_LEASE_EXPIRED");
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}
