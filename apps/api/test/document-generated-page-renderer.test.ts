import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderDocumentSourcePage } from
  "../src/document-indexing/application/document-generated-page-renderer.js";

describe("document generated page renderer", () => {
  it("preserves the canonical source page structure and grounded related links", () => {
    const result = renderDocumentSourcePage({
      source: {
        sourceFilePublicId: "source-a",
        logicalPath: "guides/a.md",
        body: "# Original Heading\n\nRead the original body.",
        metadata: { type: "document", title: "Guide A", tags: ["general"] },
        sourceMetadata: { title: "Guide A", tags: ["general"] }
      },
      related: [{
        targetSourceFilePublicId: "source-b",
        path: "pages/guides/b.md",
        title: "Guide B",
        direction: "bidirectional",
        relationKind: "references",
        reason: "Guide A explicitly references Guide B."
      }],
      semanticEntities: [],
      removedSourceLogicalPaths: [],
      sourcePathRewrites: []
    });
    const markdown = new TextDecoder().decode(result.bytes);

    expect(result.logicalPath).toBe("pages/guides/a.md");
    expect(result.checksumSha256).toBe(
      createHash("sha256").update(result.bytes).digest("hex")
    );
    expect(markdown).toContain("# Guide A");
    expect(markdown).toContain("Read the original body.");
    expect(markdown).toContain("## Related");
    expect(markdown).toContain("[Guide B](b.md)");
    expect(markdown).toContain("Guide A explicitly references Guide B.");
    expect(markdown).not.toMatch(/document-job|source-revision|object-|provider/iu);
  });

  it("does not render a related section for unrelated sources", () => {
    const result = renderDocumentSourcePage({
      source: {
        sourceFilePublicId: "source-a",
        logicalPath: "a.md",
        body: "# A\n\nStandalone body.",
        metadata: { type: "document", title: "A" },
        sourceMetadata: { title: "A" }
      },
      related: [], semanticEntities: [],
      removedSourceLogicalPaths: [], sourcePathRewrites: []
    });
    expect(new TextDecoder().decode(result.bytes)).not.toContain("## Related");
  });

  it("links semantic evidence to the generated source page", () => {
    const result = renderDocumentSourcePage({
      source: {
        sourceFilePublicId: "source-a",
        logicalPath: "metrics/revenue.md",
        body: "# Revenue\n\nRevenue reference.",
        metadata: { type: "document", title: "Revenue" },
        sourceMetadata: { title: "Revenue" }
      },
      related: [],
      semanticEntities: [{
        label: "Revenue",
        kind: "metric",
        description: "A measured amount.",
        confidence: 0.9,
        evidencePaths: ["metrics/revenue.md"]
      }],
      removedSourceLogicalPaths: [],
      sourcePathRewrites: []
    });

    expect(new TextDecoder().decode(result.bytes)).toContain(
      "[Source evidence](revenue.md)"
    );
  });
});
