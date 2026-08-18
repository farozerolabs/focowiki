#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  buildComprehensiveCorpusManualReconciliation
} from "./lib/comprehensive-corpus-manual-reconciliation.mjs";

const reportDirectory = requireReportDirectory();
const manifest = readJson("corpus-manifest.json").rows;
const corpus = readJson("corpus-e2e.json");
const generated = readJson("generated-artifacts-e2e.json");
const search = readJson("search-provider-opensearch-expanded-ownership-fix-current-final.json");
const vector = readJson("vector-oracle-opensearch-post-crud-current-ids-retry-aware.json");
const fileUi = readJson("manual-file-ui-ledger.json").rows;
const sourcePageUi = readJson("manual-source-page-ui-ledger.json").rows;
const crud = await readMutationEvidence("comprehensive-crud-results.ndjson");
const directory = await readMutationEvidence(
  "comprehensive-directory-lifecycle-results-corrected.ndjson"
);

const manifestByAlias = new Map(manifest.map((item) => [item.alias, item]));
const generatedByAlias = new Map(generated.knowledgeBases.flatMap((knowledgeBase) =>
  knowledgeBase.artifacts.filter((item) => item.sourceBacked)
    .map((item) => [item.alias, item])));
const searchByAlias = new Map(search.rows.map((item) => [item.alias, item]));
const fileUiByAlias = new Map(fileUi.map((item) => [item.alias, item]));
const sourcePageUiByAlias = new Map(sourcePageUi.map((item) => [
  sourcePageAlias(item.pathHash, search.rows),
  item
]));
const vectorBySource = groupBy(vector.artifacts, (item) => item.sourceFilePublicId);
const vectorQueriesByAlias = groupBy(vector.queries, (item) => item.queryId.split(":")[0]);

const files = Object.entries(corpus.files).map(([alias, item]) => {
  const manifestItem = manifestByAlias.get(alias);
  const generatedItem = generatedByAlias.get(alias);
  const searchItem = searchByAlias.get(alias);
  const fileUiItem = fileUiByAlias.get(alias);
  const sourcePageUiItem = sourcePageUiByAlias.get(alias);
  const vectorQueries = vectorQueriesByAlias.get(alias) ?? [];
  const vectorSourceIds = [...new Set(vectorQueries.map((query) =>
    query.requiredSourceFilePublicId))];
  const vectorItems = vectorSourceIds.length === 1
    ? vectorBySource.get(vectorSourceIds[0]) ?? []
    : [];
  const crudItem = crud.get(alias);
  const directoryItem = directory.get(alias);
  return {
    alias,
    family: item.family,
    checks: {
      manifest: Boolean(
        manifestItem
        && manifestItem.checksumSha256 === item.expectedChecksumSha256
        && manifestItem.sizeBytes === item.expectedSizeBytes
        && manifestItem.immutableBeforeChecksum === manifestItem.checksumSha256
      ),
      upload: item.transfer?.status === "completed" && item.transfer.attempts >= 1,
      processing: item.finalState === "visible"
        && item.finalStage === "generation_activation"
        && item.sourceChecksumVerified === true,
      tree: generatedItem?.treeVerified === true,
      content: generatedItem?.openApiContentByIdVerified === true
        && generatedItem.openApiContentByPathVerified === true
        && item.generatedContentVerified === true,
      generated: generatedItem?.databaseVerified === true
        && generatedItem.s3Verified === true
        && item.generatedFileAvailable === true,
      graph: searchItem?.queries.some((query) =>
        query.parameters?.mode === "graph"
        && query.status === 200
        && query.found === true
        && query.graphStatus === "available") === true,
      search: searchItem?.ok === true
        && searchItem.queries.every((query) => query.status === 200 && query.scopeMatches === true),
      vector: vectorQueries.length === 4
        && vectorQueries.every((query) => query.ok === true)
        && vectorItems.length > 0
        && vectorItems.every((artifact) => artifact.ok === true),
      originalRead: searchItem?.sourceRead?.matched === true,
      crud: crudItem?.caseCount === 23 && crudItem.caseFailures === 0,
      crossFileImpact: crudItem?.impactCount === 3_200 && crudItem.impactFailures === 0,
      directoryImpact: directoryItem?.impactCount === 162 && directoryItem.impactFailures === 0,
      manualUi: fileUiItem?.passed === true && sourcePageUiItem?.status === "passed"
    },
    evidenceIds: [
      `corpus-manifest:${alias}`,
      `corpus-e2e:${alias}`,
      `generated-artifact:${alias}`,
      `search-ledger:${alias}`,
      `vector-owner:${vectorSourceIds[0] ?? "missing"}`,
      `file-ui:${alias}`,
      `source-page-ui:${sourcePageUiItem?.pathHash ?? "missing"}`,
      `crud-cases:${alias}:${crudItem?.caseFingerprint ?? "missing"}`,
      `crud-impacts:${alias}:${crudItem?.impactFingerprint ?? "missing"}`,
      `directory-impacts:${alias}:${directoryItem?.impactFingerprint ?? "missing"}`
    ]
  };
});

