import { posix } from "node:path";
import { portableIndexDirectoryPath } from "@focowiki/okf";
import { buildDocumentPageDirectoryScopeResources,
  buildDocumentPageDirectoryScopeResourcesFromPacket } from
  "../application/document-page-term-projection.js";
import { applyDocumentRecordStableShardDelta } from
  "../application/document-record-stable-shard-delta.js";
import type { DocumentPublicationImmutableScopeSnapshot } from
  "../application/document-publication-scope-generation-runtime.js";
import { documentDirectoryEntryId } from
  "../domain/document-directory-entry-identity.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import { scopeRenderError } from
  "./production-document-scope-renderer-support.js";

export type DocumentPageIntegrityOverride = Readonly<{
  path: string;
  checksumSha256: string;
  byteCount: number;
}>;
type SnapshotPage = NonNullable<
  DocumentPublicationImmutableScopeSnapshot["basePages"]
>[number];
type ChildDirectory = { title: string; scopePath: string; path: string };

export async function projectDocumentPageDirectoryScope(input: {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  objectBodies?: StorageVnextImmutableBodyStore;
  knowledgeBaseId: string;
  scopePath: string;
  publicationGenerationPublicId?: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  affectedSourceFilePublicIds?: readonly string[];
  affectedLogicalPaths?: readonly string[];
  planningMode?: "initial" | "delta" | "repair";
  basePages?: DocumentPublicationImmutableScopeSnapshot["basePages"];
  checkpoint?: () => Promise<void>;
  signal?: AbortSignal;
  pageIntegrityOverrides: readonly DocumentPageIntegrityOverride[];
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
}) {
  const integrity = normalizePageIntegrityOverrides(
    input.pageIntegrityOverrides);
  if (input.planningMode === "delta") {
    const affected = [...new Set(
      input.affectedSourceFilePublicIds ?? [])].sort();
    if (affected.length === 0 || !input.publicationGenerationPublicId) {
      throw scopeRenderError("publication_delta_closure_incomplete");
    }
    const state = await input.machineProjection.readSemanticDirectoryDeltaState({
      knowledgeBaseId: input.knowledgeBaseId,
      scopePath: input.scopePath,
      affectedSourceFilePublicIds: affected,
      includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
      navigationSourceFilePublicIds: [],
      publicationGenerationPublicId: input.publicationGenerationPublicId
    });
    const base = await readBaseRouter(input);
    const changedRecords = applyIntegrity(state.records, integrity);
    const delta = await applyDocumentRecordStableShardDelta({
      scopePath: input.scopePath,
      baseResources: base.resources,
      changedRecords,
      removedRecordPaths: state.removedRecordPaths,
      maximumRecords: input.maximumRecordsPerShard,
      maximumBytes: input.maximumShardBytes,
      readRecords: (path) => readBaseRecords(input, path),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {})
    });
    const childDirectories = mergeChildren(
      base.childDirectories,
      state.childDirectories,
      input.scopePath,
      input.affectedLogicalPaths ?? []
    );
    const projected = buildDocumentPageDirectoryScopeResourcesFromPacket({
      scopePath: input.scopePath,
      packet: { pages: delta.pages, descriptors: delta.descriptors },
      recordCount: delta.recordCount,
      childDirectories,
      previousPaths: base.resources.map((item) => item.path)
    });
    return {
      ...projected,
      records: changedRecords,
      childDirectories,
      navigationCandidateEntryIds: navigationCandidates(
        input.scopePath,
        [...projected.pages.map((page) => page.logicalPath),
          ...projected.removedLogicalPaths],
        input.affectedLogicalPaths ?? []
      )
    };
  }
  const state = await input.machineProjection.readDocumentDirectoryState({
    knowledgeBaseId: input.knowledgeBaseId,
    scopePath: input.scopePath,
    ...(input.publicationGenerationPublicId
      ? { publicationGenerationPublicId:
          input.publicationGenerationPublicId } : {}),
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
  });
  return {
    ...buildDocumentPageDirectoryScopeResources({
      scopePath: input.scopePath,
      records: applyIntegrity(state.records, integrity),
      childDirectories: state.childDirectories,
      previousPaths: state.resourcePaths,
      maximumRecordsPerShard: input.maximumRecordsPerShard,
      maximumShardBytes: input.maximumShardBytes
    }),
    records: state.records,
    childDirectories: state.childDirectories
  };
}

async function readBaseRouter(input: Parameters<
  typeof projectDocumentPageDirectoryScope>[0]) {
  const directory = portableIndexDirectoryPath(input.scopePath);
  const page = input.basePages?.find((candidate) =>
    (candidate.logicalPath ?? candidate.normalizedPath)
      === `${directory}/index.json` && candidate.action === "put");
  if (!page) return { resources: [] as Descriptor[],
    childDirectories: [] as ChildDirectory[] };
  const value = await readBaseJson(input, page);
  if (!Array.isArray(value.resources)
    || !Array.isArray(value.childDirectories)
    || !Number.isSafeInteger(value.documentCount)) {
    throw scopeRenderError("document_delta_base_router_invalid");
  }
  return {
    resources: value.resources.map(parseDescriptor),
    childDirectories: value.childDirectories.map(parseChild)
  };
}

