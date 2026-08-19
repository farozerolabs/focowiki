import { describe, expect, it } from "vitest";
import { renderAffectedDocumentSourcePages } from
  "../src/document-indexing/application/document-affected-source-pages.js";
import { buildDocumentPageDirectoryScopeResources } from
  "../src/document-indexing/application/document-page-term-projection.js";
import { validateDocumentPortableCandidate } from
  "../src/document-indexing/application/document-portable-candidate-validation.js";
import { buildDocumentProjectionFact } from
  "../src/document-indexing/infrastructure/document-projection-persistence-plan.js";

describe("document projection generated-page integrity", () => {
  it("persists the generated page checksum and byte count", () => {
    const snapshot = source();
    const generatedPage = renderAffectedDocumentSourcePages({
      sources: [snapshot],
      renderSourceFilePublicIds: [snapshot.sourceFilePublicId],
      relations: []
    })[0]!;
    const fact = buildDocumentProjectionFact({
      knowledgeBaseId: "knowledge-base-integrity",
      sourceFilePublicId: snapshot.sourceFilePublicId,
      sourceRevisionPublicId: snapshot.sourceRevisionPublicId,
      source: {
        normalizedPath: "guides/a.md",
        contentType: snapshot.contentType
      },
      base: snapshot,
      generatedPage,
      tokenizer,
      relationPublicIds: [],
      relations: []
    });

    expect(fact.checksumSha256).toBe(generatedPage.checksumSha256);
    expect(fact.byteCount).toBe(generatedPage.byteCount);
    expect(fact.checksumSha256).not.toBe(snapshot.checksumSha256);
  });

  it("keeps deletion valid after a moved source also replaced its content", () => {
    const snapshot = {
      ...source(),
      logicalPath: "reviewed/a.md",
      sourceLinkBaseLogicalPath: "guides/a.md",
      body: "# Generated page A\n\nReplacement source body."
    };
    const generatedPage = renderAffectedDocumentSourcePages({
      sources: [snapshot],
      renderSourceFilePublicIds: [snapshot.sourceFilePublicId],
      relations: []
    })[0]!;
    const fact = buildDocumentProjectionFact({
      knowledgeBaseId: "knowledge-base-integrity",
      sourceFilePublicId: snapshot.sourceFilePublicId,
      sourceRevisionPublicId: snapshot.sourceRevisionPublicId,
      source: {
        normalizedPath: "reviewed/a.md",
        contentType: snapshot.contentType
      },
      base: snapshot,
      generatedPage,
      tokenizer,
      relationPublicIds: [],
      relations: []
    });
    const packet = buildDocumentPageDirectoryScopeResources({
      scopePath: "pages/reviewed",
      records: [{
        path: fact.pagePath,
        title: fact.title,
        summary: fact.summary,
        type: "document",
        subjects: [],
        tags: [],
        metadata: fact.metadata,
        headings: fact.headings,
        keywords: [],
        entities: fact.entities,
        contentType: fact.contentType,
        checksumSha256: fact.checksumSha256,
        byteCount: fact.byteCount,
        relationshipCount: 0
      }],
      childDirectories: [],
      previousPaths: [],
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576
    });
    const documentPacket = packet.pages.find((page) =>
      page.logicalPath !== "_index/pages/reviewed/index.json")!;

    expect(() => validateDocumentPortableCandidate({
      pages: [generatedPage, documentPacket],
      activeReadablePagePaths: []
    })).not.toThrow();
  });
});

const tokenizer = {
  contractVersion: "test-tokenizer-v1",
  tokenizeDocument(value: string, limit: number) {
    return value.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean).slice(0, limit);
  },
  tokenizeQuery(value: string, limit: number) {
    return this.tokenizeDocument(value, limit);
  }
};

function source() {
  return {
    schemaVersion: "document-page-base-v1" as const,
    sourceFilePublicId: "source-file-integrity",
    sourceRevisionPublicId: "source-revision-integrity",
    resourceRevision: 1,
    logicalPath: "guides/a.md",
    sourceLinkBaseLogicalPath: "guides/a.md",
    title: "Generated page A",
    body: "# Generated page A\n\nOriginal source body.",
    metadata: { type: "page", title: "Generated page A" },
    sourceMetadata: { title: "Generated page A" },
    modelSuggestions: null,
    checksumSha256: "a".repeat(64),
    byteCount: 7,
    contentType: "text/markdown; charset=utf-8",
    semanticEntities: []
  };
}
