import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../src/document-indexing");

describe("document indexing module boundaries", () => {
  it("keeps application modules independent from infrastructure and removed orchestration", async () => {
    const files = await typescriptFiles(resolve(root, "application"));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*\/infrastructure\//u);
      expect(source, file).not.toMatch(
        /storage-vnext\/(?:source-processing|publication)|semantic\/application\/stage/u
      );
      expect(source.split("\n").length, file).toBeLessThan(500);
    }
  });

  it("keeps every new focused module below the cross-layer file limit", async () => {
    const files = await typescriptFiles(root);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source.split("\n").length, file).toBeLessThan(500);
    }
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}
