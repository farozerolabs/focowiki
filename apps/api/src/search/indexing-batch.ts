import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { SearchEngineDocument } from "../application/ports/search-engine-transport.js";

export type SearchDocumentBatch<T extends SearchEngineDocument> = {
  sequence: number;
  checksum: string;
  compressedBytes: number;
  documents: T[];
};

export function partitionSearchDocuments<T extends SearchEngineDocument>(input: {
  documents: Iterable<T>;
  maxDocuments: number;
  maxCompressedBytes: number;
}): SearchDocumentBatch<T>[] {
  assertPositiveInteger(input.maxDocuments, "Search indexing document limit");
  assertPositiveInteger(input.maxCompressedBytes, "Search indexing byte limit");

  const output: SearchDocumentBatch<T>[] = [];
  let pending: T[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    output.push(createBatch(output.length, pending));
    pending = [];
  };

  for (const document of input.documents) {
    const single = createBatch(0, [document]);
    if (single.compressedBytes > input.maxCompressedBytes) {
      throw new Error(`Document ${document.id} exceeds the compressed byte budget`);
    }

    if (pending.length >= input.maxDocuments) flush();
    const candidate = createBatch(0, [...pending, document]);
    if (pending.length > 0 && candidate.compressedBytes > input.maxCompressedBytes) {
      flush();
    }
    pending.push(document);
  }
  flush();

  return output;
}

function createBatch<T extends SearchEngineDocument>(
  sequence: number,
  documents: T[]
): SearchDocumentBatch<T> {
  const serialized = JSON.stringify(documents);
  return {
    sequence,
    checksum: createHash("sha256").update(serialized).digest("hex"),
    compressedBytes: gzipSync(Buffer.from(serialized, "utf8")).byteLength,
    documents: [...documents]
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
