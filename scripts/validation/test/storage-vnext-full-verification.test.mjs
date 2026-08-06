import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS,
  assertStorageVnextFullVerificationEvidence,
  isStorageVnextRunOwnedMeilisearchTask,
  listAllStorageVnextMeilisearchTasks
} from "../lib/storage-vnext-full-verification.mjs";

function completeEvidence() {
  return {
    runId: "svnext-20260803T000000Z-012345abcdef",
    knowledgeBaseId: "knowledge-base-01234567-89ab-cdef-0123-456789abcdef",
    corpus: {
      fileCount: 29_736,
      totalSizeBytes: 526_803_253,
      checksumMismatchCount: 0,
      expectedDirectoryCount: 6
    },
    postgres: {
      knowledgeBaseCount: 1,
      sourceFileCount: 29_736,
      currentRevisionCount: 29_736,
      currentPointerCount: 29_736,
      distinctLogicalPathCount: 29_736,
      currentSourceBytes: 526_803_253,
      sourceDirectoryCount: 6,
      graphNodeCount: 29_736,
      graphEdgeCount: 100,
      generatedEntryCount: 30_100,
      sourceBackedEntryCount: 29_736,
      activeRootCount: 1,
      candidateRootCount: 0,
      rollbackRootCount: 0,
      activeSnapshotCount: 1,
      liveCandidateCount: 0,
      activeSearchProjectionCount: 1,
      candidateSearchProjectionCount: 0,
      activeSearchDocumentCount: 59_472,
      verifiedRegistrationCount: 60_000,
      ownedVerifiedRegistrationCount: 60_000,
      orphanOwnerCount: 0,
      zeroOwnerObjectCount: 0,
      invalidGeneratedPathCount: 0,
      requiredNavigationPaths: [...STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS]
    },
    providers: {
      s3CurrentObjectCount: 60_001,
      s3OwnerMarkerCount: 1,
      s3OrphanObjectCount: 0,
      meilisearchIndexCount: 1,
      meilisearchDocumentCount: 59_472,
      meilisearchTasksInFlight: 0,
      activeIndexMatchesProvider: true
    },
    controls: {
      postgres: true,
      s3: true,
      meilisearch: true,
      redis: true,
      filesystem: true
    },
    releasedStructureParity: {
      requiredNavigationOrderMatches: true,
      sourceMappingCount: 29_736,
      directoryNavigationCount: 6,
      pathValidationPassed: true,
      frozenStructureContractPassed: true
    }
  };
}

test("accepts complete full-corpus cross-store and released-structure evidence", () => {
  const summary = assertStorageVnextFullVerificationEvidence(completeEvidence());
  assert.equal(summary.fileCount, 29_736);
  assert.equal(summary.ownerClosureCount, 60_000);
  assert.equal(summary.generatedStructureParity, true);
});

test("rejects count, owner, provider, structure, and control drift", () => {
  for (const mutate of [
    (e) => { e.postgres.currentRevisionCount -= 1; },
    (e) => { e.postgres.zeroOwnerObjectCount = 1; },
    (e) => { e.providers.meilisearchDocumentCount -= 1; },
    (e) => { e.postgres.requiredNavigationPaths.reverse(); },
    (e) => { e.controls.s3 = false; }
  ]) {
    const evidence = completeEvidence();
    mutate(evidence);
    assert.throws(
      () => assertStorageVnextFullVerificationEvidence(evidence),
      /full verification/u
    );
  }
});

test("attributes scoped index work and scoped task cleanup to the run", () => {
  const searchScope = "svnext_20260803t000000z_012345abcdef_";
  assert.equal(isStorageVnextRunOwnedMeilisearchTask({
    uid: 10,
    indexUid: `${searchScope}active`,
    type: "documentAdditionOrUpdate"
  }, { searchScope, controlTaskUids: new Set([1]) }), true);
  assert.equal(isStorageVnextRunOwnedMeilisearchTask({
    uid: 11,
    indexUid: null,
    type: "taskDeletion",
    details: { originalFilter: "?uids=2%2C3%2C4" }
  }, { searchScope, controlTaskUids: new Set([1]) }), true);
  assert.equal(isStorageVnextRunOwnedMeilisearchTask({
    uid: 12,
    indexUid: null,
    type: "taskDeletion",
    details: { originalFilter: "?uids=1%2C2" }
  }, { searchScope, controlTaskUids: new Set([1]) }), false);
  assert.equal(isStorageVnextRunOwnedMeilisearchTask({
    uid: 13,
    indexUid: null,
    type: "dumpCreation",
    details: {}
  }, { searchScope, controlTaskUids: new Set() }), false);
});

test("paginates complete Meilisearch task evidence beyond one provider page", async () => {
  const calls = [];
  const tasks = await listAllStorageVnextMeilisearchTasks(async (query) => {
    calls.push(query);
    return query.from === undefined
      ? {
          results: [{ uid: 3 }, { uid: 2 }],
          total: 3,
          limit: 2,
          from: 3,
          next: 1
        }
      : {
          results: [{ uid: 1 }],
          total: 3,
          limit: 2,
          from: 1,
          next: null
        };
  }, 2);
  assert.deepEqual(tasks.map((task) => task.uid), [3, 2, 1]);
  assert.deepEqual(calls, [{ limit: 2 }, { limit: 2, from: 1 }]);
});
