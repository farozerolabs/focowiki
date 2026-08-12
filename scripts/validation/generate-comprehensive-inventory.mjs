#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildComprehensiveSourceInventory,
  buildInventoryReviewLedger,
  buildInventorySnapshot
} from "./lib/comprehensive-release-inventory.mjs";

const repositoryRoot = process.cwd();
const outputPath = path.join(
  repositoryRoot,
  "scripts/validation/fixtures/comprehensive-release-inventory.json"
);
const inventory = buildComprehensiveSourceInventory({ repositoryRoot });
const snapshot = buildInventorySnapshot(inventory);

if (process.argv.includes("--write")) {
  fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
} else {
  const expected = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(snapshot)) {
    throw new Error("Comprehensive inventory snapshot drift detected");
  }
}

if (process.argv.includes("--report")) {
  const reportDirectory = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
  if (
    !reportDirectory
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(reportDirectory)
  ) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(reportDirectory, "source-inventory.json"),
    `${JSON.stringify({ schemaVersion: 1, inventory }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(reportDirectory, "inventory-review-ledger.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      rows: buildInventoryReviewLedger(inventory)
    }, null, 2)}\n`
  );
}

process.stdout.write(`${JSON.stringify({
  output: path.relative(repositoryRoot, outputPath),
  counts: snapshot.counts,
  total: Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0),
  mode: process.argv.includes("--write") ? "write" : "check",
  report: process.argv.includes("--report")
})}\n`);
