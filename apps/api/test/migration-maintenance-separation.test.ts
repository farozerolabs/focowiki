import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("database migration and knowledge-base maintenance separation", () => {
  it("keeps the migration runtime independent from maintenance and storage modules", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/db/migrations.ts"),
      "utf8"
    );

    expect(source).not.toMatch(/from ["'][^"']*maintenance/u);
    expect(source).not.toMatch(/from ["'][^"']*(redis|storage|s3)/u);
    expect(source).not.toContain("enqueue");
    expect(source).not.toContain("listObjects");
    expect(source).not.toContain("readSource");
  });

  it("does not schedule or generate knowledge-base content in the current migration", () => {
    const migration = readFileSync(
      resolve(
        import.meta.dirname,
        "../migrations/016_knowledge_base_index_maintenance.sql"
      ),
      "utf8"
    ).replace(/\s+/gu, " ").toLowerCase();

    for (const mutation of [
      "insert into focowiki.knowledge_base_index_maintenance_requests",
      "insert into focowiki.projection_repair_subtasks",
      "insert into focowiki.lexical_rebuild_work_items",
      "insert into focowiki.generation_object_refs",
      "insert into focowiki.immutable_objects"
    ]) {
      expect(migration).not.toContain(mutation);
    }
    expect(migration).not.toContain("from focowiki.source_files");
    expect(migration).not.toContain("from focowiki.source_revisions");
    expect(migration).not.toContain("from focowiki.immutable_objects");
  });
});
