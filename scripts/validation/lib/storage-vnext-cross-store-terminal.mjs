import crypto from "node:crypto";

const TERMINAL_OPERATION_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "timed_out",
  "deleted"
]);
const TERMINAL_SEARCH_TASK_STATES = new Set([
  "succeeded",
  "failed",
  "canceled"
]);
const LOCK_KEY_PATTERN = /(^|:)(locks|source-file-locks|source-file-graph-locks|knowledge-base-publication-locks)(:|$)/u;
const INTERNAL_PUBLIC_FIELD_PATTERN = /objectKey|storageKey|providerIndexUid|providerTaskUid|ownerMarker|proofChecksum|redisKey|tableName/iu;

export function assertStorageVnextCrossStoreTerminal(input) {
  assertScope(input);
  const snapshot = input.postgres?.snapshot;
  if (!snapshot?.knowledgeBase || !input.postgres?.physical) {
    throw new Error("Cross-store PostgreSQL evidence is incomplete.");
  }
  assertPostgresTerminal(input, snapshot);
  const sourceSetDigest = assertPublicOutcome(input, snapshot);
  const objectSummary = assertS3Handoff(input, snapshot);
  const searchIndexDigest = assertMeilisearchHandoff(input, snapshot);
  const redisSummary = assertRedisTerminal(input.redis, input.proof.coordinationScope);
  const logSummary = assertLogHandoff(input.logs, snapshot.operations);

  return Object.freeze({
    operationCount: snapshot.operations.length,
    operationResultCount: snapshot.operationResults.length,
    liveWorkItemCount: snapshot.workItems.length,
    sourceFileCount: liveSources(snapshot).length,
    activeSnapshotCount: snapshot.activeSnapshots.length,
    objectCount: input.postgres.physical.registrations.length,
    zeroOwnerObjectCount: objectSummary.zeroOwnerObjectCount,
    searchIndexCount: input.meilisearch.indexes.length,
    searchDocumentCount: Number(input.meilisearch.indexes[0].numberOfDocuments),
    coordinationKeyCount: redisSummary.keyCount,
    redisOwnerMarkerCount: redisSummary.ownerMarkerCount,
    redisUnexpectedPersistentKeyCount: redisSummary.unexpectedPersistentKeyCount,
    loggedTargetEventCount: input.logs.targetEvents.length,
    unresolvedLoggedOperationCount: logSummary.unresolvedOperationCount,
    sourceSetDigest,
    objectSetDigest: objectSummary.objectSetDigest,
    searchIndexDigest
  });
}

function assertScope(input) {
  if (
    !/^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(input?.runId ?? "")
    || typeof input.knowledgeBaseId !== "string"
    || !input.knowledgeBaseId
    || typeof input.proof?.objectScope !== "string"
    || !input.proof.objectScope.includes(input.runId)
    || !input.proof.objectScope.endsWith("/")
    || typeof input.proof?.searchScope !== "string"
    || !input.proof.searchScope.startsWith("svnext_")
    || !input.proof.searchScope.endsWith("_")
    || input.proof.coordinationScope !== `focowiki:validation:${input.runId}:`
  ) {
    throw new Error("Cross-store evidence is outside one exact run-owned scope.");
  }
}

function assertPostgresTerminal(input, snapshot) {
  const knowledgeBase = snapshot.knowledgeBase;
  if (
    knowledgeBase.id !== input.knowledgeBaseId
    || knowledgeBase.deletedAt
    || !knowledgeBase.name?.includes(input.runId)
  ) {
    throw new Error("PostgreSQL knowledge base is not the exact active run-owned target.");
  }
  if (!Array.isArray(snapshot.operations) || snapshot.operations.length === 0) {
    throw new Error("PostgreSQL operation evidence is empty.");
  }
  const nonterminal = snapshot.operations.filter(
    (operation) => !TERMINAL_OPERATION_STATES.has(operation.state)
  );
  if (nonterminal.length > 0) {
    throw new Error("PostgreSQL retained nonterminal operations.");
  }
  if (!Array.isArray(snapshot.workItems) || snapshot.workItems.length > 0) {
    throw new Error("PostgreSQL retained live work items after the public outcome.");
  }
  const results = new Map(
    (snapshot.operationResults ?? []).map((result) => [result.id, result.state])
  );
  if (snapshot.operations.some((operation) => results.get(operation.id) !== operation.state)) {
    throw new Error("PostgreSQL operation results do not close every operation terminal state.");
  }

  const sources = liveSources(snapshot);
  const currentRevisions = new Map(
    (snapshot.sourceRevisions ?? [])
      .filter((revision) => revision.revisionRole === "current")
      .map((revision) => [revision.id, revision])
  );
  if (
    sources.length === 0
    || sources.some((source) => {
      const revision = currentRevisions.get(source.currentRevisionId);
      return source.status !== "ready" || !revision || revision.sourceFileId !== source.id;
    })
  ) {
    throw new Error("PostgreSQL current source revisions did not converge to ready.");
  }

  const activeRoots = (snapshot.releaseRoots ?? []).filter(
    (root) => root.rootRole === "active"
  );
  const activeSearch = (snapshot.searchProjections ?? []).filter(
    (projection) => projection.role === "active" && projection.state === "ready"
  );
  if (
    activeRoots.length !== 1
    || snapshot.activeSnapshots?.length !== 1
    || activeSearch.length !== 1
  ) {
    throw new Error("PostgreSQL active release and search snapshot are not unique.");
  }
  const active = snapshot.activeSnapshots[0];
  if (
    active.releaseRootId !== activeRoots[0].id
    || active.searchProjectionId !== activeSearch[0].id
    || snapshot.operations.find((operation) => operation.id === active.operationId)?.state
      !== "completed"
  ) {
    throw new Error("PostgreSQL active snapshot handoff is inconsistent.");
  }

  const ownersByObject = new Map();
  for (const owner of snapshot.objectOwners ?? []) {
    ownersByObject.set(owner.objectId, (ownersByObject.get(owner.objectId) ?? 0) + 1);
  }
  if (
    !Array.isArray(snapshot.objectRegistrations)
    || snapshot.objectRegistrations.length === 0
    || snapshot.objectRegistrations.some(
      (registration) => registration.state !== "verified"
        || !ownersByObject.has(registration.id)
    )
  ) {
    throw new Error("PostgreSQL object ownership is not closed.");
  }
}

