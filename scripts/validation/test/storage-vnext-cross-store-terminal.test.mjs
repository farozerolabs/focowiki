import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStorageVnextCrossStoreTerminal
} from "../lib/storage-vnext-cross-store-terminal.mjs";

test("accepts one terminal public outcome with closed provider handoffs", () => {
  const summary = assertStorageVnextCrossStoreTerminal(validEvidence());

  assert.equal(summary.operationCount, 2);
  assert.equal(summary.sourceFileCount, 1);
  assert.equal(summary.objectCount, 3);
  assert.equal(summary.zeroOwnerObjectCount, 1);
  assert.equal(summary.searchIndexCount, 1);
  assert.equal(summary.liveWorkItemCount, 0);
  assert.equal(summary.redisOwnerMarkerCount, 1);
  assert.equal(summary.redisUnexpectedPersistentKeyCount, 0);
  assert.equal(summary.unresolvedLoggedOperationCount, 0);
  assert.match(summary.sourceSetDigest, /^[0-9a-f]{64}$/u);
});

test("ignores persistent Redis owner markers from immutable external scopes", () => {
  const evidence = validEvidence();
  evidence.redis.keys.push({
    key: "focowiki:validation:svnext-20260803T183453Z-dde49c667bb8:_run-owner",
    type: "string",
    ttlSeconds: -1
  });

  const summary = assertStorageVnextCrossStoreTerminal(evidence);

  assert.equal(summary.coordinationKeyCount, 1);
  assert.equal(summary.redisUnexpectedPersistentKeyCount, 0);
});

test("rejects public catalog drift and nonterminal PostgreSQL work", () => {
  const catalogDrift = validEvidence();
  catalogDrift.public.sourceFiles[0].relativePath = "other.md";
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(catalogDrift),
    /public source catalog does not match postgresql/i
  );

  const liveWork = validEvidence();
  liveWork.postgres.snapshot.workItems.push({
    operationId: "operation-2",
    workKind: "publication",
    state: "retry"
  });
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(liveWork),
    /live work items/i
  );
});

test("rejects a second knowledge-base index and document-count drift", () => {
  const duplicate = validEvidence();
  duplicate.meilisearch.indexes.push({
    uid: `${duplicate.proof.searchScope}candidate`,
    numberOfDocuments: 1
  });
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(duplicate),
    /exactly one scoped meilisearch index/i
  );

  const countDrift = validEvidence();
  countDrift.meilisearch.indexes[0].numberOfDocuments = 8;
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(countDrift),
    /meilisearch document count/i
  );
});

test("rejects missing or mismatched S3 objects and provider residue", () => {
  const missing = validEvidence();
  missing.s3.currentObjects.pop();
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(missing),
    /s3 current object set does not match postgresql ownership/i
  );

  const checksumDrift = validEvidence();
  checksumDrift.s3.currentObjects[0].checksum = "f".repeat(64);
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(checksumDrift),
    /s3 object metadata does not match postgresql/i
  );

  const shadowed = validEvidence();
  shadowed.s3.deleteMarkers.push({
    storageKey: shadowed.s3.currentObjects[0].storageKey,
    isLatest: true
  });
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(shadowed),
    /delete marker shadows a registered current object/i
  );

  const multipart = validEvidence();
  multipart.s3.multipartUploads.push({ storageKey: `${multipart.proof.objectScope}pending` });
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(multipart),
    /multipart uploads/i
  );
});

test("rejects persistent Redis state, active locks, and unresolved logged operations", () => {
  const persistent = validEvidence();
  persistent.redis.keys.push({
    key: `${persistent.proof.coordinationScope}cache-without-ttl`,
    type: "string",
    ttlSeconds: -1
  });
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(persistent),
    /redis keys must be ttl-bound/i
  );

  const lock = validEvidence();
  lock.redis.keys.push({
    key: `${lock.proof.coordinationScope}knowledge-base-publication-locks:${lock.knowledgeBaseId}`,
    type: "string",
    ttlSeconds: 30
  });
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(lock),
    /redis lock residue/i
  );

  const unresolved = validEvidence();
  unresolved.logs.targetEvents.push({
    event: "source_worker.item_failed",
    level: "error",
    operationPublicId: "operation-missing"
  });
  assert.throws(
    () => assertStorageVnextCrossStoreTerminal(unresolved),
    /logged operation has no terminal postgresql outcome/i
  );
});

