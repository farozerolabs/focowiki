import { posix } from "node:path";
import {
  portableByFileGraphDirectoryPath,
  portableByFileGraphPath,
  portableDirectoryResourceSubject,
  portableGraphDirectoryPath
} from "@focowiki/okf";
import {
  buildDocumentGraphCatalogPage,
  buildDocumentGraphDirectoryScopeResourcesFromPacket,
  documentGraphRelationshipKey,
  buildDocumentPerFileGraphScopeResource
} from "../application/document-graph-projection.js";
import { createDocumentSemanticPacketAccumulator } from
  "../application/document-semantic-resource-packets.js";
import { applyDocumentGraphStableShardDelta,
  type DocumentGraphBaseRouter } from
  "../application/document-graph-stable-shard-delta.js";
import {
  directoryResourceTitle
} from "../application/document-machine-projection-shared.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import { documentDirectoryEntryId } from
  "../domain/document-directory-entry-identity.js";

type Dependencies = {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
  objectBodies?: StorageVnextImmutableBodyStore;
};

type Visibility = {
  knowledgeBaseId: string;
  publicationGenerationPublicId?: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  affectedSourceFilePublicIds?: readonly string[];
  checkpoint?: () => Promise<void>;
  signal?: AbortSignal;
  planningMode?: "initial" | "delta" | "repair";
  baseDeterministicChangedAt?: string | null;
  basePages?: readonly Readonly<{
    logicalPath?: string;
    normalizedPath: string;
    action: "put" | "delete";
    objectId: string | null;
    checksumSha256: string | null;
    byteCount: number | null;
    storageKey?: string | null;
    contentType?: string | null;
    objectFormat?: string | null;
  }>[];
  affectedLogicalPaths?: readonly string[];
};

export async function projectGraphCatalog(input: {
  dependencies: Dependencies;
} & Visibility) {
  const state = await input.dependencies.machineProjection.readGraphCatalogState({
    knowledgeBaseId: input.knowledgeBaseId,
    ...(input.publicationGenerationPublicId
      ? { publicationGenerationPublicId:
          input.publicationGenerationPublicId } : {}),
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
  });
  return {
    pages: [buildDocumentGraphCatalogPage(state.relationshipCount)],
    removedLogicalPaths: [] as string[],
    records: [] as Record<string, unknown>[],
    factCount: state.relationshipCount
  };
}

export async function projectPerFileGraph(input: {
  dependencies: Dependencies;
  sourceFilePublicId: string;
} & Visibility) {
  const state = await input.dependencies.machineProjection.readPerFileGraphState({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
  });
  return {
    ...buildDocumentPerFileGraphScopeResource({
      source: state.source,
      relationships: state.relationships,
      previousPaths: state.resourcePaths
    }),
    records: state.relationships
  };
}