function assertPublicOutcome(input, snapshot) {
  if (
    input.public?.knowledgeBaseId !== input.knowledgeBaseId
    || !Array.isArray(input.public?.sourceFiles)
    || INTERNAL_PUBLIC_FIELD_PATTERN.test(JSON.stringify(input.public))
  ) {
    throw new Error("Public outcome is missing, crossed scope, or exposed internal storage data.");
  }
  if (
    !Number.isSafeInteger(input.public.searchResultCount)
    || input.public.searchResultCount < 1
    || !Number.isSafeInteger(input.public.rootIndexByteCount)
    || input.public.rootIndexByteCount < 1
    || !Number.isSafeInteger(input.public.treeItemCount)
    || input.public.treeItemCount < 1
  ) {
    throw new Error("Public read, search, or generated tree outcome is incomplete.");
  }
  const expected = liveSources(snapshot).map((source) =>
    `${source.id}\0${source.logicalPath}`
  ).sort();
  const actual = input.public.sourceFiles.map((source) => {
    if (source.state !== "visible") {
      throw new Error("Public source catalog retained a non-visible source.");
    }
    return `${source.sourceFileId}\0${source.relativePath}`;
  }).sort();
  if (!sameStrings(actual, expected)) {
    throw new Error("Public source catalog does not match PostgreSQL.");
  }
  return digestStrings(expected);
}

function assertS3Handoff(input, snapshot) {
  const registrations = input.postgres.physical.registrations;
  const currentObjects = input.s3?.currentObjects;
  if (!Array.isArray(registrations) || !Array.isArray(currentObjects)) {
    throw new Error("S3 handoff evidence is incomplete.");
  }
  if (input.s3.ownerMarkerCount !== 1 || input.s3.ownerMarkerValid !== true) {
    throw new Error("S3 run-owner marker is missing or invalid.");
  }
  const registeredByKey = new Map();
  for (const registration of registrations) {
    const ownerCount = Number(registration.ownerCount);
    if (
      !registration.storageKey?.startsWith(input.proof.objectScope)
      || registration.state !== "verified"
      || !Number.isSafeInteger(ownerCount)
      || ownerCount < 0
      || (ownerCount === 0 && !isTimestamp(registration.zeroOwnerSince))
    ) {
      throw new Error("PostgreSQL physical object registration is invalid or has no cleanup age.");
    }
    registeredByKey.set(registration.storageKey, registration);
  }
  if (registeredByKey.size !== registrations.length) {
    throw new Error("PostgreSQL physical object registrations contain duplicate storage keys.");
  }
  const targetObjectIds = new Set(
    (snapshot.objectRegistrations ?? []).map((registration) => registration.id)
  );
  const physicalByObjectId = new Map(
    registrations.map((registration) => [registration.objectId, registration])
  );
  if ([...targetObjectIds].some((objectId) => {
    const registration = physicalByObjectId.get(objectId);
    return !registration || Number(registration.targetOwnerCount) < 1;
  })) {
    throw new Error("Run target ownership is missing from the physical object scope.");
  }
  const actualKeys = currentObjects.map((object) => object.storageKey).sort();
  const expectedKeys = [...registeredByKey.keys()].sort();
  if (!sameStrings(actualKeys, expectedKeys)) {
    throw new Error("S3 current object set does not match PostgreSQL ownership.");
  }
  for (const object of currentObjects) {
    const registration = registeredByKey.get(object.storageKey);
    if (
      !registration
      || object.byteCount !== Number(registration.byteCount)
      || object.checksum !== registration.checksum
      || object.contentType !== registration.contentType
      || object.objectFormat !== registration.objectFormat
    ) {
      throw new Error("S3 object metadata does not match PostgreSQL.");
    }
  }
  if ((input.s3.deleteMarkers ?? []).some((marker) =>
    !marker.storageKey?.startsWith(input.proof.objectScope)
    || (marker.isLatest === true && registeredByKey.has(marker.storageKey))
  )) {
    throw new Error("S3 delete marker shadows a registered current object or crossed scope.");
  }
  if ((input.s3.multipartUploads ?? []).length > 0) {
    throw new Error("S3 run-owned scope retained multipart uploads.");
  }
  return {
    objectSetDigest: digestStrings(expectedKeys),
    zeroOwnerObjectCount: registrations.filter(
      (registration) => Number(registration.ownerCount) === 0
    ).length
  };
}

