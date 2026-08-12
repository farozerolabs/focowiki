import { createHash } from "node:crypto";

const REQUIRED_EXTERNAL_CLASSES = Object.freeze([
  "generation",
  "embedding",
  "reranker",
  "s3",
  "opensearch",
  "meilisearch"
]);

export function buildComprehensivePerformanceIdentity(input) {
  requireText(input.runId, "runId");
  requireText(input.application?.commit, "application.commit");
  requireText(input.application?.worktreeFingerprintSha256,
    "application.worktreeFingerprintSha256");
  requireText(input.corpus?.manifestSha256, "corpus.manifestSha256");
  if (input.corpus?.fileCount !== 200
    || input.corpus?.officialFileCount !== 53
    || input.corpus?.legalFileCount !== 147) {
    throw new Error("Performance identity corpus cardinality is invalid.");
  }
  requireText(input.database?.schemaFingerprintSha256,
    "database.schemaFingerprintSha256");
  requireText(input.runtime?.settingsRevisionPublicId,
    "runtime.settingsRevisionPublicId");
  requireText(input.runtime?.settingsChecksumSha256,
    "runtime.settingsChecksumSha256");
  requireText(input.providers?.opensearchVersion, "providers.opensearchVersion");
  requireText(input.providers?.meilisearchVersion, "providers.meilisearchVersion");
  if (!Array.isArray(input.models) || input.models.length < 2) {
    throw new Error("Performance identity requires current model revisions.");
  }
  if (!Array.isArray(input.docker?.roles) || input.docker.roles.length < 4) {
    throw new Error("Performance identity requires every runtime role limit.");
  }
  if (!Number.isSafeInteger(input.host?.logicalCpuCount)
    || input.host.logicalCpuCount < 1
    || !Number.isSafeInteger(input.host?.memoryBytes)
    || input.host.memoryBytes < 1) {
    throw new Error("Performance identity host profile is invalid.");
  }
  if (!Array.isArray(input.measurement?.clientConcurrency)
    || input.measurement.clientConcurrency.join(",") !== "1,20"
    || input.measurement.measuredRepetitions !== 3
    || input.measurement.warmupRepetitions < 1
    || input.measurement.telemetryIntervalMs < 250) {
    throw new Error("Performance identity measurement method is incomplete.");
  }
  for (const name of REQUIRED_EXTERNAL_CLASSES) {
    requireText(input.externalTimeClassifications?.[name],
      `externalTimeClassifications.${name}`);
  }

  const comparable = {
    schemaVersion: 1,
    runId: input.runId,
    application: input.application,
    corpus: input.corpus,
    database: input.database,
    runtime: input.runtime,
    models: input.models,
    providers: input.providers,
    docker: input.docker,
    host: input.host,
    measurement: input.measurement,
    externalTimeClassifications: input.externalTimeClassifications
  };
  rejectSecrets(comparable);
  return Object.freeze({
    ...comparable,
    identitySha256: sha256(stableJson(comparable))
  });
}

export function compareComprehensivePerformanceIdentity(left, right) {
  const fields = [
    "application", "corpus", "database", "runtime", "models", "providers",
    "docker", "host", "measurement", "externalTimeClassifications"
  ];
  const differences = fields.filter((field) =>
    stableJson(left?.[field]) !== stableJson(right?.[field]));
  return {
    comparable: differences.length === 0,
    differences
  };
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rejectSecrets(value) {
  const serialized = JSON.stringify(value);
  if (/(api[_-]?key|password|secret[_-]?reference|encrypted|bearer\s|postgres:\/\/)/iu
    .test(serialized)) {
    throw new Error("Performance identity contains credential-shaped content.");
  }
}

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Performance identity ${name} is required.`);
  }
}
