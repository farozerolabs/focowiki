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

describe("storage vNext bounded release history contract", () => {
  it("exposes only paged safe event summaries and bounded expiry cleanup", () => {
    expect(ports).toMatch(
      /listReleaseEvents\(input:[\s\S]*knowledgeBaseId:[\s\S]*limit:[\s\S]*cursor:/u
    );
    expect(ports).toMatch(
      /deleteExpiredReleaseEvents\(input:[\s\S]*expiredBefore:[\s\S]*limit:[\s\S]*Promise<number>/u
    );
    expect(ports).not.toMatch(
      /listGenerations|getGenerationHistory|historicalProjection|historicalObject|compatibilityProvenance/u
    );
  });

  it("stores narrow expiring summaries without complete Generation provenance", () => {
    const tableStart = migration.indexOf("create table focowiki.release_event_summaries");
    const tableEnd = migration.indexOf(");", tableStart);
    const table = migration.slice(tableStart, tableEnd);
    for (const column of [
      "outcome text not null",
      "result_code text not null",
      "safe_message text",
      "created_at timestamp with time zone not null",
      "expires_at timestamp with time zone not null"
    ]) {
      expect(table, column).toContain(column);
    }
    expect(table).not.toMatch(
      /payload|metadata|checkpoint|projection|object_ref|segment|lineage|predecessor/u
    );
    expect(migration).not.toMatch(
      /publication_generations|generation_projection_records|generation_object_refs|active_projection_records|active_object_refs|last_changed_generation_id|predecessor_generation_id/u
    );
  });

  it("deletes expired summaries in a fixed lock-safe batch", () => {
    expect(repository).toContain("DELETE FROM focowiki.release_event_summaries");
    expect(repository).toMatch(
      /expires_at\s*<=\s*\$\{input\.expiredBefore\}[\s\S]*ORDER BY expires_at[\s\S]*LIMIT\s*\$\{limit\}[\s\S]*FOR UPDATE SKIP LOCKED/u
    );
    expect(repository).toContain("RETURNING summary.public_id");
  });
});
