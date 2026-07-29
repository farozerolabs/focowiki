import { describe, expect, it } from "vitest";
import { presentDeveloperSearchItems } from "../src/developer-openapi/search-presentation.js";

describe("Developer OpenAPI search presentation", () => {
  it("preserves the V2 result shape and removes search-engine internals", () => {
    const items = presentDeveloperSearchItems([{
      generationId: "generation-a",
      fileId: "file-a",
      generatedFileId: "file-a",
      knowledgeBaseId: "kb-a",
      sourceFileId: "source-file-a",
      path: "pages/a.md",
      generatedFilePath: "pages/a.md",
      fileKind: "page",
      title: "A",
      description: "Summary",
      tags: ["tag"],
      frontmatter: { status: "active" },
      matchedFields: ["title"],
      score: 0.12,
      contentAvailable: true,
      matchType: "file_direct",
      readActions: {
        fileContentByPath: "/openapi/v2/knowledge-bases/kb-a/files/content?path=pages%2Fa.md"
      },
      indexUid: "private-index",
      taskUid: 42,
      activeEpoch: 9,
      rawFilter: "knowledgeBaseId = kb-a",
      rankingDetails: { words: 1 }
    }]);

    expect(items).toEqual([{
      generationId: "generation-a",
      fileId: "file-a",
      generatedFileId: "file-a",
      knowledgeBaseId: "kb-a",
      sourceFileId: "source-file-a",
      path: "pages/a.md",
      generatedFilePath: "pages/a.md",
      fileKind: "page",
      title: "A",
      description: "Summary",
      tags: ["tag"],
      frontmatter: { status: "active" },
      matchedFields: ["title"],
      score: 0.12,
      contentAvailable: true,
      matchType: "file_direct",
      readActions: {
        fileContentByPath: "/openapi/v2/knowledge-bases/kb-a/files/content?path=pages%2Fa.md"
      }
    }]);
    expect(JSON.stringify(items)).not.toMatch(
      /meilisearch|indexUid|taskUid|activeEpoch|rawFilter|rankingDetails/iu
    );
  });
});
