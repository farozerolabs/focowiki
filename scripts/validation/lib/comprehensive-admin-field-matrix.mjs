export const ADMIN_FIELD_CASE_KINDS = Object.freeze([
  "omitted",
  "null",
  "minimum",
  "maximum",
  "belowMinimum",
  "aboveMaximum",
  "invalidType",
  "invalidEnum",
  "invalidIdentifier",
  "unknownField",
  "duplicate",
  "staleRevision",
  "conflict",
  "pagination",
  "idempotency"
]);

export function createAdminBoundaryRateLimitLease(rateLimits, minimums) {
  if (
    !rateLimits
    || typeof rateLimits !== "object"
    || !rateLimits.adminLogin
    || !rateLimits.adminApi
    || !Number.isInteger(minimums?.adminLoginMax)
    || minimums.adminLoginMax < 1
    || !Number.isInteger(minimums?.adminApiMax)
    || minimums.adminApiMax < 1
  ) {
    throw new Error("A valid Admin rate-limit snapshot and positive capacities are required.");
  }
  const restore = structuredClone(rateLimits);
  const elevated = structuredClone(rateLimits);
  elevated.adminLogin.max = Math.max(elevated.adminLogin.max, minimums.adminLoginMax);
  elevated.adminApi.max = Math.max(elevated.adminApi.max, minimums.adminApiMax);
  return { elevated, restore };
}

export function createPublicationIntervalLease(publication, intervalSeconds) {
  if (
    !publication
    || typeof publication !== "object"
    || !Number.isInteger(intervalSeconds)
    || intervalSeconds < 1
  ) {
    throw new Error("A valid publication snapshot and positive interval are required.");
  }
  const restore = structuredClone(publication);
  const elevated = structuredClone(publication);
  elevated.mode = "batch";
  elevated.intervalSeconds = Math.min(elevated.intervalSeconds, intervalSeconds);
  return { elevated, restore };
}

export function remainingAdminRateLimitWindowMs(input) {
  const windowMs = input.windowSeconds * 1_000;
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  return Math.max(0, windowMs - elapsedMs + input.cushionMs);
}

export function adminRateLimitDrainWaitMs(input) {
  if (input.requestCount <= input.restoredMaximum) return 0;
  const windowMs = input.windowSeconds * 1_000;
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  return elapsedMs < windowMs
    ? windowMs - elapsedMs + input.cushionMs
    : windowMs + input.cushionMs;
}

export function locateAdminFieldRoute(input) {
  const constants = new Map([...input.source.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`]+)["'`]/gmu
  )].map((match) => [match[1], match[2]]));
  const targetOffset = lineOffset(input.source, input.line);
  const pattern = /app\.(get|post|put|patch|delete)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))/gmu;
  let located = null;
  for (const match of input.source.matchAll(pattern)) {
    if (match.index >= targetOffset) break;
    const rawPath = match[2] ?? match[3] ?? match[4] ?? constants.get(match[5]) ?? null;
    if (!rawPath) continue;
    const routePath = rawPath.replace(/\$\{([A-Za-z_$][\w$]*)\}/gu,
      (_, name) => constants.get(name) ?? `:${name}`);
    located = `${match[1].toUpperCase()}:${routePath}`;
  }
  return located;
}