type Descriptor = ReturnType<typeof parseDescriptor>;
function parseDescriptor(value: unknown) {
  const item = object(value, "document_delta_base_router_invalid");
  if (typeof item.path !== "string" || typeof item.firstKey !== "string"
    || typeof item.lastKey !== "string"
    || !Number.isSafeInteger(item.recordCount)
    || !Number.isSafeInteger(item.byteCount)) {
    throw scopeRenderError("document_delta_base_router_invalid");
  }
  return { path: item.path, firstKey: item.firstKey,
    lastKey: item.lastKey, recordCount: Number(item.recordCount),
    byteCount: Number(item.byteCount) };
}

function parseChild(value: unknown): ChildDirectory {
  const item = object(value, "document_delta_base_router_invalid");
  if (typeof item.title !== "string" || typeof item.scopePath !== "string"
    || typeof item.path !== "string") {
    throw scopeRenderError("document_delta_base_router_invalid");
  }
  return { title: item.title, scopePath: item.scopePath, path: item.path };
}

async function readBaseRecords(
  input: Parameters<typeof projectDocumentPageDirectoryScope>[0], path: string
) {
  const page = input.basePages?.find((candidate) =>
    (candidate.logicalPath ?? candidate.normalizedPath) === path
      && candidate.action === "put");
  if (!page) throw scopeRenderError("document_delta_base_shard_missing");
  const value = await readBaseJson(input, page);
  if (!Array.isArray(value.documents)
    || value.documents.some((record) => !record || typeof record !== "object"
      || Array.isArray(record))) {
    throw scopeRenderError("document_delta_base_shard_invalid");
  }
  return value.documents as Record<string, unknown>[];
}

async function readBaseJson(
  input: Parameters<typeof projectDocumentPageDirectoryScope>[0],
  page: SnapshotPage
) {
  if (!input.objectBodies || !page.objectId || !page.storageKey
    || !page.checksumSha256 || page.byteCount === null || !page.contentType
    || !page.objectFormat) {
    throw scopeRenderError("document_delta_base_object_unavailable");
  }
  const bytes = await input.objectBodies.readVerified({
    descriptor: { objectId: page.objectId, storageKey: page.storageKey,
      checksum: page.checksumSha256, byteCount: page.byteCount,
      contentType: page.contentType, objectFormat: page.objectFormat as never },
    maximumBytes: Math.max(1, page.byteCount),
    ...(input.signal ? { signal: input.signal } : {})
  });
  await input.checkpoint?.();
  return object(JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    "document_delta_base_json_invalid");
}

function mergeChildren(
  base: readonly ChildDirectory[], changed: readonly ChildDirectory[],
  scopePath: string, affectedPaths: readonly string[]
) {
  const affected = new Set(affectedPaths.flatMap((path) =>
    directChildScope(scopePath, path)));
  return [...base.filter((item) => !affected.has(item.scopePath)), ...changed]
    .filter((item, index, values) => values.findIndex((candidate) =>
      candidate.scopePath === item.scopePath) === index)
    .sort((left, right) => left.scopePath.localeCompare(right.scopePath,
      "en-US"));
}

function navigationCandidates(
  scopePath: string, changedPages: readonly string[],
  affectedPaths: readonly string[]
) {
  const directory = portableIndexDirectoryPath(scopePath);
  const files = changedPages.flatMap((path) => posix.dirname(path) === directory
    ? [documentDirectoryEntryId("file", path)] : []);
  const children = affectedPaths.flatMap((path) =>
    directChildScope(scopePath, path).map((child) =>
      documentDirectoryEntryId("directory",
        `${portableIndexDirectoryPath(child)}/index.md`)));
  return [...new Set([...files, ...children])].sort();
}

function directChildScope(scopePath: string, path: string) {
  const normalized = path.startsWith("pages/") ? path : `pages/${path}`;
  const relative = normalized.startsWith(`${scopePath}/`)
    ? normalized.slice(scopePath.length + 1) : "";
  const first = relative.split("/")[0];
  return first && relative.includes("/") ? [`${scopePath}/${first}`] : [];
}

function applyIntegrity(
  records: readonly Record<string, unknown>[],
  integrity: ReadonlyMap<string, Pick<DocumentPageIntegrityOverride,
    "checksumSha256" | "byteCount">>
) {
  return records.map((record) => {
    const path = typeof record.path === "string" ? record.path : "";
    const value = integrity.get(path);
    return value ? { ...record, ...value } : record;
  });
}

function normalizePageIntegrityOverrides(values: readonly
  DocumentPageIntegrityOverride[]) {
  const result = new Map<string, Pick<DocumentPageIntegrityOverride,
    "checksumSha256" | "byteCount">>();
  for (const value of values) {
    if (!value.path.startsWith("pages/") || !value.path.endsWith(".md")
      || !/^[0-9a-f]{64}$/u.test(value.checksumSha256)
      || !Number.isSafeInteger(value.byteCount) || value.byteCount < 0
      || result.has(value.path)) {
      throw scopeRenderError("page_integrity_override_invalid");
    }
    result.set(value.path, { checksumSha256: value.checksumSha256,
      byteCount: value.byteCount });
  }
  return result;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw scopeRenderError(code);
  }
  return value as Record<string, unknown>;
}
