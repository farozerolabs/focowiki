import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const migrationPath = resolve(
  workspaceRoot,
  "apps/api/migrations/001_storage_vnext.sql"
);
const portsPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/ownership/ports.ts"
);
const repositoryPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/ownership/postgres-repository.ts"
);
const catalogRepositoryPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/catalog/postgres-repository.ts"
);
const releaseRepositoryPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/release/postgres-repository.ts"
);

describe("storage vNext object registration and ownership contract", () => {
  it("keeps verified registration separate from explicit live ownership", () => {
    const migration = normalize(readFileSync(migrationPath, "utf8"));
    const registrations = table(migration, "object_registrations");
    const owners = table(migration, "object_owners");

    expect(registrations).toContain("state text not null");
    expect(registrations).toContain("write_attempt_public_id text not null");
    expect(registrations).toContain("zero_owner_since timestamp with time zone");
    expect(registrations).not.toMatch(/owner_kind|owner_public_id|protected/u);
    expect(owners).toContain("object_id text not null");
    expect(owners).toContain("owner_kind text not null");
    expect(owners).toContain("object_owners_identity_key unique");
  });

  it("binds reservation and verification to one immutable write attempt", () => {
    const ports = readFileSync(portsPath, "utf8");
    expect(ports).toMatch(
      /StorageVnextObjectRegistration[\s\S]*storageKey:[\s\S]*writeAttemptPublicId:[\s\S]*zeroOwnerSince:/u
    );
    expect(ports).toMatch(
      /StorageVnextObjectReservation[\s\S]*StorageVnextObjectRegistration[\s\S]*"state" \| "verifiedAt" \| "zeroOwnerSince"/u
    );
    expect(ports).toContain("reserve(input: StorageVnextObjectReservation)");
    expect(ports).toMatch(
      /markVerified\(input:[\s\S]*objectId:[\s\S]*writeAttemptPublicId:[\s\S]*checksum:[\s\S]*byteCount:[\s\S]*contentType:[\s\S]*format:[\s\S]*verifiedAt:/u
    );
  });

  it("implements owner closure without treating a registration as an owner", () => {
    expect(existsSync(repositoryPath)).toBe(true);
    if (!existsSync(repositoryPath)) return;
    const repository = readFileSync(repositoryPath, "utf8");

    expect(repository).toContain("focowiki.object_registrations");
    expect(repository).toContain("focowiki.object_owners");
    expect(repository).toContain("zero_owner_since");
    expect(repository).toContain("state = 'verified'");
    expect(repository).toContain("FOR UPDATE");
    expect(repository).not.toMatch(
      /registration(?:s|_row)?\s+(?:is|are|as)\s+(?:a\s+)?(?:live\s+)?(?:owner|protection)|registered\s*=\s*protected/iu
    );
  });

  it("requires verified bytes before source or release ownership becomes readable", () => {
    const catalog = readFileSync(catalogRepositoryPath, "utf8");
    const release = readFileSync(releaseRepositoryPath, "utf8");

    expect(catalog).toMatch(
      /object_registrations[\s\S]*object_format = 'source-markdown-v1'[\s\S]*state = 'verified'/u
    );
    expect(release).toMatch(
      /object_registrations[\s\S]*state = 'verified'/u
    );
    expect(release).toContain("requireCandidateObjectsReady");
  });
});

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").toLowerCase();
}

function table(migration: string, name: string): string {
  return migration.match(
    new RegExp(`create table focowiki\\.${name} \\([\\s\\S]*? \\);`, "u")
  )?.[0] ?? "";
}
