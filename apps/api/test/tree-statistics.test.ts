import { describe, expect, it } from "vitest";
import {
  createDirectoryStatistics,
  EMPTY_DIRECTORY_STATISTICS,
  readTreeStatistics
} from "../src/domain/tree-statistics.js";

describe("explicit tree statistics", () => {
  it.each([
    ["root", 2, 3, 8],
    ["nested", 1, 4, 6],
    ["synthetic generated", 3, 2, 12],
    ["empty", 0, 0, 0],
    ["moved destination", 1, 1, 3],
    ["deleted source", 0, 1, 1]
  ])("keeps %s directory counts explicit", (
    _name,
    directDirectoryCount,
    directFileCount,
    descendantFileCount
  ) => {
    expect(createDirectoryStatistics({
      directDirectoryCount,
      directFileCount,
      descendantFileCount
    })).toEqual({
      directEntryCount: directDirectoryCount + directFileCount,
      directDirectoryCount,
      directFileCount,
      descendantFileCount
    });
  });

  it("forces every file statistic to zero", () => {
    expect(readTreeStatistics({
      directEntryCount: 99,
      directDirectoryCount: 99,
      directFileCount: 99,
      descendantFileCount: 99
    }, "file")).toEqual(EMPTY_DIRECTORY_STATISTICS);
  });

  it("derives direct entry count from typed directory fields", () => {
    expect(readTreeStatistics({
      childCount: 100,
      directEntryCount: 100,
      directDirectoryCount: 2,
      directFileCount: 5,
      descendantFileCount: 9
    }, "directory")).toEqual({
      directEntryCount: 7,
      directDirectoryCount: 2,
      directFileCount: 5,
      descendantFileCount: 9
    });
  });
});
