const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const COMPREHENSIVE_LEDGER_SCHEMAS = Object.freeze({
  inventoryItem: schema(["id", "source", "fingerprint"], { fingerprint: "sha256" }),
  corpusFile: schema(["id", "corpus", "relativePathHash", "bodyHash", "sizeBytes"], {
    relativePathHash: "sha256",
    bodyHash: "sha256"
  }),
  generatedItem: schema(["id", "ownerId", "logicalPathHash", "contentHash"], {
    logicalPathHash: "sha256",
    contentHash: "sha256"
  }),
  query: schema(["id", "mode", "sourceFileId", "queryHash"], { queryHash: "sha256" }),
  vectorOwner: schema(["id", "sourceFileId", "contractRevision", "dimension", "artifactHash"], {
    artifactHash: "sha256"
  }),
  crudCase: schema(["id", "resourceKind", "operation", "expectedDisposition"]),
  securityCase: schema(["id", "surfaceId", "threat", "expectedStatus"]),
  performanceMeasurement: schema(["id", "surfaceId", "profile", "durationMs", "fingerprint"], {
    fingerprint: "sha256"
  }),
  defect: schema(["id", "surfaceId", "status", "reproductionHash"], { reproductionHash: "sha256" }),
  automatedResult: schema(["id", "status", "evidenceHash"], { evidenceHash: "sha256" }),
  manualResult: schema(["id", "status", "evidenceHash"], { evidenceHash: "sha256" }),
  cleanupOwner: schema(["id", "kind", "runId", "evidenceHash"], { evidenceHash: "sha256" })
});

export function assertLedgerRecord(family, record) {
  const definition = COMPREHENSIVE_LEDGER_SCHEMAS[family];
  if (!definition) throw new Error(`Unknown comprehensive ledger family: ${String(family)}`);
  for (const field of definition.required) {
    const value = record?.[field];
    if (value === undefined || value === null || value === "") {
      throw new Error(`${family} record is missing ${field}`);
    }
  }
  for (const [field, format] of Object.entries(definition.formats)) {
    if (format === "sha256" && !SHA256_PATTERN.test(String(record[field]))) {
      throw new Error(`${family} record has invalid ${field}`);
    }
  }
}

function schema(required, formats = {}) {
  return Object.freeze({ owner: "focowiki", version: 1, required, formats });
}
