import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FAMILIES = new Set(["content", "entity", "relationship", "community"]);

export async function retryComprehensiveVectorSourceHydration(
  operation,
  options = {}
) {
  if (typeof operation !== "function") {
    throw new Error("Comprehensive vector source hydration operation is invalid");
  }
  const maximumAttempts = options.maximumAttempts ?? 8;
  if (!Number.isSafeInteger(maximumAttempts)
    || maximumAttempts < 1
    || maximumAttempts > 12) {
    throw new Error("Comprehensive vector source hydration attempt limit is invalid");
  }
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = await operation();
    if (!result || typeof result !== "object" || Array.isArray(result)
      || !Number.isSafeInteger(result.status) || result.status < 100) {
      throw new Error("Comprehensive vector source hydration result is invalid");
    }
    if (result.status !== 429 || attempt === maximumAttempts) {
      return { ...result, attempts: attempt };
    }
    await sleep(boundedHydrationRetryDelay(result.retryAfterMs));
  }
  throw new Error("Comprehensive vector source hydration retry is unreachable");
}

export function buildComprehensiveOpenSearchVectorRequest(input) {
  const vector = requireVector(
    input?.vector,
    input?.vector?.length,
    "OpenSearch query vector"
  );
  const threshold = requireFiniteNumber(
    input?.threshold,
    "OpenSearch threshold",
    -1,
    1
  );
  return {
    _source: ["id", "ownerPublicId"],
    size: requirePositiveInteger(input?.requestedK, "OpenSearch requested K"),
    track_total_hits: false,
    query: {
      knn: {
        vector: {
          vector,
          min_score: (threshold + 1) / 2,
          filter: {
            bool: {
              filter: [
                { term: { knowledgeBaseId: requireString(
                  input?.knowledgeBaseId,
                  "OpenSearch knowledge-base ID"
                ) } },
                { term: { semanticGenerationPublicId: requireString(
                  input?.semanticGenerationPublicId,
                  "OpenSearch semantic generation ID"
                ) } },
                { term: { embeddingConfigurationRevisionPublicId: requireString(
                  input?.embeddingConfigurationRevisionPublicId,
                  "OpenSearch embedding configuration revision ID"
                ) } },
                { term: { family: requireFamily(input?.family) } }
              ]
            }
          }
        }
      }
    }
  };
}

export function inspectComprehensiveVectorArtifact(input) {
  const vector = requireVector(input?.vector, input?.dimension, "artifact vector");
  const magnitude = vectorMagnitude(vector);
  const normalization = requireNormalization(input?.normalization);
  const finite = vector.every(Number.isFinite);
  const nonzero = Number.isFinite(magnitude) && magnitude > 0;
  const normalized = normalization === "l2"
    ? Math.abs(magnitude - 1) <= 1e-5
    : true;
  const providerOwnerMatched = requireBoolean(
    input?.providerOwnerMatched,
    "provider owner match"
  );
  const sourceOwnerMatched = requireBoolean(
    input?.sourceOwnerMatched,
    "source owner match"
  );
  const s3OwnerMatched = requireBoolean(input?.s3OwnerMatched, "S3 owner match");
  const reuseDisposition = requireString(input?.reuseDisposition, "reuse disposition");
  const deletionDisposition = requireString(
    input?.deletionDisposition,
    "deletion disposition"
  );
  return Object.freeze({
    artifactPublicId: requireString(input?.artifactPublicId, "artifact public ID"),
    vectorDocumentId: requireString(input?.vectorDocumentId, "vector document ID"),
    ownerPublicId: requireString(input?.ownerPublicId, "owner public ID"),
    sourceFilePublicId: requireString(input?.sourceFilePublicId, "source file public ID"),
    family: requireFamily(input?.family),
    embeddingConfigurationRevisionPublicId: requireString(
      input?.embeddingConfigurationRevisionPublicId,
      "embedding configuration revision public ID"
    ),
    dimension: vector.length,
    normalization,
    vectorChecksumSha256: requireHash(
      input?.vectorChecksumSha256,
      "vector checksum"
    ),
    objectChecksumSha256: requireHash(
      input?.objectChecksumSha256,
      "object checksum"
    ),
    byteCount: requirePositiveInteger(input?.byteCount, "byte count"),
    finite,
    nonzero,
    magnitude: round(magnitude),
    normalized,
    providerOwnerMatched,
    sourceOwnerMatched,
    s3OwnerMatched,
    reuseDisposition,
    deletionDisposition,
    ok: finite && nonzero && normalized && providerOwnerMatched
      && sourceOwnerMatched && s3OwnerMatched
  });
}

