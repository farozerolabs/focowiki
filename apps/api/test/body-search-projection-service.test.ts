import { describe, expect, it, vi } from "vitest";
import type { SearchProjectionRepository } from "../src/application/ports/search-projection-repository.js";
import { persistBodySearchProjection } from "../src/application/body-search-projection.js";
import { testLexicalTokenizer } from "./helpers/test-lexical-tokenizer.js";

describe("body search projection service", () => {
  it("persists a body-derived immutable document with a generated logical path", async () => {
    const persistDocument = vi.fn(async (input) => ({
      status: "created" as const,
      document: {
        documentId: input.document.documentId,
        knowledgeBaseId: input.document.knowledgeBaseId,
        sourceFileId: input.document.sourceFileId,
        sourceRevisionId: input.document.sourceRevisionId,
        sourceBodyChecksumSha256: input.document.sourceBodyChecksumSha256,
        searchSchemaVersion: input.document.searchSchemaVersion,
        tokenizerContractVersion: input.document.tokenizerContractVersion,
        segmentationVersion: input.document.segmentationVersion,
        segmentCount: input.document.segments.length,
        lifecycleState: "ready" as const
      }
    }));
    const repository = {
      persistDocument
    } as unknown as SearchProjectionRepository;

    const result = await persistBodySearchProjection({
      repository,
      tokenizer: testLexicalTokenizer,
      knowledgeBaseId: "kb-a",
      sourceFileId: "source-a",
      sourceRevisionId: "revision-a",
      relativePath: "guides/cache.md",
      title: "Cache recovery",
      summary: "Recovery procedures.",
      body: "# Cache recovery\n\nLate section evidence.",
      completedAt: "2026-07-24T00:00:00.000Z"
    });

    expect(result.lifecycleState).toBe("ready");
    expect(persistDocument).toHaveBeenCalledWith({
      document: expect.objectContaining({
        logicalPath: "pages/guides/cache.md",
        title: "Cache recovery",
        segments: expect.arrayContaining([
          expect.objectContaining({
            normalizedText: expect.stringContaining("Late section evidence.")
          })
        ])
      }),
      completedAt: "2026-07-24T00:00:00.000Z"
    });
  });
});
