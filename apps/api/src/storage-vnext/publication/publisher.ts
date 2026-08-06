import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { isAllowedPublicGeneratedFilePath } from "../../public-generated-path.js";
import type {
  StorageVnextImmutableObjectWriter
} from "../ownership/immutable-object-writer.js";
import type {
  StorageVnextReleaseWritePort,
  StorageVnextShardDescriptor
} from "../release/ports.js";
import { MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH } from "../release/ports.js";
import type {
  StorageVnextSearchDocument,
  StorageVnextSearchProjectionPort
} from "../search/ports.js";
import type {
  StorageVnextInternalShard,
  StorageVnextPublicationArtifact
} from "./types.js";

type PublicationLimits = {
  maximumArtifacts: number;
  maximumArtifactBytes: number;
  maximumSearchDocuments: number;
  maximumSearchCompressedBytes: number;
  objectWriteConcurrency: number;
};

export function createStorageVnextPublicationPublisher(input: {
  objects: Pick<StorageVnextImmutableObjectWriter, "putVerified">;
  releases: Pick<
    StorageVnextReleaseWritePort,
    | "addCandidateCatalogEntries"
    | "addCandidateCatalogTombstones"
    | "addCandidateShards"
  >;
  search: Pick<
    StorageVnextSearchProjectionPort,
    "prepareCandidate" | "writeDocumentBatch"
  >;
  clock: () => string;
  limits: PublicationLimits;
}) {
  validateLimits(input.limits);
  return {
    async publish(request: {
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
      searchDocuments: readonly StorageVnextSearchDocument[];
    }) {
      validateRequest(request, input.limits);
      let storedObjectCount = 0;
      let reusedObjectCount = 0;
      for (const logicalPaths of chunks(
        request.deletedLogicalPaths,
        MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
      )) {
        await input.releases.addCandidateCatalogTombstones({
          candidatePublicId: request.candidatePublicId,
          logicalPaths
        });
      }
      let catalogEntries: Parameters<
        StorageVnextReleaseWritePort["addCandidateCatalogEntries"]
      >[0]["entries"][number][] = [];
      const storedArtifacts = await mapWithConcurrency(
        request.artifacts,
        input.limits.objectWriteConcurrency,
        async (artifact) => ({
          artifact,
          object: await input.objects.putVerified({
            bytes: artifact.bytes,
            objectFormat: artifact.logicalPath.endsWith(".json")
              ? "okf-generated-json-v1"
              : "okf-generated-markdown-v1",
            writeAttemptPublicId: writeAttempt(
              request,
              `artifact:${artifact.logicalPath}`,
              artifact.bytes
            ),
            createdAt: input.clock()
          })
        })
      );
      for (const { artifact, object } of storedArtifacts) {
        if (object.outcome === "reused") reusedObjectCount += 1;
        else storedObjectCount += 1;
        catalogEntries.push({
          logicalPath: artifact.logicalPath,
          kind: artifact.kind,
          sourceFilePublicId: artifact.sourceFilePublicId,
          checksum: object.checksum,
          objectId: object.objectId,
          byteCount: object.byteCount,
          ordinal: artifact.ordinal
        });
        if (catalogEntries.length === MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH) {
          await input.releases.addCandidateCatalogEntries({
            candidatePublicId: request.candidatePublicId,
            entries: catalogEntries
          });
          catalogEntries = [];
        }
      }
      if (catalogEntries.length > 0) {
        await input.releases.addCandidateCatalogEntries({
          candidatePublicId: request.candidatePublicId,
          entries: catalogEntries
        });
      }

      const shardDescriptors: StorageVnextShardDescriptor[] = [];
      const storedShards = await mapWithConcurrency(
        request.internalShards,
        input.limits.objectWriteConcurrency,
        async (shard) => ({
          shard,
          object: await input.objects.putVerified({
            bytes: shard.bytes,
            objectFormat: "okf-generated-json-v1",
            writeAttemptPublicId: writeAttempt(
              request,
              `shard:${shard.publicId}`,
              shard.bytes
            ),
            createdAt: input.clock()
          })
        })
      );
      for (const { shard, object } of storedShards) {
        if (object.outcome === "reused") reusedObjectCount += 1;
        else storedObjectCount += 1;
        shardDescriptors.push({
          publicId: shard.publicId,
          logicalKind: shard.logicalKind,
          firstLogicalPath: shard.firstLogicalPath,
          lastLogicalPath: shard.lastLogicalPath,
          recordCount: shard.recordCount,
          byteCount: object.byteCount,
          checksum: object.checksum,
          objectId: object.objectId,
          ordinal: shard.ordinal
        });
      }
      shardDescriptors.push(...request.reusedInternalShards);
      const shardResult = {
        createdDescriptorCount: 0,
        reusedDescriptorCount: 0,
        attachedCount: 0
      };
      for (const shards of chunks(
        shardDescriptors,
        MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
      )) {
        const batch = await input.releases.addCandidateShards({
          candidatePublicId: request.candidatePublicId,
          shards
        });
        shardResult.createdDescriptorCount += batch.createdDescriptorCount;
        shardResult.reusedDescriptorCount += batch.reusedDescriptorCount;
        shardResult.attachedCount += batch.attachedCount;
      }

      if (request.searchDocuments.length > 0) {
        await publishUnifiedSearch(input, request);
      }
      return {
        artifactCount: request.artifacts.length,
        internalShardCount: request.internalShards.length,
        reusedInternalShardCount: request.reusedInternalShards.length,
        searchDocumentCount: request.searchDocuments.length,
        storedObjectCount,
        reusedObjectCount,
        reusedShardDescriptorCount: shardResult.reusedDescriptorCount
      };
    }
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  map: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const output: TOutput[] = [];
  for (const batch of chunks(items, concurrency)) {
    output.push(...await Promise.all(batch.map(map)));
  }
  return output;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    output.push(items.slice(offset, offset + size));
  }
  return output;
}

