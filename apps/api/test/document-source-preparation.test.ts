import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDocumentSourcePreparation } from
  "../src/document-indexing/application/document-source-preparation.js";

describe("document source preparation", () => {
  it("streams, verifies, parses permissive metadata, and writes deterministic profiles", async () => {
    const markdown = [
      "---",
      "title: General Guide",
      "custom_field:",
      "  nested: retained",
      "tags: [general, guide]",
      "---",
      "# General Guide",
      "",
      "See [Operations](guides/operations.md).",
      "",
      "## Details",
      "This guide explains a general workflow."
    ].join("\n");
    const bytes = new TextEncoder().encode(markdown);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const stored: Array<{ artifactKind: string; bytes: Uint8Array }> = [];
    const prepare = createDocumentSourcePreparation({
      bodyStore: {
        async readVerifiedStream() {
          return chunks(bytes, 17);
        }
      },
      tokenizer: {
        contractVersion: "test-tokenizer-v1",
        tokenizeDocument(value, limit) {
          return value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean).slice(0, limit);
        },
        tokenizeQuery(value, limit) {
          return value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean).slice(0, limit);
        }
      },
      profiles: {
        async putVerifiedJson(input) {
          stored.push({ artifactKind: input.artifactKind, bytes: input.bytes });
          return {
            objectId: `object-${input.artifactKind}`,
            checksumSha256: input.checksumSha256,
            byteCount: input.byteCount
          };
        }
      }
    });

    const first = await prepare({
      sourceFileName: "guide.md",
      sourceLogicalPath: "docs/guide.md",
      objectId: "source-object",
      checksumSha256: checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      maximumSourceBytes: 10_000,
      profileContractSha256: "a".repeat(64),
      signal: new AbortController().signal
    });
    const firstPayloads = stored.map((item) => new TextDecoder().decode(item.bytes));
    stored.length = 0;
    const replay = await prepare({
      sourceFileName: "guide.md",
      sourceLogicalPath: "docs/guide.md",
      objectId: "source-object",
      checksumSha256: checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      maximumSourceBytes: 10_000,
      profileContractSha256: "a".repeat(64),
      signal: new AbortController().signal
    });

    expect(replay).toEqual(first);
    expect(stored.map((item) => new TextDecoder().decode(item.bytes)))
      .toEqual(firstPayloads);
    expect(first.metadata.custom_field).toEqual({ nested: "retained" });
    expect(first.resolvedMetadata.title).toBe("General Guide");
    expect(first.structureProfile.headings).toEqual([
      { level: 1, text: "General Guide" },
      { level: 2, text: "Details" }
    ]);
    expect(first.referenceProfile.references).toContainEqual(expect.objectContaining({
      label: "Operations",
      rawTarget: "guides/operations.md",
      resolvedTarget: "/pages/docs/guides/operations.md"
    }));
    expect(stored.map((item) => item.artifactKind)).toEqual([
      "content_profile", "structure_profile", "reference_profile"
    ]);
  });

  it("rejects a stream whose bytes do not match the current revision", async () => {
    const body = new TextEncoder().encode("# Changed");
    const profiles = { putVerifiedJson: vi.fn() };
    const prepare = createDocumentSourcePreparation({
      bodyStore: { async readVerifiedStream() { return chunks(body, 3); } },
      tokenizer: {
        contractVersion: "test-tokenizer-v1",
        tokenizeDocument: () => [],
        tokenizeQuery: () => []
      },
      profiles
    });

    await expect(prepare({
      sourceFileName: "changed.md",
      sourceLogicalPath: "changed.md",
      objectId: "source-object",
      checksumSha256: "0".repeat(64),
      byteCount: body.byteLength,
      contentType: "text/markdown; charset=utf-8",
      maximumSourceBytes: 100,
      profileContractSha256: "a".repeat(64),
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "source_checksum_mismatch" });
    expect(profiles.putVerifiedJson).not.toHaveBeenCalled();
  });

  it.each([
    ["metadata-sparse", "# Plain document\n\nUseful content."],
    ["non-OKF", "---\ncustom_field: retained\n---\n# Custom\n\nUseful content."]
  ])("accepts %s Markdown without requiring OKF fields", async (_kind, markdown) => {
    const result = await prepareText(markdown);

    expect(result.resolvedMetadata.title).toMatch(/Plain document|Custom/u);
    if (_kind === "non-OKF") expect(result.metadata.custom_field).toBe("retained");
  });

  it("rejects an empty Markdown body before writing profiles", async () => {
    await expect(prepareText("---\ncustom: retained\n---\n"))
      .rejects.toMatchObject({ code: "source_body_empty" });
  });

  it("returns a stable error for malformed frontmatter", async () => {
    await expect(prepareText("---\ntitle: [broken\n---\n# Body"))
      .rejects.toMatchObject({ code: "source_frontmatter_invalid" });
  });

  it("stops an oversized stream before profile persistence", async () => {
    const expected = new TextEncoder().encode("0123456789");
    const actual = new TextEncoder().encode("01234567890");
    const checksum = createHash("sha256").update(expected).digest("hex");
    const putVerifiedJson = vi.fn();
    const prepare = createDocumentSourcePreparation({
      bodyStore: { async readVerifiedStream() { return chunks(actual, 4); } },
      tokenizer: testTokenizer(),
      profiles: { putVerifiedJson }
    });

    await expect(prepare({
      sourceFileName: "large.md",
      sourceLogicalPath: "large.md",
      objectId: "source-object",
      checksumSha256: checksum,
      byteCount: expected.byteLength,
      contentType: "text/markdown; charset=utf-8",
      maximumSourceBytes: expected.byteLength,
      profileContractSha256: "a".repeat(64),
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "source_size_limit" });
    expect(putVerifiedJson).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])(
    "stops profile persistence immediately when external write %i fails",
    async (failureOrdinal) => {
      const markdown = "# External write boundary\n\nReusable source content.";
      const bytes = new TextEncoder().encode(markdown);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const writes: string[] = [];
      const error = new Error(`injected:profile:${failureOrdinal}`);
      const prepare = createDocumentSourcePreparation({
        bodyStore: { async readVerifiedStream() { return chunks(bytes, 9); } },
        tokenizer: testTokenizer(),
        profiles: {
          async putVerifiedJson(input) {
            writes.push(input.artifactKind);
            if (writes.length === failureOrdinal) throw error;
            return {
              objectId: `object-${input.artifactKind}`,
              checksumSha256: input.checksumSha256,
              byteCount: input.byteCount
            };
          }
        }
      });

      await expect(prepare({
        sourceFileName: "boundary.md",
        sourceLogicalPath: "boundary.md",
        objectId: "source-object",
        checksumSha256: checksum,
        byteCount: bytes.byteLength,
        contentType: "text/markdown; charset=utf-8",
        maximumSourceBytes: bytes.byteLength,
        profileContractSha256: "a".repeat(64),
        signal: new AbortController().signal
      })).rejects.toBe(error);
      expect(writes).toHaveLength(failureOrdinal);
    }
  );
});

async function prepareText(markdown: string) {
  const bytes = new TextEncoder().encode(markdown);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const prepare = createDocumentSourcePreparation({
    bodyStore: { async readVerifiedStream() { return chunks(bytes, 7); } },
    tokenizer: testTokenizer(),
    profiles: {
      async putVerifiedJson(input) {
        return {
          objectId: `object-${input.artifactKind}`,
          checksumSha256: input.checksumSha256,
          byteCount: input.byteCount
        };
      }
    }
  });
  return prepare({
    sourceFileName: "plain.md",
    sourceLogicalPath: "plain.md",
    objectId: "source-object",
    checksumSha256: checksum,
    byteCount: bytes.byteLength,
    contentType: "text/markdown; charset=utf-8",
    maximumSourceBytes: Math.max(1, bytes.byteLength),
    profileContractSha256: "a".repeat(64),
    signal: new AbortController().signal
  });
}

function testTokenizer() {
  return {
    contractVersion: "test-tokenizer-v1",
    tokenizeDocument(value: string, limit: number) {
      return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, limit);
    },
    tokenizeQuery(value: string, limit: number) {
      return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, limit);
    }
  };
}

async function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.slice(offset, offset + size);
  }
}
