import { renderDocumentRootPage } from
  "../application/document-generated-navigation.js";
import { buildDocumentIndexCatalogPage } from
  "../application/document-page-term-projection.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";

export type DocumentRootProjectionLimits = {
  rootSummaryLimit: number;
  okfLogMaxEntries: number;
  okfLogMaxBytes: number;
};

export async function projectRoot(input: {
  dependencies: {
    machineProjection: ReturnType<
      typeof createPostgresDocumentMachineProjectionReader>;
    rootLimits?: DocumentRootProjectionLimits;
  };
  knowledgeBaseId: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  changedAt: string;
}) {
  const limits = input.dependencies.rootLimits;
  if (!limits) throw rootProjectionError(
    "projection_scope_root_configuration_invalid");
  const state = await input.dependencies.machineProjection.readRootProjectionState({
    knowledgeBaseId: input.knowledgeBaseId,
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds,
    logLimit: limits.okfLogMaxEntries
  });
  const currentLogEntry = state.currentLogEntries[0];
  return {
    pages: [
      buildDocumentIndexCatalogPage(),
      ...(["index.md", "log.md"] as const)
        .map((path) => renderDocumentRootPage({
          path,
          knowledgeBase: {
            ...state.knowledgeBase,
            sourceFileCount: state.sourceFileCount,
            graphEdgeCount: state.graphEdgeCount,
            changedAt: input.changedAt
          },
          rootEntryCount: state.rootEntryCount,
          limits,
          logEntries: [
            ...state.currentLogEntries.slice(1),
            ...state.previousLogEntries
          ],
          ...(currentLogEntry ? { currentLogEntry } : {})
        }))
    ],
    removedLogicalPaths: [] as string[],
    records: [] as Record<string, unknown>[],
    graphEdgeCount: state.graphEdgeCount,
    factCount: state.sourceFileCount
  };
}

function rootProjectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection root error: ${code}`), { code });
}
