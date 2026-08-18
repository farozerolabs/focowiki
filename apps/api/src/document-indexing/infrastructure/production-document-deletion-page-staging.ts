import { createDocumentGeneratedPageStaging } from
  "../application/document-generated-page-staging.js";
import {
  collectDocumentGeneratedLinkPaths,
  validateDocumentGeneratedLinks,
  validateDocumentProgressiveNavigation
} from "../application/document-generated-link-validation.js";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";
import {
  collectDocumentPortableReferencedPagePaths,
  validateDocumentPortableCandidate
} from "../application/document-portable-candidate-validation.js";
import type { createDocumentResourcePermits } from
  "../application/document-resource-permits.js";
import type { createStorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import type { createPostgresGeneratedPageRepository } from
  "./postgres-generated-page-repository.js";
import type { createPostgresOperationGeneratedPageRepository } from
  "./postgres-operation-generated-page-repository.js";
import type { createProductionDocumentDeletionPages } from
  "./production-document-deletion-pages.js";
import type { createProductionDocumentDeletionScopePages } from
  "./production-document-deletion-scope-pages.js";
import {
  generatedPageWriteAttempt,
  normalizeLogicalPath,
  ownerIdentity
} from "./production-document-processor-support.js";

type DeletionPages = Awaited<ReturnType<ReturnType<
  typeof createProductionDocumentDeletionPages
>>>;
type ScopePages = Awaited<ReturnType<ReturnType<
  typeof createProductionDocumentDeletionScopePages
>>>;

export function createProductionDocumentDeletionPageStaging(input: {
  pages: ReturnType<typeof createPostgresGeneratedPageRepository>;
  operationPages: ReturnType<
    typeof createPostgresOperationGeneratedPageRepository
  >;
  ownership: ReturnType<typeof createPostgresStorageVnextOwnershipRepository>;
  objectWriter: ReturnType<typeof createStorageVnextImmutableObjectWriter>;
  permits: ReturnType<typeof createDocumentResourcePermits>;
  writeConcurrency: number;
}) {
  return async (request: {
    action: DocumentResourceDeletionAction;
    deletionPages: DeletionPages;
    scopePages: ScopePages;
    baseRevision: number;
    completedAt: string;
    signal: AbortSignal;
  }) => {
    const desiredPages = [
      ...request.deletionPages.renderedPages,
      ...request.deletionPages.navigationPages,
      ...request.scopePages.pages
    ];
    const affectedNormalizedPaths = [...new Set([
      ...desiredPages.map((page) => page.normalizedPath),
      ...request.deletionPages.projection.deletedSources.map((source) =>
        normalizeLogicalPath(`pages/${source.logicalPath}`)),
      ...request.deletionPages.removedNavigationPaths.map(normalizeLogicalPath),
      ...request.scopePages.removedLogicalPaths.map(normalizeLogicalPath)
    ])].sort();
    const current = await input.pages.readHeads({
      knowledgeBaseId: request.action.knowledgeBaseId,
      normalizedPaths: affectedNormalizedPaths,
      limit: Math.max(1, affectedNormalizedPaths.length)
    });
    const desiredPaths = new Set(desiredPages.map((page) => page.normalizedPath));
    const removed = new Set(affectedNormalizedPaths.filter((path) =>
      !desiredPaths.has(path)));
    const validationPages = desiredPages.map((page) => ({
      logicalPath: page.logicalPath,
      bytes: page.bytes,
      allowUnresolved: page.entryKind === "source",
      contentType: page.normalizedPath.endsWith(".json")
        ? "application/json; charset=utf-8"
        : "text/markdown; charset=utf-8"
    }));
    const linkedPaths = [...new Set([
      ...collectDocumentGeneratedLinkPaths(validationPages),
      ...collectDocumentPortableReferencedPagePaths(desiredPages)
    ])];
    const linkedHeads = await input.pages.readHeads({
      knowledgeBaseId: request.action.knowledgeBaseId,
      normalizedPaths: linkedPaths,
      limit: Math.max(1, linkedPaths.length)
    });
    const activeLogicalPaths = linkedHeads.filter((head) =>
      !removed.has(head.normalizedPath)).map((head) => head.logicalPath);
    validateDocumentGeneratedLinks({
      pages: validationPages,
      activeLogicalPaths
    });
    validateDocumentProgressiveNavigation({
      pages: validationPages,
      activeLogicalPaths
    });
    validateDocumentPortableCandidate({
      pages: desiredPages,
      activeReadablePagePaths: activeLogicalPaths
    });
    const staged = await createDocumentGeneratedPageStaging({
      writeConcurrency: input.writeConcurrency,
      write: async (page) => {
        const stored = await input.permits.run("generated_object_write", () =>
          input.objectWriter.putVerified({
            bytes: page.bytes,
            objectFormat: page.normalizedPath.endsWith(".json")
              ? "okf-generated-json-v1" : "okf-generated-markdown-v1",
            writeAttemptPublicId: generatedPageWriteAttempt(
              request.action.publicId,
              "deletion-page",
              request.baseRevision,
              page.normalizedPath,
              page.checksumSha256
            ),
            createdAt: request.completedAt,
            signal: request.signal
          }), { signal: request.signal });
        return {
          objectId: stored.objectId,
          checksumSha256: stored.checksum,
          byteCount: stored.byteCount
        };
      },
      stage: (pages) => input.operationPages.stage({
        knowledgeBaseId: request.action.knowledgeBaseId,
        operationPublicId: request.action.operationPublicId,
        baseActivationRevision: request.baseRevision,
        pages,
        stagedAt: request.completedAt
      }),
      attach: (page) => input.ownership.attach({
        publicId: ownerIdentity(page.pageCandidatePublicId, page.objectId),
        knowledgeBaseId: request.action.knowledgeBaseId,
        objectId: page.objectId,
        kind: "generated_page_candidate",
        ownerPublicId: page.pageCandidatePublicId,
        createdAt: request.completedAt
      })
    })({
      desired: desiredPages,
      current,
      affectedNormalizedPaths,
      signal: request.signal
    });
    return {
      pageCandidates: staged.pageCandidates,
      removedPageNormalizedPaths: staged.removedNormalizedPaths,
      removedDirectoryPrefixes:
        request.deletionPages.removedDirectoryPrefixes,
      navigationMutations: [
        ...request.deletionPages.navigationMutations,
        ...request.scopePages.navigationMutations
      ]
    };
  };
}
