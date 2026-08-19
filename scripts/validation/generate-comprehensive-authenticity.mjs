#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildProductionAuthenticitySnapshot,
  buildProductionWiringGraph
} from "./lib/comprehensive-production-authenticity.mjs";

const repositoryRoot = process.cwd();
const graph = buildProductionWiringGraph(repositoryRoot);
const snapshot = buildProductionAuthenticitySnapshot(graph);

if (process.argv.includes("--report")) {
  const reportDirectory = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
  if (!reportDirectory || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(reportDirectory)) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(reportDirectory, "production-authenticity-graph.json"),
    `${JSON.stringify(graph, null, 2)}\n`
  );
}

process.stdout.write(`${JSON.stringify({
  mode: "live",
  report: process.argv.includes("--report"),
  nodes: graph.nodes.length,
  edges: graph.edges.length,
  findings: graph.findings.length,
  snapshot
})}\n`);
