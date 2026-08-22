import { validateDocumentDirectoryNavigationMutations } from
  "../application/document-directory-navigation-mutation.js";
import type {
  DocumentProjectionScopeOutput,
  DocumentProjectionScopeOutputPage
} from "./postgres-projection-scope-output-repository.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export function validateProjectionScopeOutput(
  input: DocumentProjectionScopeOutput
): DocumentProjectionScopeOutput {
  const pages = [...input.pages].sort((left, right) =>
    left.normalizedPath.localeCompare(right.normalizedPath, "en-US"));
  const removedNormalizedPaths = [...new Set(input.removedNormalizedPaths)]
    .sort();
  if (pages.length > 256
    || new Set(pages.map((page) => page.normalizedPath)).size !== pages.length
    || removedNormalizedPaths.length > 256
    || pages.some((page) => !validPage(page))
    || removedNormalizedPaths.some((path) => !validPath(path))) {
    throw repositoryContractError("projection_scope_output_invalid");
  }
  validateDocumentDirectoryNavigationMutations(input.navigationMutations);
  const ownerIdentities = input.activationOwnerVersions.map((owner) =>
    `${owner.kind}\0${owner.key}`);
  if (input.activationOwnerVersions.length > 30_000
    || new Set(ownerIdentities).size !== ownerIdentities.length
    || input.activationOwnerVersions.some((owner) =>
      !["page_head", "directory_leaf", "directory_entry"].includes(owner.kind)
      || !owner.key || Buffer.byteLength(owner.key, "utf8") > 2_048
      || !Number.isSafeInteger(owner.expectedVersion)
      || owner.expectedVersion < 0)) {
    throw repositoryContractError("projection_scope_output_owner_invalid");
  }
  return {
    scopePublicId: assertRepositoryIdentity(input.scopePublicId, "scope_public_id"),
    renderedSequence: assertRepositoryPositiveInteger(
      input.renderedSequence,
      "rendered_sequence"
    ),
    knowledgeBaseId: assertRepositoryIdentity(
      input.knowledgeBaseId,
      "knowledge_base_id"
    ),
    outputFingerprintSha256: assertRepositorySha256(
      input.outputFingerprintSha256,
      "output_fingerprint"
    ),
    pages,
    removedNormalizedPaths,
    navigationMutations: [...input.navigationMutations],
    activationOwnerVersions: [...input.activationOwnerVersions].sort(
      (left, right) => left.kind.localeCompare(right.kind, "en-US")
        || left.key.localeCompare(right.key, "en-US")
    ),
    createdAt: assertRepositoryTimestamp(input.createdAt, "created_at")
  };
}

function validPage(page: DocumentProjectionScopeOutputPage): boolean {
  return validPath(page.logicalPath) && validPath(page.normalizedPath)
    && page.normalizedPath === page.logicalPath.toLocaleLowerCase("en-US")
    && Boolean(page.entryKind) && Buffer.byteLength(page.entryKind, "utf8") <= 128
    && Boolean(page.objectId) && Buffer.byteLength(page.objectId, "utf8") <= 255
    && /^[0-9a-f]{64}$/u.test(page.checksumSha256)
    && Number.isSafeInteger(page.byteCount) && page.byteCount >= 0
    && ((page.sourceFilePublicId === null
      && page.sourceRevisionPublicId === null)
      || (Boolean(page.sourceFilePublicId)
        && Boolean(page.sourceRevisionPublicId)));
}

function validPath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("..")
    && Buffer.byteLength(path, "utf8") <= 4096;
}
