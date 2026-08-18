export const STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS = Object.freeze([
  "index.md",
  "pages/index.md",
  "log.md",
  "_index/index.md",
  "_graph/index.md",
  "_index/catalog.json"
]);

export function isStorageVnextRunOwnedMeilisearchTask(task, input) {
  if (typeof task?.indexUid === "string") {
    return task.indexUid.startsWith(input.searchScope);
  }
  if (
    task?.indexUid !== null
    || task?.type !== "taskDeletion"
    || typeof task.details?.originalFilter !== "string"
  ) return false;
  const parameters = new URLSearchParams(task.details.originalFilter);
  if ([...parameters.keys()].some((key) => key !== "uids")) return false;
  const targetUids = (parameters.get("uids") ?? "").split(",").map(Number);
  return targetUids.length > 0
    && targetUids.every((uid) =>
      Number.isSafeInteger(uid) && uid >= 0 && !input.controlTaskUids.has(uid));
}

export async function listAllStorageVnextMeilisearchTasks(
  readPage,
  pageLimit = 1_000
) {
  if (
    typeof readPage !== "function"
    || !Number.isSafeInteger(pageLimit)
    || pageLimit < 1
    || pageLimit > 1_000
  ) throw new Error("Storage vNext Meilisearch task pagination input is invalid");
  const tasks = [];
  const visited = new Set();
  let from;
  let expectedTotal = null;
  do {
    const page = await readPage({
      limit: pageLimit,
      ...(from === undefined ? {} : { from })
    });
    if (
      !page
      || !Array.isArray(page.results)
      || !Number.isSafeInteger(page.total)
      || page.total < 0
    ) throw new Error("Storage vNext Meilisearch task page is invalid");
    if (expectedTotal === null) expectedTotal = page.total;
    if (page.total !== expectedTotal) {
      throw new Error("Storage vNext Meilisearch task total changed during pagination");
    }
    tasks.push(...page.results);
    if (page.next === null) break;
    if (
      !Number.isSafeInteger(page.next)
      || page.next < 0
      || visited.has(page.next)
    ) throw new Error("Storage vNext Meilisearch task pagination stalled");
    visited.add(page.next);
    from = page.next;
  } while (true);
  if (tasks.length !== expectedTotal) {
    throw new Error("Storage vNext Meilisearch task evidence is incomplete");
  }
  return tasks;
}

const FULL_FILE_COUNT = 29_736;
const FULL_SOURCE_BYTES = 526_803_253;
const MAXIMUM_FULL_SEARCH_DOCUMENTS = FULL_FILE_COUNT * 8;