async function publishUnifiedSearch(
  input: Parameters<typeof createStorageVnextPublicationPublisher>[0],
  request: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    schemaChecksum: string;
    settingsChecksum: string;
    searchBatchOrdinal: number;
    searchDocuments: readonly StorageVnextSearchDocument[];
  }
): Promise<void> {
  const serialized = JSON.stringify(request.searchDocuments);
  const compressedBytes = gzipSync(Buffer.from(serialized, "utf8")).byteLength;
  if (compressedBytes > input.limits.maximumSearchCompressedBytes) {
    throw new Error("Storage vNext publication search byte budget exceeded");
  }
  await input.search.prepareCandidate({
    knowledgeBaseId: request.knowledgeBaseId,
    candidatePublicId: request.candidatePublicId,
    schemaChecksum: request.schemaChecksum,
    settingsChecksum: request.settingsChecksum
  });
  await input.search.writeDocumentBatch({
    candidatePublicId: request.candidatePublicId,
    documents: request.searchDocuments,
    operationPublicId: request.operationPublicId,
    batchOrdinal: request.searchBatchOrdinal,
    payloadChecksum: createHash("sha256").update(serialized).digest("hex"),
    compressedBytes
  });
}

function validateRequest(
  request: {
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
    searchDocuments: readonly StorageVnextSearchDocument[];
  },
  limits: PublicationLimits
): void {
  if (
    !request.knowledgeBaseId
    || !request.candidatePublicId
    || !request.operationPublicId
    || !/^[0-9a-f]{64}$/u.test(request.schemaChecksum)
    || !/^[0-9a-f]{64}$/u.test(request.settingsChecksum)
    || !Number.isSafeInteger(request.searchBatchOrdinal)
    || request.searchBatchOrdinal < 0
    || request.artifacts.length
      + request.internalShards.length
      + request.reusedInternalShards.length > limits.maximumArtifacts
    || request.deletedLogicalPaths.length > limits.maximumArtifacts
    || request.searchDocuments.length > limits.maximumSearchDocuments
  ) throw new Error("Storage vNext publication request is invalid or exceeds its budget");
  const paths = new Set<string>();
  const deletedPaths = new Set(request.deletedLogicalPaths);
  if (
    deletedPaths.size !== request.deletedLogicalPaths.length
    || request.deletedLogicalPaths.some((logicalPath) =>
      !logicalPath || !isAllowedPublicGeneratedFilePath(logicalPath))
  ) throw new Error("Storage vNext publication tombstone is invalid");
  const ordinals = new Set<number>();
  for (const artifact of request.artifacts) {
    if (
      paths.has(artifact.logicalPath)
      || deletedPaths.has(artifact.logicalPath)
      || ordinals.has(artifact.ordinal)
      || artifact.bytes.byteLength > limits.maximumArtifactBytes
      || (artifact.kind === "source") !== (artifact.sourceFilePublicId !== null)
      || !isAllowedPublicGeneratedFilePath(artifact.logicalPath)
    ) throw new Error("Storage vNext publication artifact is invalid");
    paths.add(artifact.logicalPath);
    ordinals.add(artifact.ordinal);
  }
  const shardIds = new Set<string>();
  const shardSlots = new Set<string>();
  for (const shard of [...request.internalShards, ...request.reusedInternalShards]) {
    const slot = shard.logicalKind === "directory_navigation"
      ? `${shard.logicalKind}\u0000${shard.firstLogicalPath}\u0000${shard.ordinal}`
      : `${shard.logicalKind}\u0000${shard.ordinal}`;
    if (
      !shard.publicId
      || !shard.logicalKind
      || !shard.firstLogicalPath
      || !shard.lastLogicalPath
      || shard.firstLogicalPath > shard.lastLogicalPath
      || !Number.isSafeInteger(shard.recordCount)
      || shard.recordCount < 0
      || !Number.isSafeInteger(shard.ordinal)
      || shard.ordinal < 0
      || shardIds.has(shard.publicId)
      || shardSlots.has(slot)
    ) throw new Error("Storage vNext publication shard is invalid");
    shardIds.add(shard.publicId);
    shardSlots.add(slot);
  }
  if (request.internalShards.some((shard) =>
    shard.bytes.byteLength > limits.maximumArtifactBytes)) {
    throw new Error("Storage vNext publication shard exceeds its byte budget");
  }
  if (request.reusedInternalShards.some((shard) =>
    !shard.objectId
    || !/^[0-9a-f]{64}$/u.test(shard.checksum)
    || !Number.isSafeInteger(shard.byteCount)
    || shard.byteCount < 1)) {
    throw new Error("Storage vNext reused publication shard is invalid");
  }
  if (request.searchDocuments.some((document) =>
    document.knowledgeBaseId !== request.knowledgeBaseId)) {
    throw new Error("Storage vNext publication search document is outside the knowledge base");
  }
}

function validateLimits(limits: PublicationLimits): void {
  if (Object.values(limits).some((value) =>
    !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Storage vNext publication limits are invalid");
  }
}

function writeAttempt(
  request: { candidatePublicId: string; operationPublicId: string },
  resource: string,
  bytes: Uint8Array
): string {
  const digest = createHash("sha256")
    .update(request.candidatePublicId)
    .update("\0")
    .update(request.operationPublicId)
    .update("\0")
    .update(resource)
    .update("\0")
    .update(bytes)
    .digest("hex");
  return `publication-write-${digest}`;
}
