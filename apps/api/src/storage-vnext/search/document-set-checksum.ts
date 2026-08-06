import { createHash } from "node:crypto";
import type { StorageVnextSearchDocument } from "./documents.js";

const CHECKSUM_VERSION = "storage-vnext-document-set-v1";

export type StorageVnextSearchDocumentSetChecksum = {
  add(document: StorageVnextSearchDocument): void;
  digest(): string;
};

export function createStorageVnextSearchDocumentSetAccumulator():
StorageVnextSearchDocumentSetChecksum {
  const combined = new Uint8Array(32);
  let count = 0;
  return {
    add(document) {
      const item = createHash("sha256")
        .update(canonicalJson(document))
        .digest();
      for (let index = 0; index < combined.length; index += 1) {
        combined[index] = combined[index]! ^ item[index]!;
      }
      count += 1;
    },
    digest() {
      return createHash("sha256")
        .update(CHECKSUM_VERSION)
        .update("\u0000")
        .update(String(count))
        .update("\u0000")
        .update(Buffer.from(combined).toString("hex"))
        .digest("hex");
    }
  };
}

export function createStorageVnextSearchDocumentSetChecksum(
  documents: readonly StorageVnextSearchDocument[]
): string {
  const checksum = createStorageVnextSearchDocumentSetAccumulator();
  for (const document of documents) checksum.add(document);
  return checksum.digest();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