export function enumerateRequiredAdminFieldCases(field, context = {}) {
  const maintenanceIdempotency = context.routeId
    === "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance";
  if (field.kind === "request-field") {
    if (field.name === "query:limit") {
      return [
        "omitted", "minimum", "maximum", "belowMinimum", "aboveMaximum",
        "invalidType", "duplicate", "pagination"
      ];
    }
    if (field.name === "query:cursor") {
      return ["omitted", "invalidIdentifier", "pagination"];
    }
    if (field.name === "query:query") {
      return [
        "omitted", "minimum", "maximum", "belowMinimum", "aboveMaximum",
        "invalidType", "duplicate"
      ];
    }
    if ([
      "query:entryType",
      "query:includeRelationships",
      "query:state",
      "query:transferState"
    ].includes(field.name)) {
      return ["omitted", "invalidEnum", "duplicate"];
    }
    if (["query:parentPath", "query:path", "query:parentDirectoryId"].includes(field.name)) {
      return ["omitted", "invalidIdentifier", "duplicate"];
    }
    if (field.name.startsWith("param:")) return ["invalidIdentifier"];
    if (field.name === "header:cookie") return ["omitted", "invalidIdentifier"];
    if (field.name === "header:content-type") return ["omitted", "invalidEnum"];
    if (field.name === "header:idempotency-key") {
      return maintenanceIdempotency
        ? ["omitted", "duplicate", "idempotency"]
        : ["omitted", "duplicate", "conflict", "idempotency"];
    }
    if (field.name === "header:if-match") {
      return [
        "omitted", "minimum", "belowMinimum", "invalidType", "staleRevision", "conflict"
      ];
    }
    if (field.name === "header:x-source-relative-path") {
      return ["omitted", "invalidIdentifier"];
    }
    return ["omitted"];
  }

  if (["expectedRevision", "expectedResourceRevision"].includes(field.name)) {
    return [
      "omitted", "null", "minimum", "belowMinimum", "invalidType", "staleRevision", "conflict"
    ];
  }
  if (field.name === "configuration") {
    return ["omitted", "null", "invalidType", "unknownField"];
  }
  if (["name", "username", "password"].includes(field.name)) {
    return ["omitted", "null", "minimum", "belowMinimum", "invalidType", "duplicate"];
  }
  if (field.name === "description") {
    return ["omitted", "null", "minimum", "invalidType"];
  }
  if (field.name === "idempotencyKey") {
    return maintenanceIdempotency
      ? ["omitted", "null", "invalidType", "duplicate", "idempotency"]
      : ["omitted", "null", "invalidType", "duplicate", "conflict", "idempotency"];
  }
  if (field.name === "sourceFileIds") {
    return ["omitted", "null", "minimum", "invalidType", "invalidIdentifier", "duplicate"];
  }
  if (field.name === "relativePath") {
    return [
      "omitted", "null", "minimum", "maximum", "belowMinimum", "aboveMaximum",
      "invalidType", "invalidIdentifier", "conflict"
    ];
  }
  if (["declaredFileCount", "declaredByteCount"].includes(field.name)) {
    return [
      "omitted", "null", "minimum", "maximum", "belowMinimum", "aboveMaximum", "invalidType"
    ];
  }
  if (field.name === "entries") {
    return [
      "omitted", "null", "minimum", "maximum", "aboveMaximum",
      "invalidType", "invalidIdentifier", "duplicate"
    ];
  }
  return ["omitted", "null", "invalidType"];
}

export function adminFieldCaseKindFromEvidenceId(evidenceId, fieldName) {
  const id = evidenceId.toLowerCase();
  if (id.startsWith("identifier:")) return "invalidIdentifier";
  if (id.endsWith(":below-minimum") || id.endsWith(":negative") || id.endsWith(":empty")) {
    return "belowMinimum";
  }
  if (id.endsWith(":above-maximum")) return "aboveMaximum";
  if (id.endsWith(":minimum")) return "minimum";
  if (id.endsWith(":maximum")) return "maximum";
  if (id.endsWith(":omitted") || id.endsWith(":root")) return "omitted";
  if (id.endsWith(":null")) return "null";
  if (id.endsWith(":wrong-type") || id.endsWith(":invalid-control") || id.endsWith(":control")) {
    return "invalidType";
  }
  if (id.endsWith(":unknown-field")) return "unknownField";
  if (id.endsWith(":duplicate")) return "duplicate";
  if (id.includes(":stale")) return "staleRevision";
  if (id.includes(":conflict")) return "conflict";
  if (id.includes(":idempotent") || id.includes(":replay")) return "idempotency";
  if (
    id.endsWith(":missing")
    || id.endsWith(":unsafe")
    || id.endsWith(":lexical-position")
    || id.endsWith(":invalid-identifier")
  ) {
    return "invalidIdentifier";
  }
  if (id.endsWith(":unsupported")) return "invalidEnum";
  if (id.endsWith(":invalid") || id.endsWith(":invalid-as-false")) {
    if (fieldName === "header:if-match") return "belowMinimum";
    if (fieldName === "header:cookie") return "invalidIdentifier";
    if ([
      "query:entryType",
      "query:includeRelationships",
      "query:state",
      "query:transferState"
    ].includes(fieldName)) return "invalidEnum";
    if (fieldName.startsWith("param:") || fieldName.includes("cursor") || fieldName.includes("path")) {
      return "invalidIdentifier";
    }
    return "invalidType";
  }
  return null;
}

export function buildAdminFieldOccurrenceMatrix(input) {
  const fields = input.inventory.filter((item) =>
    item.kind === "request-field" || item.kind === "body-field");
  const evidenceIds = input.evidenceIds instanceof Set
    ? input.evidenceIds
    : new Set(input.evidenceIds ?? []);

  return fields.map((field, index) => {
    const policy = input.occurrencePolicies[field.id];
    if (!policy) throw new Error(`Missing Admin field policy for ${field.id}.`);
    if (typeof policy.routeId !== "string" || policy.routeId.length === 0) {
      throw new Error(`Missing Admin route identity for ${field.id}.`);
    }
    const applicable = policy.applicable ?? {};
    for (const kind of policy.required ?? []) {
      if (!ADMIN_FIELD_CASE_KINDS.includes(kind)) {
        throw new Error(`Unknown required Admin field case ${kind} for ${field.id}.`);
      }
      if (applicable[kind] === undefined) {
        throw new Error(`Missing required Admin field case ${kind} for ${field.id}.`);
      }
    }
    const cases = ADMIN_FIELD_CASE_KINDS.map((kind) => {
      const caseEvidence = applicable[kind];
      if (caseEvidence === undefined) {
        return {
          kind,
          disposition: "not_applicable",
          reason: notApplicableReason(field, kind)
        };
      }
      if (!Array.isArray(caseEvidence) || caseEvidence.length === 0) {
        throw new Error(`Admin field case ${field.id} ${kind} has no live evidence.`);
      }
      for (const evidenceId of caseEvidence) {
        if (!evidenceIds.has(evidenceId)) {
          throw new Error(`Missing live evidence ${evidenceId} for ${field.id} ${kind}.`);
        }
      }
      return {
        kind,
        disposition: "executed",
        evidenceIds: [...caseEvidence]
      };
    });
    return {
      sequence: index + 1,
      sourceId: field.id,
      fieldKind: field.kind,
      fieldName: field.name,
      source: field.source,
      line: field.line,
      routeId: policy.routeId,
      cases
    };
  });
}

