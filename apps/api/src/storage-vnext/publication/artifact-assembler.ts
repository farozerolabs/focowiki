import type {
  PersistentDirectoryLeaf
} from "../../application/ports/directory-navigation-repository.js";
import type {
  EffectiveProjectionShard
} from "../../application/ports/projection-catalog-repository.js";
import { renderProjectionCatalog } from
  "../../publication/projection-catalog-writer.js";
import { directoryLeafPath } from
  "../../publication/directory-navigation-writer.js";
import type { StorageVnextCurrentSourceFact } from "../catalog/ports.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type {
  StorageVnextDirectorySummary,
  StorageVnextKnowledgeBaseSummary,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort,
  StorageVnextShardDescriptor
} from "../release/ports.js";
import {
  STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS
} from "./validation.js";
import { assembleStorageVnextPageArtifact } from "./page-artifact.js";
import { planStorageVnextPublicationBatch } from "./planning.js";
import {
  renderStorageVnextDirectoryArtifacts,
  renderStorageVnextRootArtifact
} from "./rendering.js";
import type {
  StorageVnextInternalShard,
  StorageVnextPublicationArtifact
} from "./types.js";

type PublicationIdentity = {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
  searchProjectionPublicId: string;
  signal: AbortSignal;
};

export type StorageVnextPublicationPageInput = {
  current: StorageVnextCurrentSourceFact;
  node: StorageVnextGraphNodeFact;
  neighborhood: readonly StorageVnextGraphEdgeFact[];
  endpointNodes: readonly StorageVnextGraphNodeFact[];
  sourceBody: string;
};

export type StorageVnextPublicationDirectoryInput = {
  directoryPublicId: string | null;
  directoryPath: string;
  entryCount: number;
  descendantFileCount: number;
  leaves: readonly PersistentDirectoryLeaf[];
};

export type StorageVnextPublicationProjection = {
  knowledgeBase: {
    id: string;
    name: string;
    description: string | null;
    sourceFileCount: number;
    graphEdgeCount: number;
  };
  rootEntryCount: number;
  directories: readonly StorageVnextPublicationDirectoryInput[];
  projectionShards: readonly EffectiveProjectionShard[];
  internalShards: readonly StorageVnextInternalShard[];
  reusedInternalShards: readonly StorageVnextShardDescriptor[];
  removedSourceLogicalPaths?: readonly string[];
  batches: AsyncIterable<StorageVnextPublicationProjectionBatch>;
};

export type StorageVnextPublicationProjectionBatch = {
  pages: readonly StorageVnextPublicationPageInput[];
  machineArtifacts: readonly StorageVnextPublicationArtifact[];
  projectionShards: readonly EffectiveProjectionShard[];
  deletedLogicalPaths: readonly string[];
};

type ProjectionPort = {
  load(input: PublicationIdentity & {
    plan: ReturnType<typeof planStorageVnextPublicationBatch>;
  }): Promise<StorageVnextPublicationProjection>;
  summarizeCandidate(input: PublicationIdentity): Promise<StorageVnextKnowledgeBaseSummary>;
};

type PublisherResult = { artifactCount: number; [key: string]: number };

export function createStorageVnextPublicationArtifactAssembler(input: {
  releases: Pick<
    StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
    "listCandidateDependencies" | "replaceCandidateSummaries"
  >;
  projection: ProjectionPort;
  publisher: {
    publish(input: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      operationPublicId: string;
      schemaChecksum: string;
      settingsChecksum: string;
      searchBatchOrdinal: number;
      deletedLogicalPaths: readonly string[];
      artifacts: readonly StorageVnextPublicationArtifact[];
      internalShards: readonly StorageVnextInternalShard[];
      reusedInternalShards: readonly StorageVnextShardDescriptor[];
      searchDocuments: readonly [];
    }): Promise<PublisherResult>;
  };
  schemaChecksum: string;
  settingsChecksum: string;
  limits: {
    dependencyPageSize: number;
    maximumDependencies: number;
    relatedFileLimit: number;
  };
}) {
  validateConfiguration(input);
  return {
    async publish(request: PublicationIdentity): Promise<PublisherResult> {
      validateRequest(request);
      const dependencies = await listDependencies(input, request);
      const plan = planStorageVnextPublicationBatch({
        dependencies,
        maximumDependencies: input.limits.maximumDependencies
      });
      assertRequiredNavigation(plan.rootPaths);
      const projection = await input.projection.load({ ...request, plan });
      throwIfAborted(request.signal);
      validateProjection(request, plan, projection);
      const results: PublisherResult[] = [];
      results.push(await publishArtifacts(input, request, {
        artifacts: assembleStaticArtifacts({
          request,
          projection
        }),
        deletedLogicalPaths: [],
        internalShards: projection.internalShards,
        reusedInternalShards: projection.reusedInternalShards
      }));
      const projectionShards = new Map(projection.projectionShards.map((shard) =>
        [shard.logicalPath, shard]));
      for await (const batch of projection.batches) {
        throwIfAborted(request.signal);
        validateBatch(request, plan, batch);
        for (const logicalPath of batch.deletedLogicalPaths) {
          projectionShards.delete(logicalPath);
        }
        for (const shard of batch.projectionShards) {
          projectionShards.set(shard.logicalPath, shard);
        }
        results.push(await publishArtifacts(input, request, {
          artifacts: assembleBatchArtifacts({
            batch,
            removedSourceLogicalPaths: projection.removedSourceLogicalPaths ?? [],
            relatedFileLimit: input.limits.relatedFileLimit
          }),
          deletedLogicalPaths: batch.deletedLogicalPaths,
          internalShards: [],
          reusedInternalShards: []
        }));
      }
      results.push(await publishArtifacts(input, request, {
        artifacts: [catalogArtifact({
          request,
          projectionShards: [...projectionShards.values()].sort((left, right) =>
            compareUtf8(left.logicalPath, right.logicalPath))
        })],
        deletedLogicalPaths: [],
        internalShards: [],
        reusedInternalShards: []
      }));
      throwIfAborted(request.signal);
      const knowledgeBase = await input.projection.summarizeCandidate(request);
      await input.releases.replaceCandidateSummaries({
        candidatePublicId: request.candidatePublicId,
        directories: directorySummaries(projection.directories),
        knowledgeBase
      });
      return mergePublisherResults(results);
    }
  };
}

