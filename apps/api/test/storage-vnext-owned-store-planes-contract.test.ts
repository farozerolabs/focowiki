import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src/storage-vnext/bootstrap");
const files = {
  postgres: "postgres-plane.ts",
  object: "object-plane.ts",
  search: "search-plane.ts",
  coordination: "coordination-plane.ts",
  main: "main.ts"
} as const;

describe("storage vNext concrete run-owned reset/bootstrap planes", () => {
  it("implements one small concrete adapter for every non-filesystem store", () => {
    for (const [plane, fileName] of Object.entries(files)) {
      const path = resolve(sourceRoot, fileName);
      expect(existsSync(path), `${plane}:${fileName}`).toBe(true);
    }
  });

  it("rechecks exact markers and inventories without broad deletion commands", () => {
    const source = Object.values(files)
      .filter((fileName) => existsSync(resolve(sourceRoot, fileName)))
      .map((fileName) => readFileSync(resolve(sourceRoot, fileName), "utf8"))
      .join("\n");

    for (const required of [
      "createStorageVnextPostgresPlane",
      "createStorageVnextObjectPlane",
      "createStorageVnextSearchPlane",
      "createStorageVnextCoordinationPlane",
      "validateStorageVnextOwnedScopeProof",
      "ownerMarker",
      "unexpectedTargets",
      "recordedIndexUids",
      "recordedTaskUids",
      "ListObjectVersionsCommand",
      "ListMultipartUploadsCommand",
      "scanIterator"
    ]) {
      expect(source, required).toContain(required);
    }

    expect(source).not.toMatch(
      /FLUSHDB|FLUSHALL|flushDb|flushAll|deleteAllIndexes|deleteAllTasks|DROP\s+DATABASE|DROP\s+SCHEMA\s+(?!focowiki\b)|Prefix:\s*["']{2}/iu
    );
  });

  it("exposes only proof-file commands and requires an explicit checksum authorization", () => {
    const mainPath = resolve(sourceRoot, files.main);
    if (!existsSync(mainPath)) return;
    const source = readFileSync(mainPath, "utf8");

    expect(source).toContain("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE");
    expect(source).toContain("FOCOWIKI_STORAGE_VNEXT_DESTRUCTIVE_AUTHORIZATION");
    expect(source).toContain("proofChecksum");
    expect(source).toMatch(/action\s*!==\s*["']reset["']/u);
    expect(source).toMatch(/action\s*!==\s*["']bootstrap["']/u);
  });
});
