import { describe, expect, it } from "vitest";
import {
  collapseStorageVnextRelationships,
  decodeRelationshipCursor,
  encodeRelationshipCursor
} from
  "../src/storage-vnext/api/postgres-openapi-read.js";

describe("storage vNext OpenAPI related files", () => {
  it("returns one target when multiple relation kinds connect the same files", () => {
    expect(collapseStorageVnextRelationships([
      {
        public_id: "relation-reference",
        source_file_public_id: "source-b",
        logical_path: "pages/b.md",
        title: "B",
        relation: "references",
        weight: 1,
        reason: null,
        direction: "outgoing",
        from_source_file_public_id: "source-a",
        relationship_depth: 1
      },
      {
        public_id: "relation-related",
        source_file_public_id: "source-b",
        logical_path: "pages/b.md",
        title: "B",
        relation: "related",
        weight: 1,
        reason: "B confirms the source-grounded relationship to A.",
        direction: "incoming",
        from_source_file_public_id: "source-a",
        relationship_depth: 1
      },
      {
        public_id: "relation-c",
        source_file_public_id: "source-c",
        logical_path: "pages/c.md",
        title: "C",
        relation: "references",
        weight: 1,
        reason: null,
        direction: "outgoing",
        from_source_file_public_id: "source-a",
        relationship_depth: 1
      }
    ])).toEqual([
      expect.objectContaining({
        public_id: "relation-related",
        source_file_public_id: "source-b",
        relation: "related",
        direction: "bidirectional",
        reason: "B confirms the source-grounded relationship to A."
      }),
      expect.objectContaining({
        public_id: "relation-c",
        source_file_public_id: "source-c",
        relation: "references",
        direction: "outgoing"
      })
    ]);
  });

  it("binds pagination cursors to the knowledge base and starting file", () => {
    const cursor = encodeRelationshipCursor({
      knowledgeBaseId: "knowledge-base-a",
      sourceFileId: "source-a",
      targetSourceFileId: "source-b"
    });

    expect(decodeRelationshipCursor(cursor, {
      knowledgeBaseId: "knowledge-base-a",
      sourceFileId: "source-a"
    })).toBe("source-b");
    expect(() => decodeRelationshipCursor(cursor, {
      knowledgeBaseId: "knowledge-base-a",
      sourceFileId: "source-c"
    })).toThrow();
    expect(() => decodeRelationshipCursor(cursor, {
      knowledgeBaseId: "knowledge-base-b",
      sourceFileId: "source-a"
    })).toThrow();
  });
});
