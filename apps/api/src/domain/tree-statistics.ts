export type DirectoryStatistics = {
  directEntryCount: number;
  directDirectoryCount: number;
  directFileCount: number;
  descendantFileCount: number;
};

export const EMPTY_DIRECTORY_STATISTICS: DirectoryStatistics = Object.freeze({
  directEntryCount: 0,
  directDirectoryCount: 0,
  directFileCount: 0,
  descendantFileCount: 0
});

export function createDirectoryStatistics(input: {
  directDirectoryCount: number;
  directFileCount: number;
  descendantFileCount: number;
}): DirectoryStatistics {
  const directDirectoryCount = nonNegativeInteger(input.directDirectoryCount);
  const directFileCount = nonNegativeInteger(input.directFileCount);
  return {
    directEntryCount: directDirectoryCount + directFileCount,
    directDirectoryCount,
    directFileCount,
    descendantFileCount: nonNegativeInteger(input.descendantFileCount)
  };
}

export function readTreeStatistics(
  payload: unknown,
  entryType: "directory" | "file"
): DirectoryStatistics {
  if (entryType === "file") return EMPTY_DIRECTORY_STATISTICS;
  return createDirectoryStatistics({
    directDirectoryCount: readNonNegativeInteger(payload, "directDirectoryCount"),
    directFileCount: readNonNegativeInteger(payload, "directFileCount"),
    descendantFileCount: readNonNegativeInteger(payload, "descendantFileCount")
  });
}

function nonNegativeInteger(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Directory statistics must contain non-negative integers");
  }
  return value;
}

function readNonNegativeInteger(value: unknown, key: string): number {
  if (!value || Array.isArray(value) || typeof value !== "object") return 0;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" && Number.isInteger(property) && property >= 0
    ? property
    : 0;
}