function validEvidence() {
  const runId = "svnext-20260802T101443Z-7aa18b22cafe";
  const knowledgeBaseId = "knowledge-base-validation";
  const objectScope = `${runId}/`;
  const searchScope = "svnext_20260802t101443z_7aa18b22cafe_";
  const coordinationScope = `focowiki:validation:${runId}:`;
  return {
    runId,
    knowledgeBaseId,
    proof: { objectScope, searchScope, coordinationScope },
    postgres: {
      snapshot: {
        knowledgeBase: {
          id: knowledgeBaseId,
          name: `Storage vNext ${runId} terminal target`,
          deletedAt: null,
          activeRootPublicId: "root-1",
          activeRevision: 1
        },
        operations: [
          { id: "operation-1", state: "completed" },
          { id: "operation-2", state: "failed" }
        ],
        operationResults: [
          { id: "operation-1", state: "completed" },
          { id: "operation-2", state: "failed" }
        ],
        workItems: [],
        sourceFiles: [{
          id: "source-1",
          logicalPath: "guide.md",
          status: "ready",
          currentRevisionId: "revision-1",
          deletedAt: null
        }],
        sourceRevisions: [{
          id: "revision-1",
          sourceFileId: "source-1",
          revisionRole: "current",
          objectId: "object-source"
        }],
        releaseRoots: [{ id: "root-1", rootRole: "active" }],
        searchProjections: [{
          id: "search-1",
          role: "active",
          state: "ready",
          documentCount: 9
        }],
        activeSnapshots: [{
          releaseRootId: "root-1",
          searchProjectionId: "search-1",
          operationId: "operation-1"
        }],
        objectOwners: [
          { id: "owner-source", objectId: "object-source" },
          { id: "owner-release", objectId: "object-release" }
        ],
        objectRegistrations: [
          { id: "object-source", state: "verified" },
          { id: "object-release", state: "verified" }
        ]
      },
      physical: {
        registrations: [
          {
            objectId: "object-source",
            storageKey: `${objectScope}source`,
            checksum: "a".repeat(64),
            byteCount: 10,
            contentType: "text/markdown; charset=utf-8",
            objectFormat: "source-markdown-v1",
            state: "verified",
            ownerCount: 1,
            targetOwnerCount: 1,
            zeroOwnerSince: null
          },
          {
            objectId: "object-release",
            storageKey: `${objectScope}release`,
            checksum: "b".repeat(64),
            byteCount: 20,
            contentType: "application/x-ndjson",
            objectFormat: "release-shard-v1",
            state: "verified",
            ownerCount: 1,
            targetOwnerCount: 1,
            zeroOwnerSince: null
          },
          {
            objectId: "object-expired-owner",
            storageKey: `${objectScope}retained`,
            checksum: "c".repeat(64),
            byteCount: 30,
            contentType: "application/x-ndjson",
            objectFormat: "release-shard-v1",
            state: "verified",
            ownerCount: 0,
            targetOwnerCount: 0,
            zeroOwnerSince: "2026-08-02T10:00:00.000Z"
          }
        ],
        searchProjections: [{
          publicId: "search-1",
          role: "active",
          state: "ready",
          providerIndexUid: `${searchScope}active`,
          documentCount: 9
        }]
      }
    },
    public: {
      knowledgeBaseId,
      sourceFiles: [{
        sourceFileId: "source-1",
        relativePath: "guide.md",
        state: "visible"
      }],
      searchResultCount: 1,
      rootIndexByteCount: 20,
      treeItemCount: 3
    },
    s3: {
      ownerMarkerCount: 1,
      ownerMarkerValid: true,
      currentObjects: [
        {
          storageKey: `${objectScope}source`,
          byteCount: 10,
          checksum: "a".repeat(64),
          contentType: "text/markdown; charset=utf-8",
          objectFormat: "source-markdown-v1"
        },
        {
          storageKey: `${objectScope}release`,
          byteCount: 20,
          checksum: "b".repeat(64),
          contentType: "application/x-ndjson",
          objectFormat: "release-shard-v1"
        },
        {
          storageKey: `${objectScope}retained`,
          byteCount: 30,
          checksum: "c".repeat(64),
          contentType: "application/x-ndjson",
          objectFormat: "release-shard-v1"
        }
      ],
      deleteMarkers: [{
        storageKey: `${objectScope}deleted-history`,
        isLatest: true
      }],
      multipartUploads: []
    },
    meilisearch: {
      indexes: [{ uid: `${searchScope}active`, numberOfDocuments: 9 }],
      tasks: [{ uid: 1, status: "succeeded" }]
    },
    redis: {
      keys: [
        { key: "focowiki:runtime-settings:version", type: "string", ttlSeconds: 120 },
        { key: `${coordinationScope}_run-owner`, type: "string", ttlSeconds: -1 }
      ]
    },
    logs: {
      files: [{ name: "source-worker", byteCount: 100 }],
      targetEvents: [{
        event: "source_worker.item_failed",
        level: "error",
        operationPublicId: "operation-2"
      }]
    }
  };
}
