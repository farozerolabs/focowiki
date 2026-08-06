import { describe, expect, it } from "vitest";
import type { PersistentDirectoryLeaf } from
  "../src/application/ports/directory-navigation-repository.js";
import {
  createStorageVnextDirectoryNavigationShards,
  parseStorageVnextDirectoryNavigationState
} from "../src/storage-vnext/publication/directory-state.js";

describe("storage vNext publication directory state", () => {
  it("partitions one directory state into bounded, ordered internal shards", () => {
    const leaves = Array.from({ length: 4 }, (_, index): PersistentDirectoryLeaf => ({
      id: `leaf-${index}`,
      previousLeafId: index === 0 ? null : `leaf-${index - 1}`,
      nextLeafId: index === 3 ? null : `leaf-${index + 1}`,
      revision: index + 1,
      entries: [{
        id: `source-${index}`,
        sortKey: `${"x".repeat(180)}-${index}/source-${index}`,
        name: `page-${index}.md`,
        targetPath: `pages/page-${index}.md`,
        kind: "file"
      }]
    }));

    const maximumBytes = 700;
    const shards = createStorageVnextDirectoryNavigationShards({
      directoryPath: "pages",
      leaves,
      maximumBytes
    });
    const parts = shards.map((shard) => {
      expect(shard.bytes.byteLength).toBeLessThanOrEqual(maximumBytes);
      return parseStorageVnextDirectoryNavigationState({
        bytes: shard.bytes,
        directoryPath: "pages"
      });
    });

    expect(shards.length).toBeGreaterThan(1);
    expect(shards.map((shard) => shard.ordinal))
      .toEqual(Array.from({ length: shards.length }, (_, index) => index));
    expect(parts.map((part) => [part.partIndex, part.partCount]))
      .toEqual(Array.from({ length: parts.length }, (_, index) => [index, parts.length]));
    expect(parts.flatMap((part) => part.leaves)).toEqual(leaves);
  });
});