async function publishArtifacts(
  input: Parameters<typeof createStorageVnextPublicationArtifactAssembler>[0],
  request: PublicationIdentity,
  batch: {
    artifacts: readonly StorageVnextPublicationArtifact[];
    deletedLogicalPaths: readonly string[];
    internalShards: readonly StorageVnextInternalShard[];
    reusedInternalShards: readonly StorageVnextShardDescriptor[];
  }
): Promise<PublisherResult> {
  return input.publisher.publish({
    knowledgeBaseId: request.knowledgeBaseId,
    candidatePublicId: request.candidatePublicId,
    operationPublicId: request.operationPublicId,
    schemaChecksum: input.schemaChecksum,
    settingsChecksum: input.settingsChecksum,
    searchBatchOrdinal: 0,
    ...batch,
    searchDocuments: []
  });
}

function mergePublisherResults(results: readonly PublisherResult[]): PublisherResult {
  const output: PublisherResult = { artifactCount: 0 };
  for (const result of results) {
    for (const [key, value] of Object.entries(result)) {
      output[key] = (output[key] ?? 0) + value;
    }
  }
  return output;
}

function catalogArtifact(input: {
  request: PublicationIdentity;
  projectionShards: EffectiveProjectionShard[];
}): StorageVnextPublicationArtifact {
  return {
    logicalPath: "_index/catalog.json",
    kind: "index",
    sourceFilePublicId: null,
    ordinal: 0,
    bytes: Buffer.from(renderProjectionCatalog({
      knowledgeBaseId: input.request.knowledgeBaseId,
      generationId: input.request.candidatePublicId,
      shards: input.projectionShards
    }), "utf8")
  };
}

function assembleBatchArtifacts(input: {
  batch: StorageVnextPublicationProjectionBatch;
  removedSourceLogicalPaths: readonly string[];
  relatedFileLimit: number;
}): StorageVnextPublicationArtifact[] {
  const artifacts = [
    ...input.batch.pages.map((page) => assembleStorageVnextPageArtifact({
      ...page,
      removedSourceLogicalPaths: input.removedSourceLogicalPaths,
      ordinal: 0,
      relatedFileLimit: input.relatedFileLimit
    })),
    ...input.batch.machineArtifacts
  ].sort((left, right) => compareUtf8(left.logicalPath, right.logicalPath));
  return artifacts.map((artifact, ordinal) => ({ ...artifact, ordinal }));
}

function assembleStaticArtifacts(input: {
  request: PublicationIdentity;
  projection: StorageVnextPublicationProjection;
}): StorageVnextPublicationArtifact[] {
  return assembleArtifacts({
    request: input.request,
    projection: input.projection
  });
}

async function listDependencies(
  input: Parameters<typeof createStorageVnextPublicationArtifactAssembler>[0],
  request: PublicationIdentity
) {
  const dependencies = [];
  let cursor: string | null = null;
  do {
    throwIfAborted(request.signal);
    const page = await input.releases.listCandidateDependencies({
      candidatePublicId: request.candidatePublicId,
      limit: input.limits.dependencyPageSize,
      cursor
    });
    if (
      page.items.length > input.limits.dependencyPageSize
      || dependencies.length + page.items.length > input.limits.maximumDependencies
    ) throw artifactAssemblerError("dependency_budget_exceeded");
    dependencies.push(...page.items);
    cursor = advancingCursor(cursor, page.nextCursor);
  } while (cursor !== null);
  return dependencies;
}