export async function projectGraphDirectory(input: {
  dependencies: Dependencies;
  scopePath: string;
} & Visibility) {
  const includedSourceFilePublicIds =
    input.includedSourceRevisionPublicIds.length > 0
      && input.excludedActiveSourceFilePublicIds.length === 0
      ? await input.dependencies.machineProjection
          .resolveSourceFilePublicIdsForRevisions({
            knowledgeBaseId: input.knowledgeBaseId,
            sourceRevisionPublicIds: input.includedSourceRevisionPublicIds
          })
      : [];
  const affectedSourceFilePublicIds = [...new Set(
    [...includedSourceFilePublicIds, ...input.excludedActiveSourceFilePublicIds]
  )].sort();
  const machineDirectory = portableGraphDirectoryPath(input.scopePath);
  const packetAccumulator = createDocumentSemanticPacketAccumulator({
    family: "relationship_packet",
    directoryPath: machineDirectory,
    subject: portableDirectoryResourceSubject(input.scopePath),
    title: directoryResourceTitle(input.scopePath, "relationships"),
    scopePath: input.scopePath,
    recordKey: documentGraphRelationshipKey,
    maximumRecords: input.dependencies.maximumRecordsPerShard,
    maximumBytes: input.dependencies.maximumShardBytes
  });
  const changedRecords: Record<string, unknown>[] = [];
  const scanInput = {
    knowledgeBaseId: input.knowledgeBaseId,
    scopePath: input.scopePath,
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds,
    affectedSourceFilePublicIds,
    ...(input.baseDeterministicChangedAt
      ? { baseDeterministicChangedAt: input.baseDeterministicChangedAt }
      : {}),
    ...(input.affectedLogicalPaths
      ? { affectedLogicalPaths: input.affectedLogicalPaths } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    async onRecords(records: readonly Record<string, unknown>[]) {
      changedRecords.push(...records);
      if (input.planningMode !== "delta") packetAccumulator.append(records);
      await input.checkpoint?.();
    }
  };
  const state = input.planningMode === "repair"
      || input.planningMode === "initial"
    ? await input.dependencies.machineProjection.scanGraphDirectoryState({
        knowledgeBaseId: input.knowledgeBaseId,
        scopePath: input.scopePath,
        includedSourceRevisionPublicIds:
          input.includedSourceRevisionPublicIds,
        excludedActiveSourceFilePublicIds:
          input.excludedActiveSourceFilePublicIds,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        onRecords: scanInput.onRecords
      })
    : await input.dependencies.machineProjection.scanGraphDirectoryDeltaState(
        scanInput);
  if (input.planningMode === "delta") {
    const base = await readBaseRouter(input, machineDirectory);
    const delta = await applyDocumentGraphStableShardDelta({
      scopePath: input.scopePath,
      machineDirectory,
      base,
      changedRecords,
      removedRecordKeys: state.removedRecordKeys,
      maximumRecords: input.dependencies.maximumRecordsPerShard,
      maximumBytes: input.dependencies.maximumShardBytes,
      readRecords: (path) => readBaseRecords(input, path),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {})
    });
    const childDirectories = mergeChildDirectories(
      base.childDirectories, state.childDirectories,
      input.scopePath, input.affectedLogicalPaths ?? []
    );
    const projected = buildDocumentGraphDirectoryScopeResourcesFromPacket({
        scopePath: input.scopePath,
        packet: { pages: delta.pages, descriptors: delta.descriptors },
        recordCount: delta.relationshipCount,
        childDirectories,
        previousPaths: base.resources.map((resource) => resource.path)
      });
    return {
      ...projected,
      records: [] as Record<string, unknown>[],
      factCount: delta.relationshipCount,
      childDirectories,
      navigationCandidateEntryIds: graphNavigationCandidates({
        scopePath: input.scopePath,
        changedPages: [
          ...projected.pages.map((page) => page.logicalPath),
          ...projected.removedLogicalPaths
        ],
        affectedLogicalPaths: input.affectedLogicalPaths ?? []
      })
    };
  }
  return {
    ...buildDocumentGraphDirectoryScopeResourcesFromPacket({
      scopePath: input.scopePath,
      packet: packetAccumulator.finish(),
      recordCount: state.recordCount,
      childDirectories: state.childDirectories,
      previousPaths: state.resourcePaths
    }),
    records: [] as Record<string, unknown>[],
    factCount: state.recordCount,
    childDirectories: state.childDirectories
  };
}

function graphNavigationCandidates(input: {
  scopePath: string;
  changedPages: readonly string[];
  affectedLogicalPaths: readonly string[];
}) {
  const directory = portableGraphDirectoryPath(input.scopePath);
  const files = input.changedPages.flatMap((path) =>
    posix.dirname(path) === directory
      ? [documentDirectoryEntryId("file", path)] : []);
  const children = input.affectedLogicalPaths.flatMap((path) => {
    const normalized = path.startsWith("pages/") ? path : `pages/${path}`;
    if (!normalized.startsWith(`${input.scopePath}/`)) return [];
    const relative = normalized.slice(input.scopePath.length + 1);
    const childName = relative.split("/")[0];
    if (!childName || !relative.includes("/")) return [];
    const child = `${input.scopePath}/${childName}`;
    return [documentDirectoryEntryId("directory",
      `${portableGraphDirectoryPath(child)}/index.md`)];
  });
  return [...new Set([...files, ...children])].sort();
}

