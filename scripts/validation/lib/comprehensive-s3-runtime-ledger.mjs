import { createHash } from "node:crypto";

export function buildComprehensiveS3RuntimeLedger(input) {
  assertInput(input);
  const registrationsById = uniqueMap(input.registrations, "objectId");
  const registrationsByKey = uniqueMap(input.registrations, "storageKey");
  const currentByKey = uniqueMap(input.currentObjects, "storageKey");
  const versionsByKey = groupBy(input.versions, "storageKey");
  const markersByKey = groupBy(input.deleteMarkers, "storageKey");
  const ownersByObjectId = groupBy(input.owners, "objectId");

  const registrations = input.registrations.map((registration) => {
    const current = currentByKey.get(registration.storageKey);
    const versions = versionsByKey.get(registration.storageKey) ?? [];
    const markers = markersByKey.get(registration.storageKey) ?? [];
    const latestVersions = versions.filter((item) => item.isLatest);
    const latestMarkers = markers.filter((item) => item.isLatest);
    const ownerCount = (ownersByObjectId.get(registration.objectId) ?? []).length;
    const latestStateMatchesRegistration = registration.state === "deleted"
      ? current === undefined && latestVersions.length === 0
        && (latestMarkers.length === 1 || (versions.length === 0 && markers.length === 0))
      : registration.state === "verified"
        ? current !== undefined && latestVersions.length === 1 && latestMarkers.length === 0
        : latestVersions.length + latestMarkers.length <= 1;
    const checks = {
      currentPresenceMatchesRegistration: registration.state === "verified"
        ? current !== undefined
        : registration.state === "deleted"
          ? current === undefined
          : true,
      latestStateMatchesRegistration,
      currentSizeMatchesRegistration: current === undefined
        || Number(current.size) === Number(registration.byteCount),
      everyVersionMetadataMatchesRegistration: versions.every((version) =>
        versionMetadataMatches(version, registration)),
      deletedRegistrationHasNoOwner: registration.state !== "deleted" || ownerCount === 0,
      reservedRegistrationHasNoOwner: registration.state !== "reserved" || ownerCount === 0,
      zeroOwnerMarkerMatchesOwnership: registration.state !== "verified"
        || (ownerCount === 0) === (registration.zeroOwnerSince !== null)
    };
    return {
      registrationFingerprint: fingerprint(registration.objectId),
      storageKeyFingerprint: fingerprint(registration.storageKey),
      state: registration.state,
      byteCount: Number(registration.byteCount),
      objectFormat: registration.objectFormat,
      ownerCount,
      currentObjectPresent: current !== undefined,
      versionCount: versions.length,
      deleteMarkerCount: markers.length,
      checks,
      pass: Object.values(checks).every(Boolean)
    };
  });

  const owners = input.owners.map((owner) => {
    const registration = registrationsById.get(owner.objectId);
    const checks = {
      registrationExists: registration !== undefined,
      registrationVerified: registration?.state === "verified",
      ownerIdentityPresent: Boolean(owner.publicId && owner.ownerPublicId),
      knowledgeBaseIdentityPresent: Boolean(owner.knowledgeBaseId),
      ownerKindPresent: Boolean(owner.ownerKind)
    };
    return {
      ownerFingerprint: fingerprint(owner.publicId),
      ownerTargetFingerprint: fingerprint(owner.ownerPublicId),
      knowledgeBaseFingerprint: fingerprint(owner.knowledgeBaseId),
      registrationFingerprint: fingerprint(owner.objectId),
      ownerKind: owner.ownerKind,
      checks,
      pass: Object.values(checks).every(Boolean)
    };
  });

  const currentObjects = input.currentObjects.map((object) => {
    const registration = registrationsByKey.get(object.storageKey);
    const version = findVersion(input.versions, object.storageKey, object.versionId);
    const checks = {
      registrationExists: registration !== undefined,
      registrationIsNotDeleted: registration !== undefined && registration.state !== "deleted",
      byteCountMatches: registration !== undefined
        && Number(object.size) === Number(registration.byteCount),
      latestVersionExists: version !== undefined && version.isLatest === true,
      latestVersionMetadataMatches: registration !== undefined
        && version !== undefined && versionMetadataMatches(version, registration)
    };
    return {
      storageKeyFingerprint: fingerprint(object.storageKey),
      versionFingerprint: fingerprint(object.versionId),
      byteCount: Number(object.size),
      registrationState: registration?.state ?? null,
      checks,
      pass: Object.values(checks).every(Boolean)
    };
  });

  const versions = input.versions.map((version) => {
    const registration = registrationsByKey.get(version.storageKey);
    const checks = {
      registrationExists: registration !== undefined,
      byteCountMatches: registration !== undefined
        && Number(version.size) === Number(registration.byteCount),
      headObserved: version.head !== null && version.head !== undefined,
      headMetadataMatches: registration !== undefined
        && versionMetadataMatches(version, registration),
      latestVersionIsCurrent: !version.isLatest
        || currentByKey.has(version.storageKey)
    };
    return {
      storageKeyFingerprint: fingerprint(version.storageKey),
      versionFingerprint: fingerprint(version.versionId),
      isLatest: version.isLatest,
      byteCount: Number(version.size),
      readDurationMs: version.durationMs ?? null,
      readFailure: version.readFailure ?? null,
      checks,
      pass: Object.values(checks).every(Boolean)
    };
  });

  const deleteMarkers = input.deleteMarkers.map((marker) => {
    const registration = registrationsByKey.get(marker.storageKey);
    const checks = {
      registrationExists: registration !== undefined,
      latestMarkerMatchesDeletedState: !marker.isLatest
        || registration?.state === "deleted",
      latestMarkerHasNoCurrentObject: !marker.isLatest
        || !currentByKey.has(marker.storageKey)
    };
    return {
      storageKeyFingerprint: fingerprint(marker.storageKey),
      versionFingerprint: fingerprint(marker.versionId),
      isLatest: marker.isLatest,
      checks,
      pass: Object.values(checks).every(Boolean)
    };
  });

  const multipartUploads = input.multipartUploads.map((upload) => ({
    storageKeyFingerprint: fingerprint(upload.storageKey),
    uploadFingerprint: fingerprint(upload.uploadId),
    checks: { stableRuntimeHasNoIncompleteMultipartUpload: false },
    pass: false
  }));

  const summary = summarize({
    registrations,
    owners,
    currentObjects,
    versions,
    deleteMarkers,
    multipartUploads
  });
  return {
    schemaVersion: 1,
    coverageMode: "exhaustive",
    ok: Object.entries(summary).every(([name, value]) =>
      !name.startsWith("failed") || value === 0),
    summary,
    registrations,
    owners,
    currentObjects,
    versions,
    deleteMarkers,
    multipartUploads
  };
}