function assembleArtifacts(input: {
  request: PublicationIdentity;
  projection: StorageVnextPublicationProjection;
}): StorageVnextPublicationArtifact[] {
  const byPath = new Map<string, StorageVnextPublicationArtifact>();
  const add = (artifact: StorageVnextPublicationArtifact) => {
    if (byPath.has(artifact.logicalPath)) {
      throw artifactAssemblerError("duplicate_logical_path");
    }
    byPath.set(artifact.logicalPath, artifact);
  };

  for (const path of STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS) {
    if (path === "pages/index.md" || path === "_index/catalog.json") continue;
    add(renderStorageVnextRootArtifact({
      path,
      knowledgeBase: input.projection.knowledgeBase,
      rootEntryCount: input.projection.rootEntryCount,
      generationId: input.request.candidatePublicId,
      ordinal: 0
    }));
  }
  for (const directory of [...input.projection.directories].sort((left, right) =>
    compareUtf8(left.directoryPath, right.directoryPath))) {
    for (const artifact of renderStorageVnextDirectoryArtifacts({
      directoryPath: directory.directoryPath,
      entryCount: directory.entryCount,
      leaves: directory.leaves,
      ordinalStart: 0
    })) add(artifact);
  }
  for (const required of STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.filter((path) =>
    path !== "_index/catalog.json")) {
    if (!byPath.has(required)) {
      throw artifactAssemblerError("required_navigation_conflict");
    }
  }
  const requiredPaths = STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.filter((path) =>
    path !== "_index/catalog.json");
  const required = new Set<string>(requiredPaths);
  const ordered = [
    ...requiredPaths.map((path) => byPath.get(path)!),
    ...[...byPath.values()]
      .filter((artifact) => !required.has(artifact.logicalPath))
  ];
  return ordered.map((artifact, ordinal) => ({ ...artifact, ordinal }));
}

function directorySummaries(
  directories: readonly StorageVnextPublicationDirectoryInput[]
): StorageVnextDirectorySummary[] {
  return [...directories]
    .sort((left, right) => compareUtf8(left.directoryPath, right.directoryPath))
    .map((directory, ordinal) => ({
      directoryPublicId: directory.directoryPublicId,
      logicalPath: directory.directoryPath,
      firstLeafPath: directory.leaves[0]
        ? directoryLeafPath(directory.directoryPath, directory.leaves[0].id)
        : null,
      directFileCount: directory.leaves.reduce(
        (count, leaf) => count + leaf.entries.filter((entry) => entry.kind === "file").length,
        0
      ),
      descendantFileCount: directory.descendantFileCount,
      ordinal
    }));
}

function assertRequiredNavigation(rootPaths: readonly string[]): void {
  const actual = new Set(rootPaths);
  if (
    actual.size !== STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.length
    || STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.some((path) => !actual.has(path))
  ) throw artifactAssemblerError("required_navigation_conflict");
}

function validateProjection(
  request: PublicationIdentity,
  plan: ReturnType<typeof planStorageVnextPublicationBatch>,
  projection: StorageVnextPublicationProjection
): void {
  const directoryPaths = new Set(projection.directories.map((directory) => directory.directoryPath));
  const plannedDirectoryPaths = new Set(plan.directoryPaths);
  if (
    projection.knowledgeBase.id !== request.knowledgeBaseId
    || directoryPaths.size !== projection.directories.length
    || projection.directories.some((directory) =>
      !plannedDirectoryPaths.has(directory.directoryPath))
    || (plannedDirectoryPaths.has("pages") && !directoryPaths.has("pages"))
  ) throw artifactAssemblerError("projection_scope_conflict");
}

function validateBatch(
  request: PublicationIdentity,
  _plan: ReturnType<typeof planStorageVnextPublicationBatch>,
  batch: StorageVnextPublicationProjectionBatch
): void {
  const deletedPaths = new Set(batch.deletedLogicalPaths);
  if (
    batch.pages.some((page) =>
      page.current.sourceFile.knowledgeBaseId !== request.knowledgeBaseId
      || !page.node.logicalPath.startsWith("pages/"))
    || batch.pages.some((page) => deletedPaths.has(page.node.logicalPath))
  ) throw artifactAssemblerError("projection_scope_conflict");
}

function validateConfiguration(
  input: Parameters<typeof createStorageVnextPublicationArtifactAssembler>[0]
): void {
  if (
    !/^[0-9a-f]{64}$/u.test(input.schemaChecksum)
    || !/^[0-9a-f]{64}$/u.test(input.settingsChecksum)
    || Object.values(input.limits).some((value) =>
      !Number.isSafeInteger(value) || value < 1)
    || input.limits.dependencyPageSize > 1_000
    || input.limits.dependencyPageSize > input.limits.maximumDependencies
    || input.limits.relatedFileLimit > 1_000
  ) throw artifactAssemblerError("invalid_configuration");
}

function validateRequest(request: PublicationIdentity): void {
  if (
    request.candidatePublicId !== request.searchProjectionPublicId
    || [
      request.knowledgeBaseId,
      request.candidatePublicId,
      request.operationPublicId
    ].some((value) => !value || Buffer.byteLength(value) > 255)
  ) throw artifactAssemblerError("invalid_request");
}

function advancingCursor(previous: string | null, next: string | null): string | null {
  if (next !== null && next === previous) {
    throw artifactAssemblerError("dependency_cursor_stalled");
  }
  return next;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Storage vNext publication artifact assembly aborted", "AbortError");
}

function artifactAssemblerError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication artifact assembler error: ${code}`),
    { code }
  );
}