const report = buildComprehensiveCorpusManualReconciliation({
  runId: path.basename(reportDirectory),
  files,
  cleanupCompleted: process.env.FOCOWIKI_COMPREHENSIVE_CLEANUP_COMPLETED === "1"
});
report.sourceLedgers = {
  manifest: "corpus-manifest.json",
  corpus: "corpus-e2e.json",
  generated: "generated-artifacts-e2e.json",
  search: "search-provider-opensearch-expanded-ownership-fix-current-final.json",
  vector: "vector-oracle-opensearch-post-crud-current-ids-retry-aware.json",
  fileUi: "manual-file-ui-ledger.json",
  sourcePageUi: "manual-source-page-ui-ledger.json",
  crud: "comprehensive-crud-results.ndjson",
  directory: "comprehensive-directory-lifecycle-results-corrected.ndjson"
};
const outputPath = path.join(reportDirectory, "comprehensive-corpus-manual-current.json");
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  reviewOk: report.reviewOk,
  cleanupOk: report.cleanupOk,
  summary: report.summary,
  outputPath
})}\n`);

async function readMutationEvidence(fileName) {
  const summaries = new Map();
  const input = fs.createReadStream(path.join(reportDirectory, fileName), { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const alias = row.kind === "case" ? row.alias : row.kind === "impact" ? row.observedAlias : null;
    if (!alias) continue;
    const summary = summaries.get(alias) ?? {
      caseCount: 0,
      caseFailures: 0,
      caseHash: createHash("sha256"),
      impactCount: 0,
      impactFailures: 0,
      impactHash: createHash("sha256")
    };
    if (row.kind === "case") {
      summary.caseCount += 1;
      if (row.ok !== true) summary.caseFailures += 1;
      summary.caseHash.update(line);
    } else {
      summary.impactCount += 1;
      if (row.ok !== true) summary.impactFailures += 1;
      summary.impactHash.update(line);
    }
    summaries.set(alias, summary);
  }
  return new Map([...summaries].map(([alias, summary]) => [alias, {
    caseCount: summary.caseCount,
    caseFailures: summary.caseFailures,
    caseFingerprint: summary.caseHash.digest("hex"),
    impactCount: summary.impactCount,
    impactFailures: summary.impactFailures,
    impactFingerprint: summary.impactHash.digest("hex")
  }]));
}

function sourcePageAlias(pathHash, searchRows) {
  const matches = searchRows.filter((item) => sha256(item.expectedGeneratedPath) === pathHash);
  if (matches.length !== 1) {
    throw new Error(`Manual source-page path identity is ambiguous: ${pathHash}`);
  }
  return matches[0].alias;
}

function groupBy(items, select) {
  const grouped = new Map();
  for (const item of items) {
    const key = select(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(reportDirectory, fileName), "utf8"));
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR?.trim();
  if (!value || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  return path.resolve(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