function assertInput(input) {
  for (const name of [
    "registrations",
    "owners",
    "currentObjects",
    "versions",
    "deleteMarkers",
    "multipartUploads"
  ]) {
    if (!Array.isArray(input?.[name])) {
      throw new Error(`S3 runtime ledger ${name} must be an array`);
    }
  }
  uniqueMap(input.registrations, "objectId");
  uniqueMap(input.registrations, "storageKey");
  uniqueMap(input.currentObjects, "storageKey");
}

function summarize(groups) {
  const result = {};
  for (const [name, rows] of Object.entries(groups)) {
    const singular = name === "currentObjects" ? "CurrentObject"
      : name === "multipartUploads" ? "MultipartUpload"
        : name.slice(0, -1).replace(/^./u, (value) => value.toUpperCase());
    result[`${name.slice(0, -1)}Count`] = rows.length;
    result[`failed${singular}Count`] = rows.filter((row) => !row.pass).length;
  }
  return reorderSummary(result);
}

function reorderSummary(value) {
  return {
    registrationCount: value.registrationCount,
    ownerCount: value.ownerCount,
    currentObjectCount: value.currentObjectCount,
    versionCount: value.versionCount,
    deleteMarkerCount: value.deleteMarkerCount,
    multipartUploadCount: value.multipartUploadCount,
    failedRegistrationCount: value.failedRegistrationCount,
    failedOwnerCount: value.failedOwnerCount,
    failedCurrentObjectCount: value.failedCurrentObjectCount,
    failedVersionCount: value.failedVersionCount,
    failedDeleteMarkerCount: value.failedDeleteMarkerCount,
    failedMultipartUploadCount: value.failedMultipartUploadCount
  };
}

function versionMetadataMatches(version, registration) {
  return version.head !== null
    && version.head !== undefined
    && Number(version.size) === Number(registration.byteCount)
    && Number(version.head.contentLength) === Number(registration.byteCount)
    && Number(version.head.bodyByteCount) === Number(registration.byteCount)
    && version.head.contentType === registration.contentType
    && version.head.checksumSha256 === registration.checksumSha256
    && version.head.bodyChecksumSha256 === registration.checksumSha256
    && version.head.objectFormat === registration.objectFormat;
}

function findVersion(versions, storageKey, versionId) {
  const exact = versions.find((version) =>
    version.storageKey === storageKey && version.versionId === versionId);
  return exact ?? versions.find((version) =>
    version.storageKey === storageKey && version.isLatest);
}

function uniqueMap(rows, property) {
  const result = new Map();
  for (const row of rows) {
    const value = row?.[property];
    if (typeof value !== "string" || value.length === 0 || result.has(value)) {
      throw new Error(`S3 runtime ledger ${property} values must be unique non-empty strings`);
    }
    result.set(value, row);
  }
  return result;
}

function groupBy(rows, property) {
  const result = new Map();
  for (const row of rows) {
    const value = row?.[property];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`S3 runtime ledger ${property} values must be non-empty strings`);
    }
    const values = result.get(value) ?? [];
    values.push(row);
    result.set(value, values);
  }
  return result;
}

function fingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
