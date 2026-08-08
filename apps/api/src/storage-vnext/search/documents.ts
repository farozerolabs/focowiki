import { createHash } from "node:crypto";
import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId
} from "../shared/types.js";
import type { OkfSearchSignals } from "./okf-signals.js";
export {
  matchesOkfSearchFilters,
  normalizeOkfSearchFilters
} from "./okf-signals.js";
export type { OkfSearchFilters, OkfSearchSignals } from "./okf-signals.js";

export const STORAGE_VNEXT_CONTENT_SCHEMA_VERSION =
  "storage-vnext-content-v2";
export const STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION =
  "storage-vnext-graph-seed-v2";

export type StorageVnextContentDocument = {
  id: string;
  schemaVersion: typeof STORAGE_VNEXT_CONTENT_SCHEMA_VERSION;
  documentKind: "content";
  contentKind: "file" | "segment";
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sourceFilePublicId: StorageVnextPublicId;
  sourceRevisionPublicId: StorageVnextPublicId;
  logicalPath: string;
  fileKind: string;
  title: string | null;
  segmentOrdinal: number | null;
  headingAncestors: readonly string[];
  searchText: string;
  okfSignals: OkfSearchSignals;
};

export type StorageVnextGraphSeedDocument = {
  id: string;
  schemaVersion: typeof STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION;
  documentKind: "graph_seed";
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sourceFilePublicId: StorageVnextPublicId;
  sourceRevisionPublicId: StorageVnextPublicId;
  logicalPath: string;
  title: string | null;
  searchText: string;
  rankingTerms: readonly string[];
  okfSignals: OkfSearchSignals;
};

export type StorageVnextSearchDocument =
  | StorageVnextContentDocument
  | StorageVnextGraphSeedDocument;

export function createStorageVnextContentDocument(input: {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sourceFilePublicId: StorageVnextPublicId;
  sourceRevisionPublicId: StorageVnextPublicId;
  logicalPath: string;
  fileKind: string;
  title: string | null;
  contentKind: "file" | "segment";
  segmentOrdinal: number | null;
  headingAncestors: readonly string[];
  searchText: string;
  okfSignals?: OkfSearchSignals;
}): StorageVnextContentDocument {
  assertIdentity(input);
  if (input.contentKind === "file" && input.segmentOrdinal !== null) {
    throw new Error("File-level search documents must not have a segment ordinal");
  }
  if (
    input.contentKind === "segment"
    && (
      input.segmentOrdinal === null
      || !Number.isSafeInteger(input.segmentOrdinal)
      || input.segmentOrdinal < 0
    )
  ) {
    throw new Error("Segment search documents require a nonnegative ordinal");
  }
  const headingAncestors = input.headingAncestors.map((value) => value.trim());
  const okfSignals = normalizeSignals(input.okfSignals);
  return {
    id: "content-" + digest([
      STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
      input.knowledgeBaseId,
      input.sourceFilePublicId,
      input.sourceRevisionPublicId,
      input.logicalPath,
      input.fileKind,
      input.title ?? "",
      input.contentKind,
      input.segmentOrdinal === null ? "" : String(input.segmentOrdinal),
      JSON.stringify(headingAncestors),
      input.searchText,
      JSON.stringify(okfSignals)
    ]),
    schemaVersion: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
    documentKind: "content",
    contentKind: input.contentKind,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath: input.logicalPath,
    fileKind: input.fileKind,
    title: input.title,
    segmentOrdinal: input.segmentOrdinal,
    headingAncestors,
    searchText: input.searchText,
    okfSignals
  };
}

export function createStorageVnextGraphSeedDocument(input: {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sourceFilePublicId: StorageVnextPublicId;
  sourceRevisionPublicId: StorageVnextPublicId;
  logicalPath: string;
  title: string | null;
  searchText: string;
  rankingTerms: readonly string[];
  okfSignals?: OkfSearchSignals;
}): StorageVnextGraphSeedDocument {
  assertIdentity(input);
  const rankingTerms = [...new Set(
    input.rankingTerms.map((value) => value.trim()).filter(Boolean)
  )].sort();
  const okfSignals = normalizeSignals(input.okfSignals);
  return {
    id: "graph-seed-" + digest([
      STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
      input.knowledgeBaseId,
      input.sourceFilePublicId,
      input.sourceRevisionPublicId,
      input.logicalPath,
      input.title ?? "",
      input.searchText,
      JSON.stringify(rankingTerms),
      JSON.stringify(okfSignals)
    ]),
    schemaVersion: STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
    documentKind: "graph_seed",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath: input.logicalPath,
    title: input.title,
    searchText: input.searchText,
    rankingTerms,
    okfSignals
  };
}

function normalizeSignals(value: OkfSearchSignals | undefined): OkfSearchSignals {
  const signals = value ?? {
    status: null,
    trustTier: null,
    staleAfterEpochDay: null,
    generatedAtEpochMs: null,
    latestVerifiedAtEpochMs: null,
    sourceCount: null
  };
  if (
    !nullableEnum(signals.status, ["draft", "stable", "deprecated"])
    || !nullableEnum(signals.trustTier, [
      "unverified", "machine-confirmed", "human-reviewed"
    ])
    || !nullableInteger(signals.staleAfterEpochDay)
    || !nullableInteger(signals.generatedAtEpochMs)
    || !nullableInteger(signals.latestVerifiedAtEpochMs)
    || !nullableNonnegativeInteger(signals.sourceCount)
  ) throw new Error("Search document OKF signals are invalid");
  return structuredClone(signals);
}

function nullableEnum<T extends string>(value: unknown, allowed: readonly T[]): boolean {
  return value === null || typeof value === "string" && allowed.includes(value as T);
}

function nullableInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function nullableNonnegativeInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertIdentity(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.sourceFilePublicId
    || !input.sourceRevisionPublicId
    || !input.logicalPath
  ) {
    throw new Error("Search document identity is incomplete");
  }
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\\u0000")).digest("hex");
}
