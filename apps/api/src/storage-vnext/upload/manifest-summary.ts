import { createHash } from "node:crypto";

type ManifestSummaryEntry = {
  id: string;
  pathKey: string;
  declaredSize: number;
  checksumSha256: string | null;
};

type ManifestSummaryPage = {
  items: readonly ManifestSummaryEntry[];
  nextCursor: string | null;
};

export async function summarizeStorageVnextUploadManifest(input: {
  pageSize: number;
  readPage(cursor: string | null, limit: number): Promise<ManifestSummaryPage>;
}): Promise<{ entryCount: number; byteCount: number; fingerprint: string }> {
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
    throw new Error("Upload manifest summary page size is invalid");
  }
  const hash = createHash("sha256");
  hash.update("[");
  const visitedCursors = new Set<string>();
  let cursor: string | null = null;
  let entryCount = 0;
  let byteCount = 0;
  let first = true;

  do {
    const page = await input.readPage(cursor, input.pageSize);
    if (!Array.isArray(page.items) || page.items.length > input.pageSize) {
      throw new Error("Upload manifest summary page is invalid");
    }
    for (const entry of page.items) {
      assertEntry(entry);
      hash.update(first ? "" : ",");
      hash.update(JSON.stringify({
        path: entry.pathKey,
        byteCount: entry.declaredSize,
        checksum: entry.checksumSha256
      }));
      first = false;
      entryCount += 1;
      byteCount += entry.declaredSize;
      if (!Number.isSafeInteger(entryCount) || !Number.isSafeInteger(byteCount)) {
        throw new Error("Upload manifest summary total is unsafe");
      }
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (visitedCursors.has(cursor)) {
        throw new Error("Upload manifest summary cursor repeated");
      }
      visitedCursors.add(cursor);
    }
  } while (cursor);

  hash.update("]");
  return { entryCount, byteCount, fingerprint: hash.digest("hex") };
}

function assertEntry(entry: ManifestSummaryEntry): void {
  if (
    !entry
    || typeof entry.id !== "string"
    || !entry.id
    || typeof entry.pathKey !== "string"
    || !entry.pathKey
    || !Number.isSafeInteger(entry.declaredSize)
    || entry.declaredSize < 0
    || (entry.checksumSha256 !== null
      && !/^[a-f0-9]{64}$/u.test(entry.checksumSha256))
  ) throw new Error("Upload manifest summary entry is invalid");
}