export function evaluateComprehensiveVectorQuery(input) {
  const dimension = requirePositiveInteger(input?.dimension, "dimension");
  const queryVector = requireVector(input?.queryVector, dimension, "query vector");
  const threshold = requireFiniteNumber(input?.threshold, "threshold", -1, 1);
  const requestedK = requirePositiveInteger(input?.requestedK, "requested K");
  const documents = requireDocuments(input?.documents, dimension);
  const startedAt = performance.now();
  const exactEligible = documents.map((document) => ({
    ...document,
    score: cosine(queryVector, document.vector)
  })).filter((document) => document.score >= threshold)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, "en"));
  const exact = exactEligible.slice(0, requestedK);
  const exactOracleMs = performance.now() - startedAt;
  const approximate = requireApproximate(input?.approximate, requestedK);
  const expectedById = new Map(documents.map((document) => [document.id, document]));
  const ownerMatches = approximate.hits.every((hit) =>
    expectedById.get(hit.documentId)?.ownerPublicId === hit.ownerPublicId);
  const exactIds = new Set(exact.map((document) => document.id));
  const approximateExactHits = approximate.hits.filter((hit) =>
    exactIds.has(hit.documentId)).length;
  const annRecall = exact.length === 0 ? 1 : approximateExactHits / exact.length;
  const thresholdSetComplete = exactEligible.length <= requestedK;
  const thresholdAgreement = !thresholdSetComplete
    || approximate.hits.every((hit) => exactIds.has(hit.documentId));
  const requiredSourceFilePublicId = requireString(
    input?.requiredSourceFilePublicId,
    "required source file public ID"
  );
  const requiredSourcePresentInExact = exact.some((document) =>
    document.sourceFilePublicId === requiredSourceFilePublicId);
  const requiredSourcePresentInApproximate = approximate.hits.some((hit) =>
    expectedById.get(hit.documentId)?.sourceFilePublicId
      === requiredSourceFilePublicId);
  const sourceHydration = inspectHydration(
    input?.sourceHydration,
    requiredSourceFilePublicId
  );
  const queryVectorFinite = queryVector.every(Number.isFinite);
  const queryVectorNonzero = vectorMagnitude(queryVector) > 0;
  return Object.freeze({
    queryId: requireString(input?.queryId, "query ID"),
    querySha256: requireHash(input?.querySha256, "query checksum"),
    knowledgeBaseId: requireString(input?.knowledgeBaseId, "knowledge-base ID"),
    family: requireFamily(input?.family),
    dimension,
    threshold,
    requestedK,
    eligibleCount: documents.length,
    eligibleOwnerSetSha256: sha256(documents.map((document) => ({
      id: document.id,
      ownerPublicId: document.ownerPublicId,
      sourceFilePublicId: document.sourceFilePublicId
    }))),
    exactEligibleCount: exactEligible.length,
    exactOracleMs: round(exactOracleMs),
    approximateProviderMs: round(approximate.processingTimeMs),
    annRecall: round(annRecall),
    thresholdSetComplete,
    thresholdAgreement,
    exactOwners: exact.map((document) => document.ownerPublicId),
    approximateOwners: approximate.hits.map((hit) => hit.ownerPublicId),
    ownerMatches,
    queryVectorFinite,
    queryVectorNonzero,
    requiredSourceFilePublicId,
    requiredSourcePresentInExact,
    requiredSourcePresentInApproximate,
    sourceHydration,
    ok: ownerMatches && queryVectorFinite && queryVectorNonzero
      && annRecall === 1 && thresholdAgreement && sourceHydration.ok
  });
}

