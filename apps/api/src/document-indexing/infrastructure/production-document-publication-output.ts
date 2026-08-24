import type { DocumentPublicationImmutableScopeSnapshot } from
  "../application/document-publication-scope-generation-runtime.js";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import {
  normalizeDocumentPublicationScopeOutput,
  selectDocumentPublicationRemovedPaths
} from "../application/document-publication-scope-output.js";
import { zeroStorageRequests } from
  "./production-document-scope-renderer-support.js";

type RenderedPublicationScope = Readonly<{
  pages: readonly Readonly<{
    logicalPath: string;
    normalizedPath: string;
    entryKind: string;
    objectId: string;
    checksumSha256: string;
    byteCount: number;
  }>[];
  removedNormalizedPaths: readonly string[];
  navigationMutations: readonly Readonly<{
    directoryPath: string;
    [key: string]: unknown;
  }>[];
  verifiedReservations: readonly Readonly<{
    objectId: string;
    writeAttemptPublicId: string;
  }>[];
  storageRequests?: ReturnType<typeof zeroStorageRequests>;
  factCount: number;
}>;

export function finalizeDocumentPublicationOutput(input: Readonly<{
  snapshot: DocumentPublicationImmutableScopeSnapshot;
  rendered: RenderedPublicationScope;
  validationEvidence: Readonly<{
    scopeIdentity: string;
    memberCount: number;
    basePageCount: number;
  }>;
}>) {
  const removedNormalizedPaths = selectDocumentPublicationRemovedPaths({
    basePages: input.snapshot.basePages,
    renderedPaths: input.rendered.pages.map((page) => page.normalizedPath),
    explicitRemovedPaths: input.rendered.removedNormalizedPaths,
    deleteOmittedBasePages: input.snapshot.scopeKind === "source"
  });
  const pages = [
    ...input.rendered.pages.map((page) => ({
      logicalPath: page.logicalPath,
      normalizedPath: page.normalizedPath,
      action: "put" as const,
      entryKind: page.entryKind,
      objectId: page.objectId,
      checksumSha256: page.checksumSha256,
      byteCount: page.byteCount
    })),
    ...removedNormalizedPaths.map((normalizedPath) => ({
      logicalPath: normalizedPath,
      normalizedPath,
      action: "delete" as const,
      entryKind: null,
      objectId: null,
      checksumSha256: null,
      byteCount: null
    }))
  ];
  const normalized = normalizeDocumentPublicationScopeOutput({
    scope: {
      kind: input.snapshot.scopeKind as DocumentProjectionScopeClaim["kind"],
      key: input.snapshot.scopeKey
    },
    sourceFilePublicId: input.snapshot.scopeKind === "source"
      ? input.snapshot.scopeKey : null,
    inputSnapshotFingerprintSha256:
      input.snapshot.inputSnapshotFingerprintSha256,
    rendererContractVersion: input.snapshot.rendererContractVersion,
    pages,
    navigationMutations: input.rendered.navigationMutations.map(
      (mutation, order) => ({
        directoryPath: mutation.directoryPath,
        order,
        action: "upsert" as const,
        mutation
      })
    ),
    validationEvidence: {
      ...input.validationEvidence,
      recordsRendered: input.rendered.factCount
    }
  });
  return {
    ...normalized,
    verifiedReservations: input.rendered.verifiedReservations,
    storageRequests: input.rendered.storageRequests ?? zeroStorageRequests()
  };
}
