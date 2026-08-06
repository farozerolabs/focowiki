import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const migrationPath = resolve(workspaceRoot, "apps/api/migrations/001_storage_vnext.sql");
const workflowPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/workflow/ports.ts"
);
const repositoryPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/cleanup/postgres-cleanup-action-repository.ts"
);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("storage vNext live cleanup persistence", () => {
  it("routes upload and webhook work through the same bounded workflow authority", () => {
    const source = read(workflowPath);
    expect(source).toMatch(/StorageVnextWorkKind[\s\S]+\| "upload"/u);
    expect(source).toMatch(/StorageVnextWorkKind[\s\S]+\| "webhook"/u);
  });

  it("stores cleanup claims as live lease-bound work without terminal history", () => {
    const migration = read(migrationPath);
    const table = migration.match(
      /CREATE TABLE focowiki\.cleanup_actions \([\s\S]+?\n\);/u
    )?.[0] ?? "";
    for (const field of [
      "cleanup_plane text NOT NULL",
      "resource_kind text NOT NULL",
      "required boolean NOT NULL",
      "sequence_number integer NOT NULL",
      "lease_owner text",
      "lease_expires_at timestamp with time zone",
      "safe_error_code text"
    ]) expect(table, field).toContain(field);
    expect(table).toMatch(/state IN \('queued', 'running', 'retry'\)/u);
    expect(table).toMatch(/cleanup_actions_lease_check/u);
    expect(table).not.toMatch(/completed|failed|cancelled|superseded|timed_out|deleted/u);
  });

  it("indexes only claimable and stale leased cleanup work", () => {
    const migration = read(migrationPath).toLowerCase();
    expect(migration).toContain(
      "cleanup_actions_claim_idx on focowiki.cleanup_actions (not_before, sequence_number, updated_at, public_id) where state in ('queued', 'retry')"
    );
    expect(migration).toContain(
      "cleanup_actions_lease_idx on focowiki.cleanup_actions (lease_expires_at, public_id) where state = 'running'"
    );
  });

  it("deletes completed cleanup detail instead of retaining a terminal cleanup row", () => {
    expect(existsSync(repositoryPath), repositoryPath).toBe(true);
    if (!existsSync(repositoryPath)) return;
    const source = read(repositoryPath);
    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain("SET state = 'running'");
    expect(source).toContain("SET state = 'retry'");
    expect(source).toContain("DELETE FROM focowiki.cleanup_actions");
    expect(source).not.toMatch(
      /SET state = '(?:completed|failed|cancelled|superseded|timed_out|deleted)'/u
    );
  });
});
