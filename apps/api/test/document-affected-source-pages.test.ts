import { describe, expect, it } from "vitest";
import { renderAffectedDocumentSourcePages } from
  "../src/document-indexing/application/document-affected-source-pages.js";
import { portableRelatedForSource } from
  "../src/document-indexing/application/document-affected-source-pages.js";
import { canonicalFileRelation } from
  "../src/document-indexing/domain/file-relation.js";

describe("affected document source pages", () => {
  it("renders target-later relationships on both affected source pages", () => {
    const relation = canonicalFileRelation({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      targetSourceFilePublicId: "source-b",
      relationKind: "references",
      evidenceKind: "markdown_link",
      sourceRevisionPublicId: "revision-a",
      evidenceChecksumSha256: "a".repeat(64),
      evidence: { rawTarget: "b.md" }
    });
    const sources = [source("source-a", "revision-a", "a.md", "Alpha"),
      source("source-b", "revision-b", "b.md", "Beta")];
    const pages = renderAffectedDocumentSourcePages({
      sources,
      renderSourceFilePublicIds: ["source-a", "source-b"],
      relations: [relation]
    });

    expect(text(pages[0]!)).toContain("[Beta](b.md)");
    expect(text(pages[1]!)).toContain("[Alpha](a.md)");
    expect(text(pages[0]!).match(/\[Beta\]\(b\.md\)/gu)).toHaveLength(1);
    const related = portableRelatedForSource(
      "source-a",
      new Map(sources.map((item) => [item.sourceFilePublicId, item])),
      [relation]
    );
    expect(text(pages[0]!)).toContain(related[0]!.record.reason);
    expect(related[0]!.record).toMatchObject({
      targetPath: "pages/b.md",
      direction: "outgoing",
      relationType: "references"
    });
  });

  it("keeps source-authored links portable when a source file moves", () => {
    const moved = {
      ...source("source-a", "revision-a", "nested/区域 A/a.md", "Alpha"),
      body: "# Alpha\n\nRead [Beta](b.md).",
      sourceLinkBaseLogicalPath: "a.md"
    };
    const neighbor = {
      ...source("source-b", "revision-b", "b.md", "Beta"),
      body: "# Beta\n\nRead [Alpha](a.md)."
    };
    const pages = renderAffectedDocumentSourcePages({
      sources: [moved, neighbor],
      renderSourceFilePublicIds: ["source-a", "source-b"],
      relations: [],
      sourcePathRewrites: [{
        sourceFilePublicId: "source-a",
        from: "pages/a.md",
        to: "pages/nested/区域 A/a.md",
        includeDescendants: false
      }]
    });

    const movedText = text(pages.find((page) =>
      page.sourceFilePublicId === "source-a")!);
    const neighborText = text(pages.find((page) =>
      page.sourceFilePublicId === "source-b")!);
    expect(movedText).toContain("[Beta](../../b.md)");
    expect(neighborText).toContain("[Alpha](nested/%E5%8C%BA%E5%9F%9F%20A/a.md)");
    expect(movedText).not.toContain("/pages/");
    expect(neighborText).not.toContain("/pages/");
  });
});

function source(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  logicalPath: string,
  title: string
) {
  return {
    sourceFilePublicId,
    sourceRevisionPublicId,
    resourceRevision: 1,
    logicalPath,
    title,
    body: `# ${title}\n\nSource body.`,
    metadata: { type: "page", title },
    sourceMetadata: { title },
    checksumSha256: "a".repeat(64),
    byteCount: 12,
    contentType: "text/markdown; charset=utf-8",
    semanticEntities: []
  };
}

function text(page: { bytes: Uint8Array }): string {
  return new TextDecoder().decode(page.bytes);
}
