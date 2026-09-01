import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDocumentSourceMetadataRepair } from
  "../src/document-indexing/application/document-source-metadata-repair.js";

describe("document source metadata repair", () => {
  it("repairs claimed source metadata without invoking indexing providers", async () => {
    const markdown = [
      "---",
      "title: Portable Guide",
      "resource: https://example.test/guides/portable",
      "tags: [portable, guide]",
      "custom_field: retained",
      "---",
      "# Portable Guide",
      "",
      "Reusable content."
    ].join("\n");
    const bytes = new TextEncoder().encode(markdown);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const complete = vi.fn(async () => true);
    const defer = vi.fn(async () => undefined);
    const repair = createDocumentSourceMetadataRepair({
      concurrency: 2,
      maximumSourceBytes: 10_000,
      repository: {
        async claim() {
          return [{
            knowledgeBaseId: "knowledge-base-test",
            sourceFilePublicId: "source-file-test",
            sourceRevisionPublicId: "source-revision-test",
            logicalPath: "guides/portable.md",
            objectId: `source-sha256:${checksum}`,
            checksumSha256: checksum,
            byteCount: bytes.byteLength,
            contentType: "text/markdown; charset=utf-8",
            repairStartedAt: "2026-09-01T00:00:00.000Z"
          }];
        },
        complete,
        defer
      },
      bodies: {
        async readVerified() { return bytes; }
      }
    });

    const result = await repair.runBatch({
      now: "2026-09-01T00:00:00.000Z",
      staleBefore: "2026-08-31T23:30:00.000Z",
      limit: 2,
      signal: new AbortController().signal
    });

    expect(result).toEqual({ claimed: 1, completed: 1, deferred: 0 });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      title: "Portable Guide",
      metadata: expect.objectContaining({
        resource: "https://example.test/guides/portable",
        custom_field: "retained"
      })
    }));
    expect(defer).not.toHaveBeenCalled();
  });

  it("defers a failed object read without blocking the remaining claims", async () => {
    const complete = vi.fn(async () => true);
    const defer = vi.fn(async () => undefined);
    const repair = createDocumentSourceMetadataRepair({
      concurrency: 2,
      maximumSourceBytes: 10_000,
      repository: {
        async claim() {
          return [claim("source-file-failed"), claim("source-file-complete")];
        },
        complete,
        defer
      },
      bodies: {
        async readVerified(request) {
          if (request.objectId.endsWith("failed")) {
            throw Object.assign(new Error("unavailable"), { code: "body_unavailable" });
          }
          return new TextEncoder().encode("# Complete\n\nContent.");
        }
      }
    });

    const result = await repair.runBatch({
      now: "2026-09-01T00:00:00.000Z",
      staleBefore: "2026-08-31T23:30:00.000Z",
      limit: 2,
      signal: new AbortController().signal
    });

    expect(result).toEqual({ claimed: 2, completed: 1, deferred: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(defer).toHaveBeenCalledWith(expect.objectContaining({
      sourceFilePublicId: "source-file-failed",
      safeErrorCode: "body_unavailable"
    }));
  });
});

function claim(sourceFilePublicId: string) {
  const body = sourceFilePublicId.endsWith("failed")
    ? "# Failed\n\nContent."
    : "# Complete\n\nContent.";
  const bytes = new TextEncoder().encode(body);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return {
    knowledgeBaseId: "knowledge-base-test",
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
    logicalPath: `${sourceFilePublicId}.md`,
    objectId: `source-${sourceFilePublicId}`,
    checksumSha256: checksum,
    byteCount: bytes.byteLength,
    contentType: "text/markdown; charset=utf-8",
    repairStartedAt: "2026-09-01T00:00:00.000Z"
  };
}
