import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const canonicalRelationshipConsumers = [
  "apps/api/src/document-indexing/infrastructure/postgres-document-deletion-acceptance.ts",
  "apps/api/src/document-indexing/infrastructure/postgres-document-deletion-projection-context.ts",
  "apps/api/src/document-indexing/infrastructure/postgres-document-generated-context.ts",
  "apps/api/src/document-indexing/infrastructure/postgres-document-relation-deletion.ts",
  "apps/api/src/storage-vnext/api/postgres-admin-core.ts",
  "apps/api/src/storage-vnext/api/postgres-openapi-read.ts"
] as const;

const directedEvidenceConsumers = [
  ...canonicalRelationshipConsumers,
  "apps/api/src/document-indexing/infrastructure/postgres-document-resource-deletion.ts"
] as const;

describe("document indexing relationship authority contract", () => {
  it("uses one canonical relationship authority across every production reader", () => {
    for (const path of canonicalRelationshipConsumers) {
      const source = readFileSync(resolve(workspaceRoot, path), "utf8");
      expect(source, path).not.toContain("focowiki.file_relations");
      expect(source, path).not.toContain("focowiki.file_relation_evidence");
      expect(source, path).toContain("focowiki.canonical_file_relations");
    }
  });

  it("reads or retires revision-owned directed evidence where required", () => {
    for (const path of directedEvidenceConsumers) {
      const source = readFileSync(resolve(workspaceRoot, path), "utf8");
      expect(source, path).toContain("focowiki.relation_directed_evidence");
    }
  });
});
