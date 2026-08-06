import {
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument,
  type StorageVnextSearchDocument
} from "./documents.js";

export function parseStorageVnextSearchDocument(
  value: Record<string, unknown>
): StorageVnextSearchDocument {
  const documentKind = stringValue(value.documentKind);
  const id = stringValue(value.id);
  const common = {
    knowledgeBaseId: stringValue(value.knowledgeBaseId),
    sourceFilePublicId: stringValue(value.sourceFilePublicId),
    sourceRevisionPublicId: stringValue(value.sourceRevisionPublicId),
    logicalPath: stringValue(value.logicalPath),
    title: nullableString(value.title),
    searchText: stringValue(value.searchText)
  };
  const document = documentKind === "content"
    ? createStorageVnextContentDocument({
        ...common,
        fileKind: stringValue(value.fileKind),
        contentKind: enumValue(value.contentKind, ["file", "segment"]),
        segmentOrdinal: nullableOrdinal(value.segmentOrdinal),
        headingAncestors: stringArray(value.headingAncestors)
      })
    : documentKind === "graph_seed"
      ? createStorageVnextGraphSeedDocument({
          ...common,
          rankingTerms: stringArray(value.rankingTerms)
        })
      : invalidDocument();
  if (document.id !== id || document.schemaVersion !== value.schemaVersion) {
    throw new Error("Search document identity or schema is invalid");
  }
  return document;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value) invalidDocument();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return stringValue(value);
}

function nullableOrdinal(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidDocument();
  return value as number;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidDocument();
  }
  return [...value] as string[];
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalidDocument();
  return value as T;
}

function invalidDocument(): never {
  throw new Error("Search document shape is invalid");
}
