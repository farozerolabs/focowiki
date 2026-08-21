import { boundedConcurrentMap } from
  "../application/bounded-concurrent-map.js";
import { renderAffectedDocumentSourcePages } from
  "../application/document-affected-source-pages.js";
import { planDocumentDirectoryNavigationChanges } from
  "../application/document-directory-navigation-change-plan.js";
import { reconcileDocumentDirectoryNavigation } from
  "../application/document-directory-navigation-state.js";
import {
  renderDocumentDirectoryMutationPages
} from "../application/document-generated-navigation.js";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";
import type { resolvePinnedDocumentOutputSettings } from
  "../application/document-output-settings.js";
import type { createDocumentResourcePermits } from
  "../application/document-resource-permits.js";
import { analyzeDocumentSourceMarkdown } from
  "../domain/document-source-metadata.js";
import { directoryLeafPath } from
  "../application/document-directory-navigation-renderer.js";
import type { createS3StorageVnextSourceBodyStore } from
  "../../storage-vnext/catalog/s3-source-body-store.js";
import type { createPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import type { createPostgresDocumentGeneratedContext } from
  "./postgres-document-generated-context.js";
import type { createPostgresDocumentDeletionProjectionContext } from
  "./postgres-document-deletion-projection-context.js";
import {
  createDirectoryLeafId,
  readGeneratedSourceBody
} from "./production-document-processor-support.js";

type OutputSettings = ReturnType<typeof resolvePinnedDocumentOutputSettings>;

export function createProductionDocumentDeletionPages(input: {
  context: ReturnType<typeof createPostgresDocumentDeletionProjectionContext>;
  generatedContext: ReturnType<typeof createPostgresDocumentGeneratedContext>;
  directoryNavigation: ReturnType<
    typeof createPostgresDocumentDirectoryNavigation
  >;
  bodyStore: ReturnType<typeof createS3StorageVnextSourceBodyStore>;
  permits: ReturnType<typeof createDocumentResourcePermits>;
  documentConcurrency: number;
  maximumSourceBytes: number;
}) {
  return async (request: {
    action: DocumentResourceDeletionAction;
    outputSettings: OutputSettings;
    baseRevision: number;
    completedAt: string;
    signal: AbortSignal;
  }) => {
    const projection = await input.context.read({
      action: request.action,
      maximumSources: 10_000,
      maximumRelations: 10_000
    });
    const affectedIds = projection.affectedSurvivorSourceFilePublicIds;
    const relations = await input.context.readActiveRelations({
      knowledgeBaseId: request.action.knowledgeBaseId,
      affectedSourceFilePublicIds: affectedIds,
      limit: 10_000
    });
    const contextIds = [...new Set([
      ...affectedIds,
      ...relations.flatMap((relation) => [
        relation.firstSourceFilePublicId,
        relation.secondSourceFilePublicId
      ])
    ])].sort();
    const activeSources = await input.generatedContext.readActiveSources({
      knowledgeBaseId: request.action.knowledgeBaseId,
      sourceFilePublicIds: contextIds,
      limit: 10_000
    });
    const generatedSources = await boundedConcurrentMap({
      values: activeSources,
      concurrency: input.documentConcurrency,
      signal: request.signal,
      async map(source) {
        const content = await input.permits.run("s3_read", () =>
          readGeneratedSourceBody(
            input.bodyStore,
            source,
            input.maximumSourceBytes,
            request.signal
          ), { signal: request.signal });
        const analyzed = analyzeDocumentSourceMarkdown({
          fileName: source.logicalPath.split("/").at(-1)!,
          content
        });
        return {
          sourceFilePublicId: source.sourceFilePublicId,
          sourceRevisionPublicId: source.sourceRevisionPublicId,
          resourceRevision: source.resourceRevision,
          logicalPath: source.logicalPath,
          title: analyzed.resolvedMetadata.title,
          body: analyzed.body,
          metadata: analyzed.resolvedMetadata,
          sourceMetadata: analyzed.parsedMetadata,
          modelSuggestions: source.modelSuggestions,
          checksumSha256: source.checksumSha256,
          byteCount: source.byteCount,
          contentType: source.contentType,
          semanticEntities: source.semanticEntities
        };
      }
    });
    const available = new Set(generatedSources.map((source) =>
      source.sourceFilePublicId));
    const renderedPages = renderAffectedDocumentSourcePages({
      sources: generatedSources,
      renderSourceFilePublicIds: affectedIds.filter((sourceFilePublicId) =>
        available.has(sourceFilePublicId)),
      relations
    }).map((page) => {
      const source = generatedSources.find((item) =>
        item.sourceFilePublicId === page.sourceFilePublicId)!;
      return { ...page, sourceRevisionPublicId: source.sourceRevisionPublicId };
    });
    const navigation = await buildDeletionNavigation({
      input,
      request,
      deletedSources: projection.deletedSources,
      deletedDirectoryPaths: projection.deletedDirectoryPaths
    });
    return {
      projection,
      generatedSources,
      renderedPages,
      postActivationRelations: relations,
      activeRelationPublicIds: projection.obsoleteRelationPublicIds,
      navigationPages: navigation.pages,
      navigationMutations: navigation.mutations,
      removedNavigationPaths: navigation.removedPaths,
      removedDirectoryPrefixes: deletedRootPrefix(
        projection.deletedDirectoryPaths
      )
    };
  };
}

async function buildDeletionNavigation(input: {
  input: Parameters<typeof createProductionDocumentDeletionPages>[0];
  request: Parameters<ReturnType<typeof createProductionDocumentDeletionPages>>[0];
  deletedSources: readonly { sourceFilePublicId: string; logicalPath: string }[];
  deletedDirectoryPaths: readonly string[];
}) {
  const byDirectory = new Map<string, Array<{
    entryId: string;
    desiredEntry: null;
  }>>();
  const deletedDirectories = [...input.deletedDirectoryPaths]
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const deletedRoot = deletedDirectories[0] ?? null;
  if (deletedRoot) {
    const segments = deletedRoot.split("/");
    const parent = segments.slice(0, -1).join("/");
    byDirectory.set(parent ? `pages/${parent}` : "pages", [{
      entryId: `directory:${deletedRoot}`,
      desiredEntry: null
    }]);
  }
  for (const source of input.deletedSources) {
    if (deletedDirectories.some((directory) =>
      source.logicalPath.startsWith(`${directory}/`))) continue;
    for (const plan of planDocumentDirectoryNavigationChanges({
      sourceFilePublicId: source.sourceFilePublicId,
      oldLogicalPath: source.logicalPath,
      newLogicalPath: null
    })) {
      const changes = byDirectory.get(plan.directoryPath) ?? [];
      changes.push(...plan.changes as Array<{ entryId: string; desiredEntry: null }>);
      byDirectory.set(plan.directoryPath, changes);
    }
  }
  const mutations = [];
  const pages = [];
  const removedPaths: string[] = [];
  let rootEntryCount: number | null = null;
  for (const [directoryPath, allChanges] of [...byDirectory].sort()) {
    const previous = await input.input.directoryNavigation.read({
      knowledgeBaseId: input.request.action.knowledgeBaseId,
      directoryPath,
      maximumLeaves: 10_000,
      maximumEntries: 100_000
    });
    let state = previous;
    let sequence = 0;
    const occupiedLeafIds = new Set(previous.map((leaf) => leaf.id));
    for (let offset = 0; offset < allChanges.length; offset += 64) {
      state = reconcileDocumentDirectoryNavigation({
        previous: state,
        changes: allChanges.slice(offset, offset + 64),
        limits: input.request.outputSettings.directoryLeafLimits,
        changedAt: input.request.completedAt,
        createLeafId: () => createDirectoryLeafId({
          prefix: "directory-leaf",
          knowledgeBaseId: input.request.action.knowledgeBaseId,
          directoryPath,
          occupiedLeafIds,
          sequence: ++sequence
        })
      }).leaves;
    }
    const finalIds = new Set(state.map((leaf) => leaf.id));
    const removedLeafIds = previous.filter((leaf) => !finalIds.has(leaf.id))
      .map((leaf) => leaf.id);
    const touchedLeaves = state.filter((leaf) => {
      const before = previous.find((item) => item.id === leaf.id);
      return !before || JSON.stringify(before) !== JSON.stringify(leaf);
    });
    if (directoryPath === "pages") {
      rootEntryCount = state.reduce((total, leaf) => total + leaf.entries.length, 0);
    }
    mutations.push({ directoryPath, touchedLeaves, removedLeafIds });
    pages.push(...renderDocumentDirectoryMutationPages({
      directoryPath,
      entryCount: state.reduce((total, leaf) => total + leaf.entries.length, 0),
      firstLeafId: state[0]?.id ?? null,
      touchedLeaves
    }));
    removedPaths.push(...removedLeafIds.map((leafId) =>
      directoryLeafPath(directoryPath, leafId)));
  }
  if (rootEntryCount === null) {
    const root = await input.input.directoryNavigation.read({
      knowledgeBaseId: input.request.action.knowledgeBaseId,
      directoryPath: "pages",
      maximumLeaves: 10_000,
      maximumEntries: 100_000
    });
    rootEntryCount = root.reduce((total, leaf) => total + leaf.entries.length, 0);
  }
  return { mutations, pages, removedPaths, rootEntryCount };
}

function deletedRootPrefix(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) return [];
  const root = [...paths].sort((left, right) =>
    left.length - right.length || left.localeCompare(right))[0]!;
  return [`pages/${root}`];
}
