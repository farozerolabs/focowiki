import {
  MODIFICATION_CASES
} from "./interleaved-lifecycle-matrix.mjs";

export const MAINTENANCE_CASES = Object.freeze([
  "index-maintenance"
]);

const DELETION_CASES = Object.freeze([
  "source-file",
  "source-directory",
  "task",
  "knowledge-base"
]);

export function selectLifecycleCases(index) {
  assertNonNegativeInteger(index, "Lifecycle case index");
  return {
    modificationKind: MODIFICATION_CASES[index % MODIFICATION_CASES.length],
    maintenanceKind: MAINTENANCE_CASES[index % MAINTENANCE_CASES.length],
    deletionKind: DELETION_CASES[index % DELETION_CASES.length]
  };
}

export function buildModificationRequest(input) {
  assertModificationInput(input);
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(
    input.knowledgeBaseId
  )}`;
  const idempotencyKey = [
    input.runId,
    input.scenarioId,
    input.kind,
    input.sequence
  ].join("-");

  if (input.kind === "knowledge-base-metadata-update") {
    return {
      method: "PATCH",
      pathname: base,
      headers: {
        "content-type": "application/json",
        "if-match": quoteRevision(input.knowledgeBaseRevision)
      },
      json: {
        name: `Interleaved ${input.scenarioId} ${input.sequence}`,
        description: `Lifecycle validation update ${input.sequence}`
      }
    };
  }

  if (input.kind === "source-content-replace") {
    return {
      method: "PUT",
      pathname: `${base}/source-files/${encodeURIComponent(
        input.sourceFile.sourceFileId
      )}/content`,
      headers: mutationHeaders(
        input.sourceFile.resourceRevision,
        idempotencyKey,
        "text/markdown; charset=utf-8"
      ),
      rawBody: input.replacementBody
    };
  }

  if (input.kind === "source-file-rename" || input.kind === "source-file-move") {
    const relativePath = input.kind === "source-file-rename"
      ? joinParent(
          input.sourceFile.relativePath,
          `renamed-${input.sequence}.md`
        )
      : `moved/${input.scenarioId}/source-${input.sequence}.md`;
    return {
      method: "PATCH",
      pathname: `${base}/source-files/${encodeURIComponent(
        input.sourceFile.sourceFileId
      )}`,
      headers: mutationHeaders(
        input.sourceFile.resourceRevision,
        idempotencyKey,
        "application/json"
      ),
      json: { relativePath }
    };
  }

  const relativePath = input.kind === "source-directory-rename"
    ? joinParent(
        input.directory.relativePath,
        `renamed-directory-${input.sequence}`
      )
    : `moved/${input.scenarioId}/directory-${input.sequence}`;
  return {
    method: "PATCH",
    pathname: `${base}/source-directories/${encodeURIComponent(
      input.directory.directoryId
    )}`,
    headers: mutationHeaders(
      input.directory.resourceRevision,
      idempotencyKey,
      "application/json"
    ),
    json: { relativePath }
  };
}

export function buildMaintenancePrecondition(input) {
  if (!MAINTENANCE_CASES.includes(input?.kind)) {
    throw new Error(`Unsupported maintenance kind: ${input?.kind}.`);
  }
  const knowledgeBaseId = requiredText(
    input.knowledgeBaseId,
    "Knowledge-base ID"
  );
  if (!input.ownedKnowledgeBaseIds?.has(knowledgeBaseId)) {
    throw new Error(
      `Knowledge base ${knowledgeBaseId} is not owned by this validation run.`
    );
  }

  return {
    kind: input.kind,
    strategy: "request-run-owned-maintenance",
    knowledgeBaseId
  };
}

export function classifyMaintenanceRequestResponse(response) {
  const maintenance = response?.maintenance;
  if (
    maintenance?.requestId == null
    && maintenance?.state === "idle"
    && maintenance?.active === false
  ) {
    return {
      lifecycleState: "failed",
      shouldObserve: false
    };
  }
  return {
    lifecycleState: typeof maintenance?.state === "string"
      ? maintenance.state
      : "failed",
    shouldObserve: true
  };
}

function assertModificationInput(input) {
  if (!MODIFICATION_CASES.includes(input?.kind)) {
    throw new Error(`Unsupported modification kind: ${input?.kind}.`);
  }
  requiredText(input.runId, "Run ID");
  requiredText(input.scenarioId, "Scenario ID");
  requiredText(input.knowledgeBaseId, "Knowledge-base ID");
  assertPositiveInteger(input.sequence, "Modification sequence");
  assertPositiveInteger(
    input.knowledgeBaseRevision,
    "Knowledge-base resource revision"
  );

  if (input.kind.startsWith("source-file")
    || input.kind === "source-content-replace") {
    requiredText(input.sourceFile?.sourceFileId, "Source-file ID");
    requiredText(input.sourceFile?.relativePath, "Source-file relative path");
    assertPositiveInteger(
      input.sourceFile?.resourceRevision,
      "Source-file resource revision"
    );
  }
  if (input.kind.startsWith("source-directory")) {
    requiredText(input.directory?.directoryId, "Source-directory ID");
    requiredText(input.directory?.relativePath, "Source-directory relative path");
    assertPositiveInteger(
      input.directory?.resourceRevision,
      "Source-directory resource revision"
    );
  }
  if (
    input.kind === "source-content-replace"
    && !(input.replacementBody instanceof Uint8Array)
  ) {
    throw new Error("Replacement body must be bytes.");
  }
}

function mutationHeaders(revision, idempotencyKey, contentType) {
  return {
    "content-type": contentType,
    "idempotency-key": idempotencyKey,
    "if-match": quoteRevision(revision)
  };
}

function quoteRevision(value) {
  assertPositiveInteger(value, "Resource revision");
  return `"${value}"`;
}

function joinParent(relativePath, basename) {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? basename : `${relativePath.slice(0, index)}/${basename}`;
}

function requiredText(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}
