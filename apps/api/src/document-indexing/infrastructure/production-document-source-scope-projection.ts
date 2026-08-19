import { boundedConcurrentMap } from
  "../application/bounded-concurrent-map.js";
import {
  documentSourcePathRewrites,
  renderAffectedDocumentSourcePages
} from
  "../application/document-affected-source-pages.js";
import type { createDocumentPageBaseLoader } from
  "./document-page-base-loader.js";
import type { createPostgresCandidateFileRelationRepository } from
  "./postgres-candidate-file-relation-repository.js";
import type { createPostgresGeneratedPageBaseRepository } from
  "./postgres-generated-page-base-repository.js";
import type { DocumentSourceScopeProjection } from
  "./production-document-scope-renderer.js";

const MAXIMUM_SOURCE_SCOPE_RECORDS = 10_000;

export function createProductionDocumentSourceScopeProjection(input: {
  bases: ReturnType<typeof createPostgresGeneratedPageBaseRepository>;
  relations: ReturnType<typeof createPostgresCandidateFileRelationRepository>;
  loadBase: ReturnType<typeof createDocumentPageBaseLoader>;
  readConcurrency: number;
}): DocumentSourceScopeProjection {
  if (!Number.isSafeInteger(input.readConcurrency)
    || input.readConcurrency < 1 || input.readConcurrency > 1_000) {
    throw sourceProjectionError("source_scope_read_concurrency_invalid");
  }
  return {
    async project(request) {
      const [sourceBase] = await input.bases.listVisibleForSources({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: [request.sourceFilePublicId],
        includedSourceRevisionPublicIds:
          request.includedSourceRevisionPublicIds,
        excludedActiveSourceFilePublicIds:
          request.excludedActiveSourceFilePublicIds,
        preferredCurrentSourceFilePublicIds: [request.sourceFilePublicId],
        limit: 1
      });
      if (!sourceBase) {
        return { pages: [], removedLogicalPaths: [], factCount: 0 };
      }
      const selectedSourceRevisionPublicIds = [...new Set([
        ...request.includedSourceRevisionPublicIds,
        sourceBase.sourceRevisionPublicId
      ])];
      const relations = await input.relations.listVisibleForSource({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFilePublicId,
        includedSourceRevisionPublicIds: selectedSourceRevisionPublicIds,
        excludedActiveSourceFilePublicIds:
          request.excludedActiveSourceFilePublicIds,
        limit: MAXIMUM_SOURCE_SCOPE_RECORDS
      });
      const sourceFilePublicIds = [...new Set([
        request.sourceFilePublicId,
        ...relations.flatMap((relation) => [
          relation.firstSourceFilePublicId,
          relation.secondSourceFilePublicId
        ])
      ])].sort((left, right) => left.localeCompare(right, "en-US"));
      const bases = await input.bases.listVisibleForSources({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds,
        includedSourceRevisionPublicIds: selectedSourceRevisionPublicIds,
        excludedActiveSourceFilePublicIds:
          request.excludedActiveSourceFilePublicIds,
        limit: MAXIMUM_SOURCE_SCOPE_RECORDS
      });
      const baseBySource = new Map(bases.map((base) => [
        base.sourceFilePublicId,
        base
      ]));
      if (!baseBySource.has(request.sourceFilePublicId)) {
        throw sourceProjectionError("source_scope_base_missing");
      }
      const renderableRelations = relations.filter((relation) =>
        baseBySource.has(relation.firstSourceFilePublicId)
        && baseBySource.has(relation.secondSourceFilePublicId));
      const renderableSourceFilePublicIds = [...new Set([
        request.sourceFilePublicId,
        ...renderableRelations.flatMap((relation) => [
          relation.firstSourceFilePublicId,
          relation.secondSourceFilePublicId
        ])
      ])].sort((left, right) => left.localeCompare(right, "en-US"));
      const sources = await boundedConcurrentMap({
        values: renderableSourceFilePublicIds,
        concurrency: input.readConcurrency,
        signal: request.signal,
        map: (sourceFilePublicId) => input.loadBase({
          base: baseBySource.get(sourceFilePublicId)!,
          signal: request.signal
        })
      });
      const sourcePathRewrites = documentSourcePathRewrites(sources);
      const page = renderAffectedDocumentSourcePages({
        sources,
        renderSourceFilePublicIds: [request.sourceFilePublicId],
        relations: renderableRelations,
        sourcePathRewrites
      })[0];
      const source = sources.find((candidate) =>
        candidate.sourceFilePublicId === request.sourceFilePublicId);
      if (!page || !source) {
        throw sourceProjectionError("source_scope_page_missing");
      }
      return {
        pages: [{ ...page, sourceRevisionPublicId: source.sourceRevisionPublicId }],
        removedLogicalPaths: source.sourceLinkBaseLogicalPath
          && source.sourceLinkBaseLogicalPath !== source.logicalPath
          ? [`pages/${source.sourceLinkBaseLogicalPath}`]
          : [],
        factCount: 1 + renderableRelations.length
      };
    }
  };
}

function sourceProjectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document source projection error: ${code}`), {
    code
  });
}
