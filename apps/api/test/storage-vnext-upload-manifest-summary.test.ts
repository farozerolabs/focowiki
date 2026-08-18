import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  summarizeStorageVnextUploadManifest
} from "../src/storage-vnext/upload/manifest-summary.js";

describe("storage vNext upload manifest summary", () => {
  it("hashes more than 1,001 entries through bounded keyset pages", async () => {
    const entries = Array.from({ length: 2_500 }, (_value, index) => ({
      id: `entry-${String(index).padStart(5, "0")}`,
      pathKey: `group/file-${String(index).padStart(5, "0")}.md`,
      declaredSize: index + 1,
      checksumSha256: createHash("sha256").update(String(index)).digest("hex")
    }));
    const pageSizes: number[] = [];
    const result = await summarizeStorageVnextUploadManifest({
      pageSize: 500,
      async readPage(cursor, limit) {
        expect(limit).toBe(500);
        const offset = cursor === null
          ? 0
          : entries.findIndex((entry) => entry.id === cursor) + 1;
        const items = entries.slice(offset, offset + limit);
        pageSizes.push(items.length);
        return {
          items,
          nextCursor: offset + items.length < entries.length
            ? items.at(-1)?.id ?? null
            : null
        };
      }
    });

    expect(result).toEqual({
      entryCount: 2_500,
      byteCount: entries.reduce((total, entry) => total + entry.declaredSize, 0),
      fingerprint: createHash("sha256").update(JSON.stringify(entries.map((entry) => ({
        path: entry.pathKey,
        byteCount: entry.declaredSize,
        checksum: entry.checksumSha256
      })))).digest("hex")
    });
    expect(Math.max(...pageSizes)).toBe(500);
    expect(pageSizes).toEqual([500, 500, 500, 500, 500]);
  });

  it("rejects a repeated page cursor", async () => {
    await expect(summarizeStorageVnextUploadManifest({
      pageSize: 100,
      async readPage() {
        return {
          items: [{
            id: "entry-one",
            pathKey: "one.md",
            declaredSize: 1,
            checksumSha256: "a".repeat(64)
          }],
          nextCursor: "entry-one"
        };
      }
    })).rejects.toThrow(/cursor/u);
  });
});
