import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_GENERATED_FAMILY_REGISTRY } from
  "../src/document-indexing/domain/document-generated-family-registry.js";

describe("document generated family registry", () => {
  it("assigns exactly one production owner to every emitted family", () => {
    expect(DOCUMENT_GENERATED_FAMILY_REGISTRY.every((item) =>
      item.ownerModule !== null)).toBe(true);
    expect(new Set(DOCUMENT_GENERATED_FAMILY_REGISTRY.map((item) =>
      item.family)).size).toBe(DOCUMENT_GENERATED_FAMILY_REGISTRY.length);
    expect(DOCUMENT_GENERATED_FAMILY_REGISTRY.flatMap((item) =>
      item.publicPaths)).not.toContain("schema.md");
  });

  it("keeps byte serializers outside persistence and runtime entity boundaries", () => {
    const serializerPaths = [
      "src/document-indexing/application/document-machine-record.ts",
      "src/document-indexing/application/document-directory-navigation-renderer.ts",
      "src/document-indexing/application/document-generated-navigation.ts",
      "src/okf/generated-files.ts"
    ];
    const forbiddenImports = [
      "storage-vnext", "infrastructure/", "application/ports/",
      "runtime-settings", "document-affected-source-pages", "file-relation"
    ];
    const found = serializerPaths.flatMap((path) => {
      const source = readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
      return forbiddenImports.filter((value) => source.includes(value))
        .map((value) => `${path}:${value}`);
    });

    expect(found).toEqual([]);
  });
});
