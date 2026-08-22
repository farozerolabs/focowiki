import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("document publication bounded query contract", () => {
  it("reads immutable members and retained base output without mutable current facts",
    () => {
      const source = read("postgres-document-publication-snapshot.ts");
      expect(source).toContain("projection_scope_snapshot_members");
      expect(source).toContain("base_generation_public_id");
      expect(source).toContain("projection_scope_generation_pages");
      expect(source).not.toContain("projection_scope_contributions");
      expect(source).not.toContain("record.active");
      expect(source).not.toContain("source_file_active_revisions");
      expect(source.match(/LIMIT/g)?.length).toBeGreaterThanOrEqual(2);
    });

  it("validates normalized metadata without loading source bodies", () => {
    const source = read("postgres-document-publication-validator.ts");
    expect(source).toContain("publication_generation_public_id");
    expect(source).toContain("projection_scope_generation_object_refs");
    expect(source).toContain("LIMIT ${MAXIMUM_VALIDATION_ROWS + 1}");
    expect(source).not.toContain("source_revisions.object_id");
    expect(source).not.toContain("storage_key");
    expect(source).not.toContain("source body");
  });
});

function read(file: string): string {
  return readFileSync(resolve(
    import.meta.dirname,
    `../src/document-indexing/infrastructure/${file}`
  ), "utf8");
}