function requireDocuments(value, dimension) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Comprehensive vector oracle documents are invalid");
  }
  const seen = new Set();
  return value.map((document) => {
    const id = requireString(document?.id, "document ID");
    if (seen.has(id)) throw new Error("Comprehensive vector oracle documents are duplicated");
    seen.add(id);
    return {
      id,
      ownerPublicId: requireString(document?.ownerPublicId, "document owner public ID"),
      sourceFilePublicId: requireString(
        document?.sourceFilePublicId,
        "document source file public ID"
      ),
      vector: requireVector(document?.vector, dimension, `document vector ${id}`)
    };
  });
}

function requireApproximate(value, requestedK) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Comprehensive vector oracle approximate result is invalid");
  }
  const hits = Array.isArray(value.hits) ? value.hits : null;
  if (!hits || hits.length > requestedK) {
    throw new Error("Comprehensive vector oracle approximate hits are invalid");
  }
  const seen = new Set();
  return {
    processingTimeMs: requireFiniteNumber(
      value.processingTimeMs,
      "approximate processing time",
      0
    ),
    hits: hits.map((hit) => {
      const documentId = requireString(hit?.documentId, "approximate document ID");
      if (seen.has(documentId)) {
        throw new Error("Comprehensive vector oracle approximate hits are duplicated");
      }
      seen.add(documentId);
      return {
        documentId,
        ownerPublicId: requireString(hit?.ownerPublicId, "approximate owner public ID")
      };
    })
  };
}

function inspectHydration(value, requiredSourceFilePublicId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Comprehensive vector oracle source hydration is invalid");
  }
  const sourceFilePublicId = requireString(
    value.sourceFilePublicId,
    "hydrated source file public ID"
  );
  const status = requirePositiveInteger(value.status, "hydration status");
  const latencyMs = requireFiniteNumber(value.latencyMs, "hydration latency", 0);
  const attempts = value.attempts === undefined
    ? 1
    : requirePositiveInteger(value.attempts, "hydration attempts");
  return Object.freeze({
    status,
    latencyMs: round(latencyMs),
    attempts,
    sourceFilePublicId,
    ok: status === 200 && sourceFilePublicId === requiredSourceFilePublicId
  });
}

function boundedHydrationRetryDelay(value) {
  if (!Number.isFinite(value)) return 1_000;
  return Math.min(60_000, Math.max(100, Math.ceil(value)));
}

function cosine(left, right) {
  const leftMagnitude = vectorMagnitude(left);
  const rightMagnitude = vectorMagnitude(right);
  if (leftMagnitude === 0 || rightMagnitude === 0) return -1;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
  }
  return dot / (leftMagnitude * rightMagnitude);
}

function vectorMagnitude(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function requireVector(value, dimension, field) {
  if (!Array.isArray(value) || !Number.isSafeInteger(dimension)
    || dimension < 1 || value.length !== dimension
    || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`Comprehensive vector oracle ${field} is invalid`);
  }
  return [...value];
}

function requireNormalization(value) {
  if (value !== "none" && value !== "l2") {
    throw new Error("Comprehensive vector oracle normalization is invalid");
  }
  return value;
}

function requireFamily(value) {
  if (!FAMILIES.has(value)) {
    throw new Error("Comprehensive vector oracle family is invalid");
  }
  return value;
}

function requireHash(value, field) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`Comprehensive vector oracle ${field} is invalid`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Comprehensive vector oracle ${field} is invalid`);
  }
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`Comprehensive vector oracle ${field} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Comprehensive vector oracle ${field} is invalid`);
  }
  return value;
}

function requireFiniteNumber(value, field, minimum, maximum = Number.POSITIVE_INFINITY) {
  if (typeof value !== "number" || !Number.isFinite(value)
    || value < minimum || value > maximum) {
    throw new Error(`Comprehensive vector oracle ${field} is invalid`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function round(value) {
  return Number(value.toFixed(6));
}
