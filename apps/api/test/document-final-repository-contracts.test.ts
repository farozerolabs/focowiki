import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocumentIdentityKeys } from
  "../src/document-indexing/application/document-relation-candidates.js";
import { canonicalRelationPairInput } from
  "../src/document-indexing/infrastructure/postgres-relation-pair-repository.js";
import { mergeDirtyScopeSequence } from
  "../src/document-indexing/infrastructure/postgres-projection-dirty-scope-repository.js";
import { sortScopedActivationOwners } from
  "../src/document-indexing/infrastructure/postgres-scoped-activation-owner-repository.js";
import { truncateDocumentUtf8 } from
  "../src/document-indexing/domain/document-bounded-text.js";
import { modelLayerErrorCode } from
  "../src/document-indexing/infrastructure/production-document-model-layer-traces.js";

describe("final document repository contracts", () => {
  it("normalizes canonical source revision identity keys", () => {
    expect(buildDocumentIdentityKeys({
      logicalPath: "Guides/Start.md",
      title: "Start Here",
      aliases: ["Quick Start", "quick start"]
    })).toEqual([
      "path:guides/start.md",
      "alias:start",
      "alias:start here",
      "alias:quick start",
    ]);
  });

  it("truncates multibyte candidate evidence at a complete UTF-8 boundary", () => {
    const excerpt = truncateDocumentUtf8("法".repeat(3_000), 8_192);

    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(8_192);
    expect(excerpt).not.toContain("�");
    expect(excerpt.length).toBe(2_730);
  });

  it("preserves a safe lower-case model-layer failure code", () => {
    expect(modelLayerErrorCode(Object.assign(new Error("invalid candidates"), {
      code: "graph_candidates_invalid"
    }))).toBe("graph_candidates_invalid");
  });

  it("canonicalizes a relation pair independently of upload order", () => {
    const input = canonicalRelationPairInput({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-file-z",
      sourceRevisionPublicId: "source-revision-z",
      targetSourceFilePublicId: "source-file-a",
      targetSourceRevisionPublicId: "source-revision-a",
      evidenceFingerprintSha256: "d".repeat(64),
      nextEligibleAt: "2026-08-15T00:00:00.000Z"
    });
    expect(input).toMatchObject({
      firstSourceFilePublicId: "source-file-a",
      firstSourceRevisionPublicId: "source-revision-a",
      secondSourceFilePublicId: "source-file-z",
      secondSourceRevisionPublicId: "source-revision-z",
      state: "waiting"
    });
  });

  it("keeps a dirty scope waiting when newer work arrives during rendering", () => {
    expect(mergeDirtyScopeSequence({
      currentRequiredSequence: 4,
      currentCompletedSequence: 2,
      incomingRequiredSequence: 7
    })).toEqual({
      requiredSequence: 7,
      completedSequence: 2,
      state: "waiting"
    });
  });

  it("sorts and deduplicates scoped activation owners before locking", () => {
    expect(sortScopedActivationOwners([
      { kind: "page_head", key: "z" },
      { kind: "source", key: "b" },
      { kind: "source", key: "a" },
      { kind: "source", key: "a" }
    ])).toEqual([
      { kind: "page_head", key: "z" },
      { kind: "source", key: "a" },
      { kind: "source", key: "b" }
    ]);
  });

  it("deactivates PostgreSQL projection facts with the deleted source", () => {
    const source = readFileSync(resolve(import.meta.dirname,
      "../src/document-indexing/infrastructure/postgres-document-resource-deletion.ts"),
    "utf8");

    expect(source).toContain("UPDATE focowiki.document_projection_records");
    expect(source).toContain("SET active = false");
  });
});
