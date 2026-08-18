import { createHash } from "node:crypto";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";
import { documentDeletionProjectionScopes } from
  "../application/document-deletion-projection-scopes.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import type { createProductionDocumentScopeRenderer } from
  "./production-document-scope-renderer.js";

export function createProductionDocumentDeletionScopePages(input: {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  renderer: ReturnType<typeof createProductionDocumentScopeRenderer>;
}) {
  return async (request: {
    action: DocumentResourceDeletionAction;
    deletedSources: readonly {
      sourceFilePublicId: string;
      logicalPath: string;
    }[];
    affectedSurvivors: readonly {
      sourceFilePublicId: string;
      logicalPath: string;
    }[];
    obsoleteRelationPublicIds: readonly string[];
    baseRevision: number;
    signal: AbortSignal;
  }) => {
    const termBuckets = await input.machineProjection
      .listNavigationTermBucketsForSources({
        knowledgeBaseId: request.action.knowledgeBaseId,
        sourceFilePublicIds: request.deletedSources.map((source) =>
          source.sourceFilePublicId)
      });
    const scopes = documentDeletionProjectionScopes({
      deletedSources: request.deletedSources,
      affectedSurvivors: request.affectedSurvivors,
      obsoleteRelationPublicIds: request.obsoleteRelationPublicIds,
      termBuckets
    });
    const rendered = [];
    for (const scope of scopes) {
      if (request.signal.aborted) {
        throw request.signal.reason ?? deletionScopeError("cancelled");
      }
      rendered.push(await input.renderer.project({
        publicId: scopePublicId(request.action.publicId, scope.kind, scope.key),
        knowledgeBaseId: request.action.knowledgeBaseId,
        kind: scope.kind,
        key: scope.key,
        requiredSequence: request.baseRevision,
        renderedSequence: request.baseRevision
      }));
    }
    const pages = uniquePages(rendered.flatMap((item) => item.pages));
    const desiredPaths = new Set(pages.map((page) => page.normalizedPath));
    return {
      pages,
      removedLogicalPaths: [...new Set(rendered.flatMap((item) =>
        item.removedLogicalPaths))].filter((path) =>
        !desiredPaths.has(path.toLocaleLowerCase("en-US"))).sort(),
      navigationMutations: rendered.flatMap((item) =>
        item.navigationMutations)
    };
  };
}

function uniquePages<T extends {
  normalizedPath: string;
  checksumSha256: string;
}>(pages: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const page of pages) {
    const existing = result.get(page.normalizedPath);
    if (existing && existing.checksumSha256 !== page.checksumSha256) {
      throw deletionScopeError("deletion_scope_page_conflict");
    }
    result.set(page.normalizedPath, page);
  }
  return [...result.values()].sort((left, right) =>
    left.normalizedPath.localeCompare(right.normalizedPath, "en-US"));
}

function scopePublicId(
  actionPublicId: string,
  kind: string,
  key: string
): string {
  return `deletion-projection-${createHash("sha256")
    .update(JSON.stringify([actionPublicId, kind, key])).digest("hex")}`;
}

function deletionScopeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document deletion scope error: ${code}`), {
    code
  });
}