export function assertStorageVnextFullVerificationEvidence(input) {
  if (
    !/^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(input?.runId ?? "")
    || !/^knowledge-base-[0-9a-f-]{36}$/u.test(input?.knowledgeBaseId ?? "")
  ) reject("scope identity is invalid");

  const corpus = input.corpus ?? {};
  if (
    corpus.fileCount !== FULL_FILE_COUNT
    || corpus.totalSizeBytes !== FULL_SOURCE_BYTES
    || corpus.checksumMismatchCount !== 0
    || !positiveInteger(corpus.expectedDirectoryCount)
  ) reject("corpus identity or checksum closure changed");

  const postgres = input.postgres ?? {};
  for (const field of [
    "knowledgeBaseCount",
    "sourceFileCount",
    "currentRevisionCount",
    "currentPointerCount",
    "distinctLogicalPathCount",
    "currentSourceBytes",
    "sourceDirectoryCount",
    "graphNodeCount",
    "graphEdgeCount",
    "generatedEntryCount",
    "sourceBackedEntryCount",
    "activeRootCount",
    "candidateRootCount",
    "rollbackRootCount",
    "activeSnapshotCount",
    "liveCandidateCount",
    "activeSearchProjectionCount",
    "candidateSearchProjectionCount",
    "activeSearchDocumentCount",
    "verifiedRegistrationCount",
    "ownedVerifiedRegistrationCount",
    "orphanOwnerCount",
    "zeroOwnerObjectCount",
    "invalidGeneratedPathCount"
  ]) requireNonnegativeInteger(postgres[field], `PostgreSQL ${field}`);
  if (
    postgres.knowledgeBaseCount !== 1
    || postgres.sourceFileCount !== FULL_FILE_COUNT
    || postgres.currentRevisionCount !== FULL_FILE_COUNT
    || postgres.currentPointerCount !== FULL_FILE_COUNT
    || postgres.distinctLogicalPathCount !== FULL_FILE_COUNT
    || postgres.currentSourceBytes !== FULL_SOURCE_BYTES
    || postgres.sourceDirectoryCount !== corpus.expectedDirectoryCount
    || postgres.graphNodeCount !== FULL_FILE_COUNT
    || postgres.generatedEntryCount < FULL_FILE_COUNT
      + STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.length
    || postgres.sourceBackedEntryCount !== FULL_FILE_COUNT
  ) reject("PostgreSQL current facts or generated counts are incomplete");
  if (
    postgres.activeRootCount !== 1
    || postgres.candidateRootCount > 1
    || postgres.rollbackRootCount > 1
    || postgres.activeSnapshotCount !== 1
    || postgres.liveCandidateCount !== 0
    || postgres.activeSearchProjectionCount !== 1
    || postgres.candidateSearchProjectionCount !== 0
  ) reject("release or search root bounds did not converge");
  if (
    postgres.activeSearchDocumentCount < 1
    || postgres.activeSearchDocumentCount > MAXIMUM_FULL_SEARCH_DOCUMENTS
  ) reject("active search document count is outside the full-corpus bound");
  if (
    postgres.verifiedRegistrationCount < 1
    || postgres.ownedVerifiedRegistrationCount !== postgres.verifiedRegistrationCount
    || postgres.orphanOwnerCount !== 0
    || postgres.zeroOwnerObjectCount !== 0
  ) reject("object ownership is not closed");
  if (
    postgres.invalidGeneratedPathCount !== 0
    || !sameStrings(
      postgres.requiredNavigationPaths,
      STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS
    )
  ) reject("released generated path order changed");

  const providers = input.providers ?? {};
  for (const field of [
    "s3CurrentObjectCount",
    "s3OwnerMarkerCount",
    "s3OrphanObjectCount",
    "meilisearchIndexCount",
    "meilisearchDocumentCount",
    "meilisearchTasksInFlight"
  ]) requireNonnegativeInteger(providers[field], `provider ${field}`);
  if (
    providers.s3OwnerMarkerCount !== 1
    || providers.s3OrphanObjectCount !== 0
    || providers.s3CurrentObjectCount
      !== postgres.verifiedRegistrationCount + providers.s3OwnerMarkerCount
  ) reject("S3 registrations and current objects do not close");
  if (
    providers.meilisearchIndexCount !== 1
    || providers.meilisearchDocumentCount !== postgres.activeSearchDocumentCount
    || providers.meilisearchTasksInFlight !== 0
    || providers.activeIndexMatchesProvider !== true
  ) reject("Meilisearch active projection does not close");

  if (
    !input.controls
    || Object.values(input.controls).length !== 5
    || Object.values(input.controls).some((unchanged) => unchanged !== true)
  ) reject("a pre-existing control scope changed");

  const parity = input.releasedStructureParity ?? {};
  if (
    parity.requiredNavigationOrderMatches !== true
    || parity.sourceMappingCount !== FULL_FILE_COUNT
    || parity.directoryNavigationCount !== corpus.expectedDirectoryCount
    || parity.pathValidationPassed !== true
    || parity.frozenStructureContractPassed !== true
  ) reject("released generated structure parity failed");

  return Object.freeze({
    fileCount: FULL_FILE_COUNT,
    sourceBytes: FULL_SOURCE_BYTES,
    graphNodeCount: postgres.graphNodeCount,
    graphEdgeCount: postgres.graphEdgeCount,
    generatedEntryCount: postgres.generatedEntryCount,
    searchDocumentCount: postgres.activeSearchDocumentCount,
    ownerClosureCount: postgres.ownedVerifiedRegistrationCount,
    generatedStructureParity: true,
    preexistingControlsUnchanged: true
  });
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) reject(`${label} is invalid`);
}

function reject(reason) {
  throw new Error(`Storage vNext full verification failed: ${reason}`);
}
