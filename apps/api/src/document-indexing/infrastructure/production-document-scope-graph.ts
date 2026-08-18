import {
  buildDocumentGraphCatalogPage,
  buildDocumentGraphDirectoryScopeResources,
  buildDocumentPerFileGraphScopeResource
} from "../application/document-graph-projection.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";

type Dependencies = {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
};

type Visibility = {
  knowledgeBaseId: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
};

export async function projectGraphCatalog(input: {
  dependencies: Dependencies;
} & Visibility) {
  const state = await input.dependencies.machineProjection.readGraphCatalogState({
    knowledgeBaseId: input.knowledgeBaseId,
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
  const state = await input.dependencies.machineProjection.readGraphDirectoryState({
    knowledgeBaseId: input.knowledgeBaseId,
    scopePath: input.scopePath,
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
  });
  return {
    ...buildDocumentGraphDirectoryScopeResources({
      scopePath: input.scopePath,
      records: state.records,
      childDirectories: state.childDirectories,
      previousPaths: state.resourcePaths,
      maximumRecordsPerShard: input.dependencies.maximumRecordsPerShard,
      maximumShardBytes: input.dependencies.maximumShardBytes
    }),
    records: state.records,
    childDirectories: state.childDirectories
  };
}

export async function projectPerFileGraphDirectory(input: {
  dependencies: Dependencies;
  scopePath: string;
} & Visibility) {
  const state = await input.dependencies.machineProjection
    .readPerFileGraphDirectoryState({
      knowledgeBaseId: input.knowledgeBaseId,
      scopePath: input.scopePath,
      includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
      excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
    });
  return {
    pages: [],
    removedLogicalPaths: [] as string[],
    records: state.records,
    childDirectories: state.childDirectories
  };
}