async function readBaseRouter(
  input: Parameters<typeof projectGraphDirectory>[0],
  machineDirectory: string
): Promise<DocumentGraphBaseRouter> {
  const page = input.basePages?.find((candidate) =>
    (candidate.logicalPath ?? candidate.normalizedPath)
      === `${machineDirectory}/index.json`
      && candidate.action === "put");
  if (!page) {
    return { relationshipCount: 0, childDirectories: [], resources: [] };
  }
  const value = await readBaseJson(input, page);
  if (!Number.isSafeInteger(value.relationshipCount)
    || !Array.isArray(value.resources)
    || !Array.isArray(value.childDirectories)) {
    throw graphProjectionError("graph_delta_base_router_invalid");
  }
  return {
    relationshipCount: Number(value.relationshipCount),
    resources: value.resources.map(parseDescriptor),
    childDirectories: value.childDirectories.map(parseChildDirectory)
  };
}

async function readBaseRecords(
  input: Parameters<typeof projectGraphDirectory>[0],
  path: string
): Promise<readonly Record<string, unknown>[]> {
  const page = input.basePages?.find((candidate) =>
    (candidate.logicalPath ?? candidate.normalizedPath) === path
      && candidate.action === "put");
  if (!page) throw graphProjectionError("graph_delta_base_shard_missing");
  const value = await readBaseJson(input, page);
  if (!Array.isArray(value.relationships)
    || value.relationships.some((record) => !record
      || typeof record !== "object" || Array.isArray(record))) {
    throw graphProjectionError("graph_delta_base_shard_invalid");
  }
  return value.relationships as Record<string, unknown>[];
}

async function readBaseJson(
  input: Parameters<typeof projectGraphDirectory>[0],
  page: NonNullable<Parameters<typeof projectGraphDirectory>[0]["basePages"]>[number]
): Promise<Record<string, unknown>> {
  if (!input.dependencies.objectBodies || !page.objectId || !page.storageKey
    || !page.checksumSha256 || page.byteCount === null || !page.contentType
    || !page.objectFormat) {
    throw graphProjectionError("graph_delta_base_object_unavailable");
  }
  const bytes = await input.dependencies.objectBodies.readVerified({
    descriptor: {
      objectId: page.objectId,
      storageKey: page.storageKey,
      checksum: page.checksumSha256,
      byteCount: page.byteCount,
      contentType: page.contentType,
      objectFormat: page.objectFormat as never
    },
    maximumBytes: Math.max(page.byteCount, 1),
    ...(input.signal ? { signal: input.signal } : {})
  });
  await input.checkpoint?.();
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw graphProjectionError("graph_delta_base_json_invalid");
  }
  return value as Record<string, unknown>;
}

function parseDescriptor(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw graphProjectionError("graph_delta_base_router_invalid");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string"
    || !Number.isSafeInteger(item.recordCount)
    || typeof item.firstKey !== "string" || typeof item.lastKey !== "string"
    || !Number.isSafeInteger(item.byteCount)) {
    throw graphProjectionError("graph_delta_base_router_invalid");
  }
  return {
    path: item.path,
    recordCount: Number(item.recordCount),
    firstKey: item.firstKey,
    lastKey: item.lastKey,
    byteCount: Number(item.byteCount)
  };
}

function parseChildDirectory(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw graphProjectionError("graph_delta_base_router_invalid");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.title !== "string" || typeof item.scopePath !== "string"
    || typeof item.path !== "string") {
    throw graphProjectionError("graph_delta_base_router_invalid");
  }
  return { title: item.title, scopePath: item.scopePath, path: item.path };
}