export function reconcileAdminFieldOccurrenceMatrix(input) {
  const expected = input.inventory.filter((item) =>
    item.kind === "request-field" || item.kind === "body-field");
  const expectedIds = new Set(expected.map((item) => item.id));
  const rowCounts = new Map();
  const invalidRows = [];
  let observedCaseCount = 0;

  for (const row of input.rows) {
    rowCounts.set(row.sourceId, (rowCounts.get(row.sourceId) ?? 0) + 1);
    const kinds = Array.isArray(row.cases) ? row.cases.map((item) => item.kind) : [];
    observedCaseCount += kinds.length;
    const exactKinds = kinds.length === ADMIN_FIELD_CASE_KINDS.length
      && new Set(kinds).size === ADMIN_FIELD_CASE_KINDS.length
      && ADMIN_FIELD_CASE_KINDS.every((kind) => kinds.includes(kind));
    const validDispositions = Array.isArray(row.cases) && row.cases.every((item) =>
      (item.disposition === "executed"
        && Array.isArray(item.evidenceIds)
        && item.evidenceIds.length > 0)
      || (item.disposition === "not_applicable"
        && typeof item.reason === "string"
        && item.reason.length > 0));
    if (!expectedIds.has(row.sourceId) || !exactKinds || !validDispositions) {
      invalidRows.push(row.sourceId ?? "<missing-source-id>");
    }
  }

  const missingSourceIds = [...expectedIds].filter((id) => !rowCounts.has(id)).sort();
  const duplicateSourceIds = [...rowCounts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const expectedCaseCount = expected.length * ADMIN_FIELD_CASE_KINDS.length;
  const ok = input.rows.length === expected.length
    && observedCaseCount === expectedCaseCount
    && missingSourceIds.length === 0
    && duplicateSourceIds.length === 0
    && invalidRows.length === 0;

  return {
    ok,
    expectedOccurrenceCount: expected.length,
    observedOccurrenceCount: input.rows.length,
    expectedCaseCount,
    observedCaseCount,
    missingSourceIds,
    duplicateSourceIds,
    invalidRows: [...new Set(invalidRows)].sort()
  };
}

function notApplicableReason(field, kind) {
  const location = field.name.split(":", 1)[0];
  switch (kind) {
    case "invalidEnum":
      return "The field is not an enum at this source occurrence.";
    case "invalidIdentifier":
      return location === "param"
        ? "This identifier case must be explicitly declared applicable."
        : "The field is not a resource identifier at this source occurrence.";
    case "unknownField":
      return field.kind === "body-field"
        ? "Unknown-member behavior is owned by the enclosing JSON-object case."
        : "An HTTP parameter has no enclosing object member to mark unknown.";
    case "pagination":
      return "The field does not participate in pagination at this source occurrence.";
    case "idempotency":
      return "The field does not participate in idempotency at this source occurrence.";
    case "staleRevision":
      return "The field is not a revision precondition at this source occurrence.";
    case "conflict":
      return "The field does not independently select a conflict contract at this source occurrence.";
    case "duplicate":
      return "Duplicate-value semantics do not apply independently at this source occurrence.";
    case "null":
      return location === "param" || location === "query" || location === "header"
        ? "HTTP parameters do not carry a distinct JSON null value."
        : "JSON null is not an applicable independent case at this source occurrence.";
    case "minimum":
    case "maximum":
    case "belowMinimum":
    case "aboveMaximum":
      return "The field has no independent numeric, length, or collection bound at this source occurrence.";
    case "invalidType":
      return location === "param" || location === "query" || location === "header"
        ? "HTTP parameter transport is textual and has no distinct wire type."
        : "The field has no independent JSON type case at this source occurrence.";
    case "omitted":
      return "The route grammar always supplies this path parameter at this source occurrence.";
    default:
      return `The ${kind} case is not applicable at this source occurrence.`;
  }
}

function lineOffset(source, line) {
  if (!Number.isInteger(line) || line < 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) return source.length;
    offset = newline + 1;
  }
  return offset;
}
