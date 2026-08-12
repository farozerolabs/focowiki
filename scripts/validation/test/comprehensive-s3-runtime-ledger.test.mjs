import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComprehensiveS3RuntimeLedger
} from "../lib/comprehensive-s3-runtime-ledger.mjs";

const verifiedRegistration = {
  objectId: "object-1",
  storageKey: "focowiki/objects/source/one.md",
  checksumSha256: "a".repeat(64),
  byteCount: 12,
  contentType: "text/markdown; charset=utf-8",
  objectFormat: "source-markdown-v1",
  state: "verified",
  zeroOwnerSince: null
};

const verifiedVersion = {
  storageKey: verifiedRegistration.storageKey,
  versionId: "version-1",
  isLatest: true,
  size: 12,
  head: {
    contentLength: 12,
    contentType: verifiedRegistration.contentType,
    checksumSha256: verifiedRegistration.checksumSha256,
    objectFormat: verifiedRegistration.objectFormat,
    bodyByteCount: 12,
    bodyChecksumSha256: verifiedRegistration.checksumSha256
  }
};

test("reconciles every registration, owner, current object, and version without exposing keys", () => {
  const report = buildComprehensiveS3RuntimeLedger({
    registrations: [verifiedRegistration],
    owners: [{
      publicId: "owner-1",
      knowledgeBaseId: "knowledge-base-1",
      objectId: verifiedRegistration.objectId,
      ownerKind: "source_revision",
      ownerPublicId: "source-revision-1"
    }],
    currentObjects: [{
      storageKey: verifiedRegistration.storageKey,
      size: 12,
      versionId: "version-1"
    }],
    versions: [verifiedVersion],
    deleteMarkers: [],
    multipartUploads: []
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, {
    registrationCount: 1,
    ownerCount: 1,
    currentObjectCount: 1,
    versionCount: 1,
    deleteMarkerCount: 0,
    multipartUploadCount: 0,
    failedRegistrationCount: 0,
    failedOwnerCount: 0,
    failedCurrentObjectCount: 0,
    failedVersionCount: 0,
    failedDeleteMarkerCount: 0,
    failedMultipartUploadCount: 0
  });
  assert.match(report.registrations[0].storageKeyFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(report).includes(verifiedRegistration.storageKey), false);
  assert.equal(report.owners[0].pass, true);
  assert.equal(report.currentObjects[0].pass, true);
  assert.equal(report.versions[0].pass, true);
});

test("accepts a deleted registration whose latest item is a delete marker", () => {
  const registration = { ...verifiedRegistration, state: "deleted", zeroOwnerSince: "2026-08-11T00:00:00.000Z" };
  const report = buildComprehensiveS3RuntimeLedger({
    registrations: [registration],
    owners: [],
    currentObjects: [],
    versions: [{ ...verifiedVersion, isLatest: false }],
    deleteMarkers: [{
      storageKey: registration.storageKey,
      versionId: "delete-1",
      isLatest: true
    }],
    multipartUploads: []
  });

  assert.equal(report.ok, true);
  assert.equal(report.registrations[0].checks.latestStateMatchesRegistration, true);
  assert.equal(report.deleteMarkers[0].pass, true);
});

test("fails when an owned verified registration retains a zero-owner marker", () => {
  const report = buildComprehensiveS3RuntimeLedger({
    registrations: [{
      ...verifiedRegistration,
      zeroOwnerSince: "2026-08-11T00:00:00.000Z"
    }],
    owners: [{
      publicId: "owner-1",
      knowledgeBaseId: "knowledge-base-1",
      objectId: verifiedRegistration.objectId,
      ownerKind: "source_revision",
      ownerPublicId: "source-revision-1"
    }],
    currentObjects: [{
      storageKey: verifiedRegistration.storageKey,
      size: 12,
      versionId: "version-1"
    }],
    versions: [verifiedVersion],
    deleteMarkers: [],
    multipartUploads: []
  });

  assert.equal(report.ok, false);
  assert.equal(report.summary.failedRegistrationCount, 1);
  assert.equal(
    report.registrations[0].checks.zeroOwnerMarkerMatchesOwnership,
    false
  );
});

test("fails closed for orphan objects, broken metadata, owners, and multipart uploads", () => {
  const report = buildComprehensiveS3RuntimeLedger({
    registrations: [verifiedRegistration],
    owners: [{
      publicId: "owner-missing",
      knowledgeBaseId: "knowledge-base-1",
      objectId: "missing-object",
      ownerKind: "source_revision",
      ownerPublicId: "source-revision-missing"
    }],
    currentObjects: [{ storageKey: "focowiki/orphan.bin", size: 2, versionId: "orphan-version" }],
    versions: [{
      ...verifiedVersion,
      head: {
        ...verifiedVersion.head,
        checksumSha256: "b".repeat(64),
        bodyChecksumSha256: "b".repeat(64)
      }
    }, {
      storageKey: "focowiki/orphan.bin",
      versionId: "orphan-version",
      isLatest: true,
      size: 2,
      head: {
        contentLength: 2,
        contentType: "application/octet-stream",
        checksumSha256: "c".repeat(64),
        objectFormat: "semantic-vector-v1",
        bodyByteCount: 2,
        bodyChecksumSha256: "c".repeat(64)
      }
    }],
    deleteMarkers: [],
    multipartUploads: [{
      storageKey: verifiedRegistration.storageKey,
      uploadId: "upload-1"
    }]
  });

  assert.equal(report.ok, false);
  assert.equal(report.summary.failedRegistrationCount, 1);
  assert.equal(report.summary.failedOwnerCount, 1);
  assert.equal(report.summary.failedCurrentObjectCount, 1);
  assert.equal(report.summary.failedVersionCount, 2);
  assert.equal(report.summary.failedMultipartUploadCount, 1);
});