function mergeChildDirectories(
  base: DocumentGraphBaseRouter["childDirectories"],
  changed: readonly { title: string; scopePath: string; path: string }[],
  scopePath: string,
  affectedLogicalPaths: readonly string[]
) {
  const affectedChildren = new Set(affectedLogicalPaths.flatMap((path) => {
    const normalized = path.startsWith("pages/") ? path : `pages/${path}`;
    if (!normalized.startsWith(`${scopePath}/`)) return [];
    const relative = normalized.slice(scopePath.length + 1);
    const child = relative.split("/")[0];
    return child && relative.includes("/") ? [`${scopePath}/${child}`] : [];
  }));
  return [...new Map([
    ...base.filter((item) => !affectedChildren.has(item.scopePath)),
    ...changed
  ].map((item) =>
    [item.scopePath, item])).values()].sort((left, right) =>
    left.scopePath.localeCompare(right.scopePath, "en-US"));
}

function graphProjectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Graph projection error: ${code}`), { code });
}

export async function projectPerFileGraphDirectory(input: {
  dependencies: Dependencies;
  scopePath: string;
} & Visibility) {
  const affected = [...new Set([
    ...(input.affectedSourceFilePublicIds ?? []),
    ...input.excludedActiveSourceFilePublicIds
  ])].sort();
  const candidateChildScopePaths = [...new Set(
    (input.affectedLogicalPaths ?? []).flatMap((path) => {
      const normalized = path.startsWith("pages/") ? path : `pages/${path}`;
      if (!normalized.startsWith(`${input.scopePath}/`)) return [];
      const relative = normalized.slice(input.scopePath.length + 1);
      const child = relative.split("/")[0];
      return child && relative.includes("/")
        ? [`${input.scopePath}/${child}`] : [];
    }))].sort();
  if (input.planningMode === "delta"
    && (!input.publicationGenerationPublicId || affected.length === 0)) {
    throw graphProjectionError("publication_delta_closure_incomplete");
  }
  const publicationGenerationPublicId = input.publicationGenerationPublicId;
  const state = input.planningMode === "delta"
    ? await input.dependencies.machineProjection
      .readPerFileGraphDirectoryDeltaState({
        knowledgeBaseId: input.knowledgeBaseId,
        scopePath: input.scopePath,
        publicationGenerationPublicId: publicationGenerationPublicId!,
        includedSourceRevisionPublicIds:
          input.includedSourceRevisionPublicIds,
        affectedSourceFilePublicIds: affected,
        candidateChildScopePaths
      })
    : await input.dependencies.machineProjection
      .readPerFileGraphDirectoryState({
      knowledgeBaseId: input.knowledgeBaseId,
      scopePath: input.scopePath,
      ...(input.publicationGenerationPublicId
        ? { publicationGenerationPublicId:
            input.publicationGenerationPublicId } : {}),
      includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
      excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
      });
  const directory = portableByFileGraphDirectoryPath(input.scopePath);
  const candidateIds = input.planningMode === "delta" ? [
    ...state.records.map((record) =>
      documentDirectoryEntryId("file", record.path)),
    ...(input.affectedLogicalPaths ?? []).flatMap((path) => {
      const normalized = path.startsWith("pages/") ? path : `pages/${path}`;
      const graphPath = portableByFileGraphPath(normalized);
      return posix.dirname(graphPath) === directory
        ? [documentDirectoryEntryId("file", graphPath)] : [];
    }),
    ...candidateChildScopePaths.map((scopePath) =>
      documentDirectoryEntryId("directory",
        `${portableByFileGraphDirectoryPath(scopePath)}/index.md`))
  ] : [];
  return {
    pages: [],
    removedLogicalPaths: [] as string[],
    records: state.records,
    childDirectories: state.childDirectories,
    ...(input.planningMode === "delta"
      ? { navigationCandidateEntryIds: [...new Set(candidateIds)].sort() }
      : {})
  };
}
