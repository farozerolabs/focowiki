import type { createPostgresScopedActivationOwnerRepository } from
  "./postgres-scoped-activation-owner-repository.js";
import { documentProjectionOutputOwnerRequests } from
  "./document-knowledge-projection-support.js";

export async function captureDocumentProjectionOutputOwnerVersions(input: {
  knowledgeBaseId: string;
  renderStartedAt: string;
  pages: readonly { normalizedPath: string }[];
  removedNormalizedPaths: readonly string[];
  navigationMutations: readonly {
    directoryPath: string;
    touchedLeaves: readonly {
      id: string;
      entries: readonly { id: string }[];
    }[];
    removedLeafIds: readonly string[];
  }[];
  owners: ReturnType<typeof createPostgresScopedActivationOwnerRepository>;
}) {
  const requests = documentProjectionOutputOwnerRequests({
    pages: input.pages,
    removedPaths: input.removedNormalizedPaths,
    navigationMutations: input.navigationMutations
  });
  const versions = requests.length === 0 ? []
    : await input.owners.readVersions({
        knowledgeBaseId: input.knowledgeBaseId,
        owners: requests
      });
  if (versions.some((owner) => owner.updatedAt
    && owner.updatedAt > input.renderStartedAt)) {
    throw snapshotError("projection_scope_changed_during_render");
  }
  const byIdentity = new Map(versions.map((owner) => [
    `${owner.kind}\0${owner.key}`,
    owner.version
  ]));
  return requests.map((owner) => ({
    kind: owner.kind,
    key: owner.key,
    expectedVersion: byIdentity.get(`${owner.kind}\0${owner.key}`) ?? 0
  }));
}

function snapshotError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection owner snapshot error: ${code}`), {
    code
  });
}
