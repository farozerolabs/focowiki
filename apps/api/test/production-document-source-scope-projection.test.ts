import { describe, expect, it, vi } from "vitest";
import { canonicalFileRelation } from
  "../src/document-indexing/domain/file-relation.js";
import { createProductionDocumentSourceScopeProjection } from
  "../src/document-indexing/infrastructure/production-document-source-scope-projection.js";

describe("production document source scope projection", () => {
  it("renders one current source from the selected revisions and relationships", async () => {
    const relation = canonicalFileRelation({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      targetSourceFilePublicId: "source-b",
      relationKind: "references",
      evidenceKind: "markdown_link",
      sourceRevisionPublicId: "revision-a-2",
      evidenceChecksumSha256: "a".repeat(64),
      evidence: { rawTarget: "b.md" }
    });
    const bases = [base("source-a", "revision-a-2"),
      base("source-b", "revision-b-1")];
    const snapshots = new Map([
      ["source-a", source("source-a", "revision-a-2", "new/a.md", "Alpha", "old/a.md")],
      ["source-b", source("source-b", "revision-b-1", "b.md", "Beta")]
    ]);
    const listVisibleForSource = vi.fn(async () => [relation]);
    const listVisibleForSources = vi.fn(async (request: {
      sourceFilePublicIds: readonly string[];
    }) => request.sourceFilePublicIds.length === 1 ? [bases[0]!] : bases);
    const projection = createProductionDocumentSourceScopeProjection({
      relations: { listVisibleForSource } as never,
      bases: { listVisibleForSources } as never,
      async loadBase({ base: selected }) {
        return snapshots.get(selected.sourceFilePublicId)!;
      },
      readConcurrency: 2
    });
    const signal = new AbortController().signal;

    const result = await projection.project({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      includedSourceRevisionPublicIds: ["revision-a-2"],
      excludedActiveSourceFilePublicIds: ["source-a"],
      signal
    });

    expect(listVisibleForSource).toHaveBeenCalledWith({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      includedSourceRevisionPublicIds: ["revision-a-2"],
      excludedActiveSourceFilePublicIds: ["source-a"],
      limit: 10_000
    });
    expect(listVisibleForSources).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        sourceFilePublicIds: ["source-a"],
        preferredCurrentSourceFilePublicIds: ["source-a"]
      }));
    expect(listVisibleForSources).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        sourceFilePublicIds: ["source-a", "source-b"]
      }));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      logicalPath: "pages/new/a.md",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a-2"
    });
    expect(new TextDecoder().decode(result.pages[0]!.bytes))
      .toContain("[Beta](../b.md)");
    expect(result.removedLogicalPaths).toEqual(["pages/old/a.md"]);
    expect(result.factCount).toBe(2);
  });

  it("defers a relationship whose neighboring source base is not ready", async () => {
    const relation = canonicalFileRelation({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      targetSourceFilePublicId: "source-b",
      relationKind: "references",
      evidenceKind: "markdown_link",
      sourceRevisionPublicId: "revision-a-2",
      evidenceChecksumSha256: "a".repeat(64),
      evidence: { rawTarget: "b.md" }
    });
    const sourceBase = base("source-a", "revision-a-2");
    const projection = createProductionDocumentSourceScopeProjection({
      relations: {
        async listVisibleForSource() { return [relation]; }
      } as never,
      bases: {
        async listVisibleForSources() { return [sourceBase]; }
      } as never,
      async loadBase() {
        return source("source-a", "revision-a-2", "a.md", "Alpha");
      },
      readConcurrency: 2
    });

    const result = await projection.project({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      includedSourceRevisionPublicIds: ["revision-a-2", "revision-b-1"],
      excludedActiveSourceFilePublicIds: ["source-a", "source-b"],
      signal: new AbortController().signal
    });

    expect(result.factCount).toBe(1);
    expect(new TextDecoder().decode(result.pages[0]!.bytes)).not.toContain("Beta");
  });

  it("keeps a not-ready source scope empty until its base exists", async () => {
    const projection = createProductionDocumentSourceScopeProjection({
      relations: {
        async listVisibleForSource() { return []; }
      } as never,
      bases: {
        async listVisibleForSources() { return []; }
      } as never,
      async loadBase() {
        throw new Error("A missing base must not be loaded");
      },
      readConcurrency: 2
    });

    await expect(projection.project({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-pending",
      includedSourceRevisionPublicIds: ["revision-pending"],
      excludedActiveSourceFilePublicIds: ["source-pending"],
      signal: new AbortController().signal
    })).resolves.toEqual({ pages: [], removedLogicalPaths: [], factCount: 0 });
  });
});

function base(sourceFilePublicId: string, sourceRevisionPublicId: string) {
  return {
    publicId: `base-${sourceFilePublicId}`,
    sourceFilePublicId,
    sourceRevisionPublicId,
    inputFingerprintSha256: "b".repeat(64),
    object: {
      objectId: `object-${sourceFilePublicId}`,
      storageKey: `objects/${sourceFilePublicId}`,
      checksumSha256: "c".repeat(64),
      byteCount: 1,
      contentType: "application/json; charset=utf-8" as const,
      objectFormat: "okf-generated-json-v1" as const
    }
  };
}

function source(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  logicalPath: string,
  title: string,
  sourceLinkBaseLogicalPath = logicalPath
) {
  return {
    schemaVersion: "document-page-base-v1" as const,
    sourceFilePublicId,
    sourceRevisionPublicId,
    resourceRevision: 1,
    logicalPath,
    sourceLinkBaseLogicalPath,
    title,
    body: `# ${title}\n\nSource body.`,
    metadata: { type: "page", title },
    sourceMetadata: { title },
    modelSuggestions: null,
    checksumSha256: "d".repeat(64),
    byteCount: 12,
    contentType: "text/markdown; charset=utf-8",
    semanticEntities: []
  };
}
