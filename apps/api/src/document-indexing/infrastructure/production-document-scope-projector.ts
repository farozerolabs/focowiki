import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import { createDocumentScopeProjectorRuntime } from
  "../application/document-scope-projector-runtime.js";
import { isRetryable, safeErrorCode } from
  "./production-document-error-diagnostic.js";
import type { createProductionDocumentFixedRepositories } from
  "./production-document-fixed-components.js";
import { waitForDocumentWork } from
  "./production-document-fixed-runtime-support.js";
import { captureDocumentProjectionOutputOwnerVersions } from
  "./document-projection-output-owner-snapshot.js";
import { createPostgresProjectionScopeCompletion } from
  "./postgres-projection-scope-completion.js";
import type { createPostgresProjectionScopeOutputRepository } from
  "./postgres-projection-scope-output-repository.js";
import type { createProductionDocumentScopeRenderer } from
  "./production-document-scope-renderer.js";
import { reuseDocumentProjectionScopeOutput } from
  "./production-document-projection-scope-output-reuse.js";
import { latestContributors } from
  "./production-document-scope-renderer-support.js";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import { MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER } from
  "../domain/document-projection-limits.js";

type FixedRepositories = ReturnType<
  typeof createProductionDocumentFixedRepositories
>;
type ScopeRendered =
  | ReturnType<typeof reuseDocumentProjectionScopeOutput>
  | (Awaited<ReturnType<ReturnType<
      typeof createProductionDocumentScopeRenderer
    >["render"]>> & { renderStartedAt: string });

export function createProductionDocumentScopeProjector(input: {
  sql: DatabaseClient;
  workerId: string;
  leaseDurationMs: number;
  maximumConcurrency: number;
  retryDelayMs: number;
  repositories: Pick<FixedRepositories,
    | "activationOwners"
    | "dirtyScopes"
    | "pages"
    | "scopeContributions"
    | "work">;
  outputs: ReturnType<typeof createPostgresProjectionScopeOutputRepository>;
  renderer: ReturnType<typeof createProductionDocumentScopeRenderer>;
  ownership: StorageVnextOwnershipRepository;
  onFailure?: (input: {
    scope: DocumentProjectionScopeClaim;
    error: unknown;
    errorCode: string;
    retryable: boolean;
  }) => void;
}) {
  const completion = createPostgresProjectionScopeCompletion(input.sql);
  return createDocumentScopeProjectorRuntime({
    workerId: `${input.workerId}:scope-projector`,
    leaseDurationMs: input.leaseDurationMs,
    maximumConcurrency: input.maximumConcurrency,
    scopes: input.repositories.dirtyScopes,
    commit: completion.commit,
    async render(scope, signal) {
      const persisted = await input.outputs.read({
        scopePublicId: scope.publicId,
        renderedSequence: scope.renderedSequence
      });
      if (persisted) return reuseDocumentProjectionScopeOutput(persisted);
      const renderStartedAt = new Date().toISOString();
      return {
        ...await input.renderer.render(scope, signal),
        renderStartedAt
      };
    },
    async persist(scope, rendered) {
      const stagedAt = new Date().toISOString();
      let persistenceError: unknown;
      try {
        const activationOwnerVersions =
          await captureDocumentProjectionOutputOwnerVersions({
            knowledgeBaseId: scope.knowledgeBaseId,
            renderStartedAt: rendered.renderStartedAt,
            pages: rendered.pages,
            removedNormalizedPaths: rendered.removedNormalizedPaths,
            navigationMutations: rendered.navigationMutations,
            owners: input.repositories.activationOwners
          });
        await input.outputs.persist({
          scopePublicId: scope.publicId,
          renderedSequence: scope.renderedSequence,
          knowledgeBaseId: scope.knowledgeBaseId,
          outputFingerprintSha256: rendered.outputFingerprintSha256,
          pages: rendered.pages,
          removedNormalizedPaths: rendered.removedNormalizedPaths,
          navigationMutations: rendered.navigationMutations,
          activationOwnerVersions,
          createdAt: stagedAt
        });
        await stageContributorPages(input, scope, rendered, stagedAt);
      } catch (error) {
        persistenceError = error;
      }
      await releaseReservations(input, rendered, persistenceError);
    },
    finalize: (request) => input.repositories.work
      .completeReadyWaitingProjections({
        ...request,
        detectFailures: request.documentJobPublicIds === undefined
      }),
    now: () => new Date().toISOString(),
    wait: waitForDocumentWork,
    classifyError(error) {
      const code = safeErrorCode(error);
      return { code, retryable: isRetryable(code) };
    },
    ...(input.onFailure ? { onFailure: input.onFailure } : {}),
    retryDelayMs: (attempt) => input.retryDelayMs * attempt
  });
}

async function stageContributorPages(
  input: Parameters<typeof createProductionDocumentScopeProjector>[0],
  scope: Parameters<ReturnType<typeof createProductionDocumentScopeRenderer>["render"]>[0],
  rendered: ScopeRendered,
  stagedAt: string
): Promise<void> {
  if (rendered.pages.length === 0) return;
  const contributors = latestContributors(
    await input.repositories.scopeContributions.listCovered({
      scopePublicId: scope.publicId,
      renderedSequence: scope.renderedSequence,
      limit: MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER
    })
  );
  await input.repositories.pages.stageForContributors({
    knowledgeBaseId: scope.knowledgeBaseId,
    contributors,
    pages: rendered.pages,
    stagedAt
  });
}

async function releaseReservations(
  input: Parameters<typeof createProductionDocumentScopeProjector>[0],
  rendered: ScopeRendered,
  persistenceError: unknown
): Promise<void> {
  const releases = await Promise.allSettled(
    rendered.verifiedReservations.map((reservation) =>
      input.ownership.releaseVerifiedReservation(reservation))
  );
  const releaseErrors = releases.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (persistenceError !== undefined && releaseErrors.length > 0) {
    throw new AggregateError(
      [persistenceError, ...releaseErrors],
      "Projection persistence and verified reservation release failed"
    );
  }
  if (persistenceError !== undefined) throw persistenceError;
  if (releaseErrors.length > 0) {
    throw new AggregateError(
      releaseErrors,
      "Projection verified reservation release failed"
    );
  }
}
