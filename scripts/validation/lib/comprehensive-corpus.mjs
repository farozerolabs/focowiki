import crypto from "node:crypto";

const EXPECTATION_FIELDS = Object.freeze([
  "upload",
  "lifecycle",
  "tree",
  "content",
  "generated",
  "graph",
  "search",
  "vector",
  "crudImpact",
  "automatedReview",
  "manualReview",
  "cleanup"
]);

export function buildSanitizedCorpusManifest(input) {
  if (input.official.length !== 53 || input.legacy.length !== 147) {
    throw new Error("Comprehensive corpus must contain exactly 53 official and 147 legacy files");
  }
  const rows = [
    ...sanitizeFamily(input.official, "official", "native-v02"),
    ...sanitizeFamily(input.legacy, "legacy", "legacy-v01")
  ];
  if (rows.length !== 200 || new Set(rows.map((row) => row.pathHash)).size !== 200) {
    throw new Error("Comprehensive corpus manifest is incomplete or colliding");
  }
  return {
    schemaVersion: 1,
    counts: { official: 53, legacy: 147, total: 200 },
    rows
  };
}

export function buildCorpusExpectationLedger(manifest) {
  if (manifest?.counts?.total !== 200 || manifest.rows?.length !== 200) {
    throw new Error("Corpus expectation ledger requires an exact 200-row manifest");
  }
  return {
    schemaVersion: 1,
    rows: manifest.rows.map((row) => ({
      id: `corpus-expectation:${row.alias}`,
      corpusAlias: row.alias,
      expectations: Object.fromEntries(EXPECTATION_FIELDS.map((field) => [field, "pending"]))
    }))
  };
}

export function assertCorpusExpectationLedger(manifest, ledger) {
  if (ledger?.rows?.length !== 200) throw new Error("Corpus expectation ledger is incomplete");
  const expected = new Set(manifest.rows.map((row) => row.alias));
  for (const row of ledger.rows) {
    if (!expected.delete(row.corpusAlias)) throw new Error("Corpus expectation ledger has an unknown or duplicate row");
    if (EXPECTATION_FIELDS.some((field) => !(field in (row.expectations ?? {})))) {
      throw new Error(`Corpus expectation row is incomplete: ${row.corpusAlias}`);
    }
  }
  if (expected.size > 0) throw new Error("Corpus expectation ledger is missing rows");
}

function sanitizeFamily(files, family, compatibility) {
  return files.map((file, index) => {
    if (
      !/^[a-f0-9]{64}$/u.test(file.checksumSha256)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
      || typeof file.relativePath !== "string"
    ) throw new Error(`Invalid ${family} corpus entry`);
    return {
      alias: `${family}-${String(index + 1).padStart(3, "0")}`,
      family,
      compatibility,
      pathHash: hash(file.relativePath.normalize("NFC")),
      checksumSha256: file.checksumSha256,
      sizeBytes: file.sizeBytes,
      format: "markdown",
      frontmatterReadable: file.frontmatterReadable === true,
      bodyReadable: file.bodyReadable === true,
      metadataClassification: file.metadataClassification,
      immutableBeforeChecksum: file.checksumSha256
    };
  });
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
