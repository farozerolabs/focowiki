import { S3Client } from "@aws-sdk/client-s3";
import type { RuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { createNodeJiebaTokenizer } from
  "../../infrastructure/tokenization/nodejieba-tokenizer.js";
import type { createRuntimeSearchProvider } from
  "../../runtime/search-provider.js";
import { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import { loadDeploymentSecret } from "../../security/runtime-secrets.js";
import { createEmbeddingArtifactService } from
  "../../semantic/embedding/artifact-service.js";
import { createEmbeddingGateway } from "../../semantic/embedding/gateway.js";
import { createOpenAiCompatibleEmbeddingTransport } from
  "../../semantic/embedding/openai-compatible-transport.js";
import { createGraphRagRuntime } from
  "../../semantic/graphrag/graph-rag-runtime.js";
import { createPostgresEmbeddingArtifactRepository } from
  "../../semantic/infrastructure/postgres-embedding-artifact-repository.js";
import { createPostgresEmbeddingConfigurationRepository } from
  "../../semantic/infrastructure/postgres-embedding-configuration-repository.js";
import { createS3EmbeddingArtifactStore } from
  "../../semantic/infrastructure/s3-embedding-artifact-store.js";
import { createS3ClientConfig } from "../../storage/s3.js";
import { createS3StorageVnextSourceBodyStore } from
  "../../storage-vnext/catalog/s3-source-body-store.js";
import {
  createS3StorageVnextFailedWriteProvider,
  createStorageVnextFailedWriteCompensator
} from "../../storage-vnext/ownership/failed-write-compensation.js";
import { createStorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import { createS3StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { DocumentResourceCapacityInput } from
  "../application/document-resource-capacity.js";
import { resolveDocumentResourceLaneCapacities } from
  "../application/document-resource-capacity.js";
import { createDocumentResourceLanes } from
  "../application/document-resource-lanes.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import { processorError } from "./production-document-processor-support.js";

export function createProductionDocumentFixedResources(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  resourceCapacity: DocumentResourceCapacityInput;
  tokenizer: ReturnType<typeof createNodeJiebaTokenizer>;
  searchProvider: ReturnType<typeof createRuntimeSearchProvider>;
  observability?: Pick<DocumentWorkerObservability, "providerFailure">;
}) {
  const s3 = new S3Client(createS3ClientConfig(input.config.storage));
  const ownership = createPostgresStorageVnextOwnershipRepository(input.sql);
  const bodies = createS3StorageVnextImmutableBodyStore({
    client: s3,
    bucket: input.config.storage.bucket,
    prefix: input.config.storage.prefix
  });
  const writer = createStorageVnextImmutableObjectWriter({
    registrations: ownership,
    bodyStore: bodies,
    compensation: createStorageVnextFailedWriteCompensator({
      registrations: ownership,
      provider: createS3StorageVnextFailedWriteProvider({
        client: s3,
        bucket: input.config.storage.bucket,
        prefix: input.config.storage.prefix
      })
    }),
    clock: () => new Date().toISOString()
  });
  const lanes = createDocumentResourceLanes({
    capacities: resolveDocumentResourceLaneCapacities(input.resourceCapacity),
    maximumWaitersPerLane: input.resourceCapacity.documentConcurrency * 8
  });
  if (!input.config.search) {
    throw processorError("search_configuration_missing");
  }
  const embeddingConfigurations =
    createPostgresEmbeddingConfigurationRepository(input.sql);
  const deploymentSecret = loadDeploymentSecret();
  const onProviderFailure = input.observability?.providerFailure
    ?? (() => undefined);
  const embeddingGateway = createEmbeddingGateway({
    transport: createOpenAiCompatibleEmbeddingTransport({
      onFailure: onProviderFailure
    }),
    deploymentSecret
  });
  const embeddingArtifacts = createEmbeddingArtifactService({
    gateway: embeddingGateway,
    repository: createPostgresEmbeddingArtifactRepository(input.sql),
    store: createS3EmbeddingArtifactStore({
      client: s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    })
  });
  return {
    s3,
    ownership,
    bodies,
    writer,
    sourceBodies: createS3StorageVnextSourceBodyStore({
      client: s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    }),
    lanes,
    tokenizer: input.tokenizer,
    searchProvider: input.searchProvider,
    embeddingConfigurations,
    embeddingGateway,
    embeddingArtifacts,
    runtimeSettings: createRuntimeSettingsRepository(input.sql),
    graphRag: createGraphRagRuntime({
      poolSize: input.resourceCapacity.graphRagConcurrency
    }),
    deploymentSecret,
    onProviderFailure,
    machineProjection: createPostgresDocumentMachineProjectionReader(input.sql)
  };
}
