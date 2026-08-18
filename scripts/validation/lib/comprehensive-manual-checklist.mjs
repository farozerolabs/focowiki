import { createHash } from "node:crypto";

const RUN_ID_PATTERN = /^validation-\d{14}-[a-f0-9]{8}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const AGGREGATE_ITEM_IDS = new Set([
  "aggregate-pass",
  "bulk-pass",
  "category-pass",
  "percentage-only"
]);

export function buildComprehensiveManualChecklist(input) {
  const runId = String(input?.runId ?? "");
  const applicationFingerprint = String(input?.applicationFingerprint ?? "");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Comprehensive manual checklist run ID is invalid");
  }
  if (!HASH_PATTERN.test(applicationFingerprint)) {
    throw new Error("Comprehensive manual checklist application fingerprint is invalid");
  }

  const requiredCategories = uniqueStrings(
    input?.requiredCategories,
    "required category"
  );
  if (requiredCategories.length === 0) {
    throw new Error("Comprehensive manual checklist required categories are empty");
  }
  const collections = Array.isArray(input?.collections) ? input.collections : [];
  const collectionCategories = new Set(collections.map((item) => String(item?.category ?? "")));
  for (const category of requiredCategories) {
    if (!collectionCategories.has(category)) {
      throw new Error(`Comprehensive manual checklist is missing required category: ${category}`);
    }
  }

  const rows = [];
  const rowIds = new Set();
  for (const collection of collections) {
    const category = requiredString(collection?.category, "collection category");
    const source = requiredString(collection?.source, "collection source");
    if (collection?.granularity !== "item") {
      throw new Error(`Comprehensive manual checklist collection is not itemized: ${category}`);
    }
    if (!Array.isArray(collection.items) || collection.items.length === 0) {
      throw new Error(`Comprehensive manual checklist collection is empty: ${category}`);
    }
    for (const item of collection.items) {
      const sourceItemId = requiredString(item?.id, "source item ID");
      if (item?.aggregate === true || AGGREGATE_ITEM_IDS.has(sourceItemId)) {
        throw new Error(`Comprehensive manual checklist contains an aggregate checklist item: ${sourceItemId}`);
      }
      const id = `${category}::${sourceItemId}`;
      if (rowIds.has(id)) {
        throw new Error(`Comprehensive manual checklist contains a duplicate checklist item: ${id}`);
      }
      rowIds.add(id);
      rows.push(Object.freeze({
        id,
        category,
        source,
        sourceItemId,
        sourcePointer: item?.sourcePointer ? String(item.sourcePointer) : null,
        expected: item?.expected ? String(item.expected) : "manual-item-review",
        automatedStatus: normalizeAutomatedStatus(item?.automatedStatus),
        manualStatus: "pending",
        defectId: null,
        evidenceHash: normalizeOptionalHash(item?.evidenceHash)
      }));
    }
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));

  const counts = Object.fromEntries([...new Set(rows.map((row) => row.category))]
    .sort()
    .map((category) => [
      category,
      rows.filter((row) => row.category === category).length
    ]));
  const checklistFingerprintSha256 = sha256(stableStringify(rows));
  const report = Object.freeze({
    schemaVersion: 1,
    kind: "focowiki-comprehensive-manual-checklist",
    runId,
    applicationFingerprint,
    coverageMode: "exhaustive",
    generatedAt: new Date().toISOString(),
    requiredCategories: [...requiredCategories].sort(),
    counts,
    totalItems: rows.length,
    pendingItems: rows.length,
    checklistFingerprintSha256,
    rows: Object.freeze(rows)
  });
  assertComprehensiveManualChecklist(report);
  return report;
}

export function assertComprehensiveManualChecklist(report) {
  if (
    report?.schemaVersion !== 1
    || report.kind !== "focowiki-comprehensive-manual-checklist"
    || !RUN_ID_PATTERN.test(String(report.runId ?? ""))
    || !HASH_PATTERN.test(String(report.applicationFingerprint ?? ""))
    || report.coverageMode !== "exhaustive"
  ) {
    throw new Error("Comprehensive manual checklist header is invalid");
  }
  const requiredCategories = uniqueStrings(report.requiredCategories, "required category");
  const rows = Array.isArray(report.rows) ? report.rows : [];
  if (rows.length === 0 || report.totalItems !== rows.length || report.pendingItems !== rows.length) {
    throw new Error("Comprehensive manual checklist cardinality is invalid");
  }
  const ids = new Set();
  for (const row of rows) {
    if (
      !String(row?.id ?? "")
      || ids.has(row.id)
      || row.id !== `${row.category}::${row.sourceItemId}`
      || AGGREGATE_ITEM_IDS.has(row.sourceItemId)
      || row.manualStatus !== "pending"
    ) {
      throw new Error(`Comprehensive manual checklist row is invalid: ${String(row?.id ?? "unknown")}`);
    }
    ids.add(row.id);
  }
  for (const category of requiredCategories) {
    const categoryCount = rows.filter((row) => row.category === category).length;
    if (categoryCount === 0 || report.counts?.[category] !== categoryCount) {
      throw new Error(`Comprehensive manual checklist category is incomplete: ${category}`);
    }
  }
  if (report.checklistFingerprintSha256 !== sha256(stableStringify(rows))) {
    throw new Error("Comprehensive manual checklist fingerprint is invalid");
  }
  return report;
}

function normalizeAutomatedStatus(value) {
  return ["pass", "fail", "pending"].includes(value) ? value : "pending";
}

function normalizeOptionalHash(value) {
  if (value === undefined || value === null || value === "") return null;
  const hash = String(value);
  if (!HASH_PATTERN.test(hash)) {
    throw new Error("Comprehensive manual checklist evidence hash is invalid");
  }
  return hash;
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new Error(`Comprehensive manual checklist ${label} list is missing`);
  const normalized = values.map((value) => requiredString(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Comprehensive manual checklist ${label} list contains duplicates`);
  }
  return normalized;
}

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Comprehensive manual checklist ${label} is missing`);
  return normalized;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
