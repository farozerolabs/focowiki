import { createHash } from "node:crypto";
import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId
} from "../shared/types.js";

export const STORAGE_VNEXT_CONTENT_SCHEMA_VERSION =
  "storage-vnext-content-v1";
export const STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION =
  "storage-vnext-graph-seed-v1";

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
      input.searchText
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
    searchText: input.searchText
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
}): StorageVnextGraphSeedDocument {
  assertIdentity(input);
  const rankingTerms = [...new Set(
    input.rankingTerms.map((value) => value.trim()).filter(Boolean)
  )].sort();
  return {
    id: "graph-seed-" + digest([
      STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
      input.knowledgeBaseId,
      input.sourceFilePublicId,
      input.sourceRevisionPublicId,
      input.logicalPath,
      input.title ?? "",
      input.searchText,
      JSON.stringify(rankingTerms)
    ]),
    schemaVersion: STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
    documentKind: "graph_seed",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath: input.logicalPath,
    title: input.title,
    searchText: input.searchText,
    rankingTerms
  };
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
