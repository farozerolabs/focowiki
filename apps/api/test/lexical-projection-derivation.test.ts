import { describe, expect, it } from "vitest";
import type { LexicalRebuildWorkSource } from "../src/application/ports/lexical-rebuild-work-repository.js";
import { deriveLexicalProjections } from "../src/maintenance/lexical-projection-derivation.js";
import { testLexicalTokenizer } from "./helpers/test-lexical-tokenizer.js";

describe("lexical projection derivation", () => {
  it("derives graph content from the Markdown body instead of frontmatter", () => {
    const source: LexicalRebuildWorkSource = {
      knowledgeBaseId: "kb-frontmatter",
      targetGenerationId: "generation-frontmatter",
      sourceFileId: "source-frontmatter",
      sourceRevisionId: "revision-frontmatter",
      logicalPath: "pages/guides/payment-callback.md",
      leaseToken: "lease-frontmatter",
      attemptCount: 0,
      maxAttempts: 3,
      settingsRevision: 1,
      settings: {
        concurrency: 1,
        sourceReadConcurrency: 1,
        databaseWriteConcurrency: 1,
        claimBatchSize: 1,
        databaseBatchSize: 1,
        maxInFlightSourceBytes: 1_048_576
      },
      relativePath: "guides/payment-callback.md",
      objectKey: "sources/payment-callback.md",
      sizeBytes: 512,
      checksumSha256: "a".repeat(64),
      title: "Payment callback guide",
      summary: null,
      sourceUrl: "https://example.com/payment-callback",
      metadata: {
        type: "guide",
        title: "Payment callback guide",
        description: "Metadata-only description",
        tags: ["payments"]
      },
      suggestions: null
    };
    const body = [
      "---",
      'type: "guide"',
      'title: "Payment callback guide"',
      'description: "Metadata-only description"',
      "---",
      "",
      "# Payment callback guide",
      "",
      "Payment callbacks notify a merchant after a payment state changes.",
      "The retry process starts after signature verification."
    ].join("\n");

    const result = deriveLexicalProjections({
      read: {
        source,
        body,
        bytes: Buffer.byteLength(body),
        latencyMs: 1,
        retryCount: 0,
        release() {}
      },
      tokenizer: testLexicalTokenizer
    });

    expect(result.graphNode.description).toBe(
      "Payment callbacks notify a merchant after a payment state changes."
    );
    expect(result.graphNode.summary).toBe(
      "Payment callbacks notify a merchant after a payment state changes."
    );
    expect(result.graphNode.profileVersion).toBe("content-profile-v3");
    expect(
      result.searchDocument.segments.map((segment) => segment.normalizedText).join("\n")
    ).not.toContain(
      'title: "Payment callback guide"'
    );
  });
});