function assertMeilisearchHandoff(input, snapshot) {
  const physical = input.postgres.physical.searchProjections;
  const scopedIndexes = (input.meilisearch?.indexes ?? []).filter(
    (index) => index.uid?.startsWith(input.proof.searchScope)
  );
  if (physical.length !== 1 || scopedIndexes.length !== 1) {
    throw new Error("Expected exactly one scoped Meilisearch index.");
  }
  const projection = physical[0];
  const index = scopedIndexes[0];
  const logicalProjection = snapshot.searchProjections.find(
    (candidate) => candidate.id === projection.publicId
  );
  if (
    projection.role !== "active"
    || projection.state !== "ready"
    || projection.providerIndexUid !== index.uid
    || logicalProjection?.role !== "active"
    || logicalProjection.state !== "ready"
  ) {
    throw new Error("Meilisearch active projection does not match PostgreSQL.");
  }
  if (
    Number(projection.documentCount) !== Number(index.numberOfDocuments)
    || Number(logicalProjection.documentCount) !== Number(index.numberOfDocuments)
  ) {
    throw new Error("Meilisearch document count does not match PostgreSQL.");
  }
  const liveTasks = (input.meilisearch.tasks ?? []).filter(
    (task) => !TERMINAL_SEARCH_TASK_STATES.has(task.status)
  );
  if (liveTasks.length > 0) {
    throw new Error("Meilisearch retained nonterminal tasks for the run-owned scope.");
  }
  return digestStrings([index.uid]);
}

function assertRedisTerminal(redis, coordinationScope) {
  if (!Array.isArray(redis?.keys)) {
    throw new Error("Redis terminal evidence is incomplete.");
  }
  const scopedKeys = redis.keys.filter((entry) =>
    typeof entry.key === "string" && entry.key.startsWith(coordinationScope)
  );
  const ownerKey = `${coordinationScope}_run-owner`;
  const ownerMarkers = scopedKeys.filter((entry) => entry.key === ownerKey);
  if (
    ownerMarkers.length !== 1
    || ownerMarkers[0].type !== "string"
    || ownerMarkers[0].ttlSeconds !== -1
  ) {
    throw new Error("Redis run-owner marker is missing or invalid.");
  }
  const unexpectedPersistent = scopedKeys.filter(
    (entry) => entry.key !== ownerKey
      && (!Number.isSafeInteger(entry.ttlSeconds) || entry.ttlSeconds < 1)
  );
  if (unexpectedPersistent.length > 0) {
    throw new Error("Redis keys must be TTL-bound after terminal convergence.");
  }
  if (scopedKeys.some((entry) => LOCK_KEY_PATTERN.test(entry.key))) {
    throw new Error("Redis lock residue remained after terminal convergence.");
  }
  return {
    keyCount: scopedKeys.length,
    ownerMarkerCount: ownerMarkers.length,
    unexpectedPersistentKeyCount: unexpectedPersistent.length
  };
}

function assertLogHandoff(logs, operations) {
  if (
    !Array.isArray(logs?.files)
    || logs.files.length === 0
    || logs.files.some((file) => !Number.isSafeInteger(file.byteCount) || file.byteCount < 1)
    || !Array.isArray(logs.targetEvents)
  ) {
    throw new Error("Runtime log handoff evidence is incomplete.");
  }
  const operationStates = new Map(
    operations.map((operation) => [operation.id, operation.state])
  );
  const unresolved = logs.targetEvents.filter((event) =>
    event.operationPublicId
    && !TERMINAL_OPERATION_STATES.has(operationStates.get(event.operationPublicId))
  );
  if (unresolved.length > 0) {
    throw new Error("Logged operation has no terminal PostgreSQL outcome.");
  }
  return { unresolvedOperationCount: unresolved.length };
}

function liveSources(snapshot) {
  return (snapshot.sourceFiles ?? []).filter((source) => !source.deletedAt);
}

function sameStrings(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function digestStrings(values) {
  return crypto.createHash("sha256").update(values.join("\n"), "utf8").digest("hex");
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
