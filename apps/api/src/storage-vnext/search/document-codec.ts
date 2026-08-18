import {
  createStorageVnextContentDocument,
  createStorageVnextFileRelationshipDocument,
  createStorageVnextGraphSeedDocument,
  type OkfSearchSignals,
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
    searchText: textValue(value.searchText),
    okfSignals: okfSearchSignals(value.okfSignals)
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
          fileKind: stringValue(value.fileKind),
          rankingTerms: stringArray(value.rankingTerms)
        })
      : documentKind === "file_relationship"
        ? createStorageVnextFileRelationshipDocument({
            ...common,
            fileKind: stringValue(value.fileKind),
            relationPublicId: stringValue(value.relationPublicId),
            evidencePublicId: stringValue(value.evidencePublicId),
            targetSourceFilePublicId: stringValue(value.targetSourceFilePublicId),
            targetSourceRevisionPublicId:
              stringValue(value.targetSourceRevisionPublicId),
            targetLogicalPath: stringValue(value.targetLogicalPath),
            targetTitle: nullableString(value.targetTitle),
            relationKind: enumValue(value.relationKind, ["references", "related"]),
            direction: enumValue(value.direction, [
              "incoming", "outgoing", "bidirectional"
            ]),
            rankingTerms: stringArray(value.rankingTerms)
          })
        : invalidDocument();
  if (document.id !== id || document.schemaVersion !== value.schemaVersion) {
    throw new Error("Search document identity or schema is invalid");
  }
  return document;
}

function okfSearchSignals(value: unknown): OkfSearchSignals {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidDocument();
  }
  const signals = value as Record<string, unknown>;
  return {
    status: nullableEnum(signals.status, ["draft", "stable", "deprecated"]),
    trustTier: nullableEnum(signals.trustTier, [
      "unverified", "machine-confirmed", "human-reviewed"
    ]),
    staleAfterEpochDay: nullableInteger(signals.staleAfterEpochDay),
    generatedAtEpochMs: nullableInteger(signals.generatedAtEpochMs),
    latestVerifiedAtEpochMs: nullableInteger(signals.latestVerifiedAtEpochMs),
    sourceCount: nullableNonnegativeInteger(signals.sourceCount)
  };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value) invalidDocument();
  return value;
}

function textValue(value: unknown): string {
  if (typeof value !== "string") invalidDocument();
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

function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) invalidDocument();
  return value as number;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  const result = nullableInteger(value);
  if (result !== null && result < 0) invalidDocument();
  return result;
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

function nullableEnum<T extends string>(
  value: unknown,
  values: readonly T[]
): T | null {
  if (value === null) return null;
  return enumValue(value, values);
}

function invalidDocument(): never {
  throw new Error("Search document shape is invalid");
}
