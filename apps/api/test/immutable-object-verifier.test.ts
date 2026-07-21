import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  verifyImmutableStorageObject
} from "../src/publication/immutable-object-verifier.js";

const body = Buffer.from("# Verified\n", "utf8");
const expected = {
  checksumSha256: createHash("sha256").update(body).digest("hex"),
  formatVersion: 1,
  contentType: "text/markdown; charset=utf-8",
  sizeBytes: body.byteLength
};

describe("immutable object verifier", () => {
  it("accepts normalized metadata keys and values", async () => {
    await expect(verifyImmutableStorageObject({
      objectKey: "generated/object",
      expected,
      storage: {
        headObjectMetadata: vi.fn().mockResolvedValue({
          key: "generated/object",
          contentType: "Text/Markdown;charset=UTF-8",
          sizeBytes: body.byteLength,
          etag: null,
          lastModified: null,
          metadata: {
            "Focowiki-Checksum-Sha256": expected.checksumSha256,
            "FOCOWIKI-FORMAT-VERSION": "1"
          }
        })
      }
    })).resolves.toEqual({ method: "metadata" });
  });

  it("does not reject valid immutable content when the provider normalizes content type", async () => {
    await expect(verifyImmutableStorageObject({
      objectKey: "generated/object",
      expected,
      storage: {
        headObjectMetadata: vi.fn().mockResolvedValue({
          key: "generated/object",
          contentType: "application/octet-stream",
          sizeBytes: body.byteLength,
          etag: null,
          lastModified: null,
          metadata: {
            "focowiki-checksum-sha256": expected.checksumSha256,
            "focowiki-format-version": String(expected.formatVersion)
          }
        })
      }
    })).resolves.toEqual({ method: "metadata" });
  });

  it("falls back to bounded content verification when provider metadata is partial", async () => {
    await expect(verifyImmutableStorageObject({
      objectKey: "generated/object",
      expected,
      storage: {
        headObjectMetadata: vi.fn().mockResolvedValue({
          key: "generated/object",
          contentType: null,
          sizeBytes: body.byteLength,
          etag: null,
          lastModified: null,
          metadata: {
            "focowiki-checksum-sha256": expected.checksumSha256
          }
        }),
        getObjectBytes: vi.fn().mockResolvedValue(body)
      }
    })).resolves.toEqual({ method: "content" });
  });

  it("verifies exact bytes when a compatible provider omits custom metadata", async () => {
    const getObjectBytes = vi.fn().mockResolvedValue(body);

    await expect(verifyImmutableStorageObject({
      objectKey: "generated/object",
      expected,
      storage: {
        headObjectMetadata: vi.fn().mockResolvedValue({
          key: "generated/object",
          contentType: expected.contentType,
          sizeBytes: body.byteLength,
          etag: null,
          lastModified: null,
          metadata: {}
        }),
        getObjectBytes
      }
    })).resolves.toEqual({ method: "content" });
    expect(getObjectBytes).toHaveBeenCalledWith("generated/object", {
      maxBytes: body.byteLength
    });
  });

  it("rejects conflicting metadata without trusting the object body", async () => {
    const getObjectBytes = vi.fn().mockResolvedValue(body);

    await expect(verifyImmutableStorageObject({
      objectKey: "generated/object",
      expected,
      storage: {
        headObjectMetadata: vi.fn().mockResolvedValue({
          key: "generated/object",
          contentType: expected.contentType,
          sizeBytes: body.byteLength,
          etag: null,
          lastModified: null,
          metadata: {
            "focowiki-checksum-sha256": "0".repeat(64),
            "focowiki-format-version": "1"
          }
        }),
        getObjectBytes
      }
    })).rejects.toMatchObject({
      name: "ImmutableObjectVerificationError",
      reason: "metadata_mismatch"
    });
    expect(getObjectBytes).not.toHaveBeenCalled();
  });

  it("rejects a fallback body whose checksum differs", async () => {
    await expect(verifyImmutableStorageObject({
      objectKey: "generated/object",
      expected,
      storage: {
        headObjectMetadata: vi.fn().mockResolvedValue({
          key: "generated/object",
          contentType: expected.contentType,
          sizeBytes: body.byteLength,
          etag: null,
          lastModified: null,
          metadata: {}
        }),
        getObjectBytes: vi.fn().mockResolvedValue(Buffer.from("# Changed\n", "utf8"))
      }
    })).rejects.toMatchObject({
      reason: "content_mismatch"
    });
  });
});
