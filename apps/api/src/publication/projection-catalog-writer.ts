import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type {
  EffectiveProjectionShard,
  ProjectionCatalogRepository
} from "../application/ports/projection-catalog-repository.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";

const CATALOG_PATH = "_index/catalog.json";
const CATALOG_PROJECTIONS = {
  search: "search",
  links: "links",
  manifest: "manifest",
  tree: "tree",
  graphNodes: "graph_node",
  graphEdges: "graph_edge"
} as const;

export function createProjectionCatalogWriter(input: {
  catalog: ProjectionCatalogRepository;
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  maxShardDescriptors: number;
}) {
  assertPositiveInteger(input.maxShardDescriptors, "maxShardDescriptors");
  return {
    async finalize(context: { knowledgeBaseId: string; generationId: string }): Promise<void> {
      const shards = await input.catalog.listEffectiveShards(context);
      if (shards.length > input.maxShardDescriptors) {
        throw new Error("Projection catalog exceeds the configured shard descriptor budget");
      }
      const object = await input.immutableObjects.write({
        body: renderProjectionCatalog({ ...context, shards }),
        contentType: "application/json; charset=utf-8"
      });
      await input.references.stageUpsert({
        ...context,
        refKind: "root",
        refKey: CATALOG_PATH,
        fileId: createGeneratedFileId({
          refKind: "root",
          refKey: CATALOG_PATH,
          sourceFileId: null
        }),
        checksumSha256: object.checksumSha256,
        formatVersion: object.formatVersion,
        logicalPath: CATALOG_PATH,
        sourceFileId: null,
        projectionShardId: null
      });
    }
  };
}

export function renderProjectionCatalog(input: {
  knowledgeBaseId: string;
  generationId: string;
  shards: EffectiveProjectionShard[];
}): string {
  const projections = Object.fromEntries(
    Object.entries(CATALOG_PROJECTIONS).map(([publicName, projectionKind]) => [
      publicName,
      {
        shards: input.shards
          .filter((shard) => shard.projectionKind === projectionKind)
          .map((shard) => ({ path: shard.logicalPath, recordCount: shard.recordCount }))
      }
    ])
  );
  return `${JSON.stringify({
    formatVersion: 1,
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    projections: {
      ...projections,
      relatedFiles: { pathTemplate: "_graph/by-file/{fileId}.json" }
    }
  })}\n`;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
